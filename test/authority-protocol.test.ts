import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityClient, listenAuthority, MAX_AUTHORITY_FRAME_BYTES } from "../src/authority-protocol.js";
import { AuthorityStore, authorityPaths } from "../src/authority-store.js";
import { type AuthorityJob, type AuthorityRun, type RunFence } from "../src/authority-types.js";

const cleanups: (() => void | Promise<void>)[] = [];
const at = "2026-11-09T00:00:00.000Z";
function job(): AuthorityJob {
  return { id: "job-protocol", name: "canary", prompt: "inspect", target: "session", ownerSessionId: "owner-session",
    executionCwd: "/workspace", action: "notify", schedule: { type: "daily", hour: 9, minute: 15, at: "09:15" },
    scope: "project", projectPath: "/workspace", enabled: true, missedWindow: "catch_up_one", tier: "read_only",
    maxRuns: 3, createdAt: at, updatedAt: at, lastRunAt: null, nextRunAt: at, runCount: 0, lastStatus: null };
}
function fence(run: AuthorityRun): RunFence {
  const { storeId, jobId, slotId, runId, generation, ownerId } = run;
  return { storeId, jobId, slotId, runId, generation, ownerId };
}
async function fixture(listen = true) {
  const home = mkdtempSync(join(tmpdir(), "pi-protocol-"));
  const store = new AuthorityStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  if (listen) {
    const server = await listenAuthority(store, home);
    cleanups.push(() => server.close());
  }
  return { home, store, client: new AuthorityClient(home, "test-build") };
}
function raw(home: string, input: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(authorityPaths(home).socket);
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("fixture timeout")); });
    socket.on("connect", () => socket.end(input));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("error", reject);
    socket.on("end", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("private authority protocol", () => {
  it("admits a compatible client and preserves complete job/run identities through acknowledgments", async () => {
    const { home, store, client } = await fixture();
    const definition = job();
    expect(await client.request({ op: "add_job", job: definition })).toEqual(definition);
    expect(await client.request({ op: "snapshot" })).toEqual(store.snapshot());
    const run = await client.request({ op: "claim", jobId: definition.id, slotId: "slot-1", ownerId: "dispatcher-1", at }) as AuthorityRun;
    expect(run).toMatchObject({ jobId: definition.id, slotId: "slot-1", ownerId: "dispatcher-1", generation: 1, protocolVersion: 1, buildId: "test-build" });
    expect(run.runId).toBeTruthy();
    expect(run.storeId).toBe(store.snapshot().storeId);
    await client.request({ op: "start", fence: fence(run), at });
    await client.request({ op: "interrupt", fence: fence(run), detail: "Stopped fixture executor; no effects", at });
    const replacement = await client.request({ op: "claim", jobId: definition.id, slotId: "slot-1", ownerId: "dispatcher-2", at }) as AuthorityRun;
    await client.request({ op: "start", fence: fence(replacement), at });
    const before = store.snapshot();
    await expect(client.request({ op: "acknowledge", fence: fence(run), outcome: "completed", nextRunAt: at, at })).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(store.snapshot()).toEqual(before);
    await client.request({ op: "acknowledge", fence: fence(replacement), outcome: "completed", nextRunAt: "2026-11-10T09:15:00Z", at });
    expect(store.snapshot().jobs[0]?.job.runCount).toBe(1);
    expect(statSync(authorityPaths(home).socket).mode & 0o777).toBe(0o600);
  });

  it.each([
    { protocolVersion: 0, schemaVersion: 1 }, { protocolVersion: 2, schemaVersion: 1 },
    { protocolVersion: 1, schemaVersion: 2 }, { schemaVersion: 1 },
  ])("rejects incompatible client $protocolVersion/$schemaVersion before mutation", async (versions) => {
    const { home, store } = await fixture();
    store.addJob(job());
    const before = store.snapshot();
    const response = await raw(home, JSON.stringify({ ...versions, requestId: "old-client", buildId: "old", request: { op: "claim", jobId: job().id, slotId: "slot", ownerId: "old", at } }) + "\n");
    expect(response).toMatchObject({ ok: false, error: { code: "VERSION_MISMATCH" } });
    expect(response.error.message).toMatch(/Upgrade\/reload/);
    expect(store.snapshot()).toEqual(before);
  });

  it("rejects malformed frames/jobs/operations without changing valid state", async () => {
    const { home, store } = await fixture();
    const before = store.snapshot();
    for (const request of [{ op: "add_job", job: { ...job(), target: undefined } }, { op: "steal" }, { op: "start", fence: {} }]) {
      const response = await raw(home, JSON.stringify({ protocolVersion: 1, schemaVersion: 1, requestId: "bad", buildId: "fixture", request }) + "\n");
      expect(response.error.code).toBe("INVALID_REQUEST");
      expect(store.snapshot()).toEqual(before);
    }
    expect((await raw(home, "not-json\n")).ok).toBe(false);
    expect((await raw(home, "x".repeat(MAX_AUTHORITY_FRAME_BYTES + 1) + "\n")).error.code).toBe("FRAME_TOO_LARGE");
    expect(store.snapshot()).toEqual(before);
  });

  it("accepts a valid frame fragmented across socket writes", async () => {
    const { home, store } = await fixture();
    const frame = JSON.stringify({ requestId: "fragmented", protocolVersion: 1, schemaVersion: 1,
      buildId: "fixture", request: { op: "add_job", job: job() } }) + "\n";
    const response = await new Promise<any>((resolve, reject) => {
      const socket = createConnection(authorityPaths(home).socket);
      let output = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("data", (chunk) => { output += chunk; });
      socket.on("end", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
      socket.on("connect", () => {
        socket.write(frame.slice(0, 40));
        setTimeout(() => socket.end(frame.slice(40)), 10);
      });
    });
    expect(response).toMatchObject({ requestId: "fragmented", ok: true, result: job() });
    expect(store.snapshot().jobs).toHaveLength(1);
  });

  it("returns an explicit oversized-snapshot error without emptying persisted data", async () => {
    const { store, client } = await fixture();
    for (let i = 0; i < 2; i++) await client.request({ op: "add_job", job: { ...job(), id: `large-${i}`, prompt: "x".repeat(600000) } });
    const before = store.snapshot();
    await expect(client.request({ op: "snapshot" })).rejects.toMatchObject({ code: "FRAME_TOO_LARGE" });
    expect(store.snapshot()).toEqual(before);
  });

  it("times out incomplete requests and stalled responses without legacy fallback", async () => {
    const partial = await fixture();
    const stalled = await fixture(false);
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("data", () => { /* Deliberately never return a response. */ });
      cleanups.push(() => { socket.destroy(); });
    });
    await new Promise<void>((resolve) => server.listen(authorityPaths(stalled.home).socket, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const before = partial.store.snapshot();
    const startedAt = Date.now();
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const socket = createConnection(authorityPaths(partial.home).socket);
        socket.on("error", reject);
        socket.on("connect", () => socket.write('{"protocolVersion":1'));
        socket.on("close", () => resolve());
      }),
      expect(stalled.client.request({ op: "snapshot" })).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" }),
    ]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4500);
    expect(partial.store.snapshot()).toEqual(before);
  }, 8000);

  it("does not take over another listener or fall back when dispatcher is absent", async () => {
    const { home, store, client } = await fixture();
    await expect(listenAuthority(store, home)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await client.request({ op: "snapshot" })).toEqual(store.snapshot());
    const absent = await fixture(false);
    await expect(absent.client.request({ op: "snapshot" })).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE", message: expect.stringMatching(/Start\/check.*No legacy fallback/) });
  });

  it.each(["wrong-request", "wrong-version", "malformed", "empty"])("rejects $type server responses", async (kind) => {
    const { home, client } = await fixture(false);
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString());
        if (kind === "empty") { socket.end(); return; }
        const response = { requestId: kind === "wrong-request" ? "other" : request.requestId,
          protocolVersion: kind === "wrong-version" ? 99 : 1, schemaVersion: 1, ok: true, result: {} };
        socket.end(kind === "malformed" ? "bad\n" : JSON.stringify(response) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(authorityPaths(home).socket, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await expect(client.request({ op: "snapshot" })).rejects.toMatchObject({ code: kind === "empty" ? "AUTHORITY_UNAVAILABLE" : "INVALID_RESPONSE" });
  });
});
