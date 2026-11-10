import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { authorityPaths } from "../src/authority-store.js";
import { healthPath } from "../src/watchdog-health.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityClient } from "../src/authority-protocol.js";
import { Dispatcher, type Delivery, type OwnerConnection } from "../src/dispatcher.js";
import type { AuthorityJob } from "../src/authority-types.js";

const at = "2026-11-09T00:00:00.000Z";
const exec = promisify(execFile);
const roots: string[] = [];
const services: Dispatcher[] = [];
const job = (overrides: Partial<AuthorityJob> = {}): AuthorityJob => ({
  id: "job", name: "check", prompt: "inspect", target: "background", executionCwd: "/workspace",
  action: "prompt", schedule: { type: "interval", everyMs: 3600000, every: "1h" }, scope: "global",
  enabled: true, missedWindow: "catch_up_one", tier: "read_only", createdAt: at, updatedAt: at,
  lastRunAt: null, nextRunAt: at, runCount: 0, lastStatus: null, ...overrides,
});
function fixture(options: ConstructorParameters<typeof Dispatcher>[0] = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-dispatch-")); roots.push(home);
  const execute = vi.fn(async () => ({ detail: "fixture executor" }));
  const dispatcher = new Dispatcher({ home, now: () => new Date(at), execute, ...options });
  services.push(dispatcher);
  return { home, dispatcher, execute, client: new AuthorityClient(home, "test") };
}
afterEach(async () => {
  for (const dispatcher of services.splice(0)) await dispatcher.close();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("dispatcher", () => {
  it("publishes health only after a successful scan with the injected clock", () => {
    let now = new Date(at);
    const { dispatcher, home } = fixture({ now: () => now });
    dispatcher.scan();
    const path = healthPath(authorityPaths(home).directory);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ checkedAt: at });
    now = new Date("2026-11-09T00:01:00.000Z");
    dispatcher.scan();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ checkedAt: now.toISOString() });
    vi.spyOn(dispatcher.store, "snapshot").mockImplementation(() => { throw new Error("fixture scan failure"); });
    now = new Date("2026-11-09T00:02:00.000Z");
    expect(() => dispatcher.scan()).toThrow("fixture scan failure");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ checkedAt: "2026-11-09T00:01:00.000Z" });
  });
  it("benchmarks six OS clients/manual/timer triggers against one background slot", async () => {
    const { dispatcher, home, execute, client } = fixture({ tickMs: 20 });
    await dispatcher.start();
    dispatcher.store.addJob(job());
    const outputs = await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./fixtures/dispatcher-client.ts", import.meta.url)), home, "job", at])));
    expect(outputs).toHaveLength(6);
    dispatcher.scan();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const snapshot = dispatcher.store.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.state).toBe("completed");
    expect(snapshot.jobs[0]?.job.runCount).toBe(1);
    const owner = dispatcher.request({ op: "register_owner", sessionId: "unrelated", cwd: "/workspace" }) as OwnerConnection;
    expect(dispatcher.request({ op: "receive", owner, idle: true })).toBeNull();
  }, 15000);

  it("benchmarks OS owner clients across busy, foreign, closed and stale generations", async () => {
    const { dispatcher, home } = fixture(); await dispatcher.start();
    dispatcher.store.addJob(job({ target: "session", ownerSessionId: "owner" }));
    const request = async (value: unknown) => JSON.parse((await exec(process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./fixtures/owner-client.ts", import.meta.url)), home, JSON.stringify(value)])).stdout);
    const owner = (await request({ op: "register_owner", sessionId: "owner", cwd: "/workspace" })).result;
    const foreign = (await request({ op: "register_owner", sessionId: "foreign", cwd: "/workspace" })).result;
    expect((await request({ op: "receive", owner, idle: false })).result).toBeNull();
    expect((await request({ op: "receive", owner: foreign, idle: true })).result).toBeNull();
    const first = (await request({ op: "receive", owner, idle: true })).result as Delivery;
    await request({ op: "unregister_owner", owner });
    const replacement = (await request({ op: "register_owner", sessionId: "owner", cwd: "/workspace" })).result;
    const next = (await request({ op: "receive", owner: replacement, idle: true })).result as Delivery;
    expect((await request({ op: "begin_delivery", owner, fence: first.fence })).error).toMatch(/STALE_CONNECTION|connection/);
    await request({ op: "begin_delivery", owner: replacement, fence: next.fence });
    expect((await request({ op: "finish_delivery", owner, fence: next.fence, outcome: "completed", detail: "stale" })).error).toMatch(/STALE_CONNECTION|connection/);
    await request({ op: "finish_delivery", owner: replacement, fence: next.fence, outcome: "completed", detail: "benchmark receiver accepted" });
    expect(dispatcher.store.snapshot().jobs[0]?.job.runCount).toBe(1);
  }, 15000);

  it("routes only to an exact idle owner and fences reconnect/ack generations", () => {
    const { dispatcher } = fixture();
    dispatcher.store.addJob(job({ target: "session", ownerSessionId: "owner" }));
    const register = (sessionId = "owner", cwd = "/workspace") => dispatcher.request({ op: "register_owner", sessionId, cwd }) as OwnerConnection;
    const wrong = register("foreign"), wrongCwd = register("owner", "/elsewhere"), owner = register();
    for (const other of [wrong, wrongCwd]) expect(dispatcher.request({ op: "receive", owner: other, idle: true })).toBeNull();
    expect(dispatcher.request({ op: "receive", owner, idle: false })).toBeNull();
    expect(dispatcher.store.snapshot().runs).toHaveLength(0);
    const first = dispatcher.request({ op: "receive", owner, idle: true }) as Delivery;
    const replacement = register();
    expect(() => dispatcher.request({ op: "begin_delivery", owner, fence: first.fence })).toThrow(/connection/);
    const next = dispatcher.request({ op: "receive", owner: replacement, idle: true }) as Delivery;
    expect(next.fence.generation).toBe(2);
    dispatcher.request({ op: "begin_delivery", owner: replacement, fence: next.fence });
    expect(() => dispatcher.request({ op: "finish_delivery", owner, fence: first.fence, outcome: "completed", detail: "stale" })).toThrow(/connection/);
    dispatcher.request({ op: "finish_delivery", owner: replacement, fence: next.fence, outcome: "completed", detail: "delivered" });
    expect(dispatcher.store.snapshot().jobs[0]?.job.runCount).toBe(1);
  });

  it("leaves closed/busy owners due, then applies skip/catchup at reconnect", () => {
    const { dispatcher } = fixture({ now: () => new Date("2026-11-10T00:00:00Z") });
    dispatcher.store.addJob(job({ id: "skip", target: "session", ownerSessionId: "owner", missedWindow: "skip" }));
    dispatcher.store.addJob(job({ id: "catch", target: "session", ownerSessionId: "owner" }));
    dispatcher.scan();
    expect(dispatcher.store.snapshot().jobs.every(({ job }) => job.nextRunAt === at)).toBe(true);
    const owner = dispatcher.request({ op: "register_owner", sessionId: "owner", cwd: "/workspace" }) as OwnerConnection;
    expect(dispatcher.request({ op: "receive", owner, idle: false })).toBeNull();
    const delivery = dispatcher.request({ op: "receive", owner, idle: true }) as Delivery;
    expect(delivery.job.id).toBe("catch");
    expect(dispatcher.store.snapshot().jobs[0]?.job.lastStatus).toBe("skipped");
  });

  it.each([{ schedule: { type: "once", delayMs: 30000, delay: "30s" } }, { maxRuns: 1 }] as const)("terminates once/maxRuns after acknowledgment", async (override) => {
    const { dispatcher, execute } = fixture();
    dispatcher.store.addJob(job(override));
    dispatcher.scan();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(dispatcher.store.snapshot().jobs[0]?.job.enabled).toBe(false);
    dispatcher.scan();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves project scope and disabled jobs and rejects low-level bypass", () => {
    const { dispatcher } = fixture();
    dispatcher.store.addJob(job({ enabled: false, scope: "project", projectPath: "/workspace" }));
    dispatcher.scan();
    expect(dispatcher.store.snapshot().runs).toEqual([]);
    expect(() => dispatcher.request({ op: "edit_job", jobId: "job", cwd: "/elsewhere", action: "enable" })).toThrow(/Unknown/);
    expect(() => dispatcher.request({ op: "claim", jobId: "job", slotId: "slot", ownerId: "rogue", at })).toThrow(/Clients cannot claim/);
  });

  it("does not replay an ambiguous started mutating execution after restart", async () => {
    const { dispatcher, home } = fixture();
    dispatcher.store.addJob(job({ tier: "mutate" }));
    const run = dispatcher.store.claim("job", "job:" + at, "crashed-dispatcher", "old", at);
    const { storeId, jobId, slotId, runId, generation, ownerId } = run;
    dispatcher.store.start({ storeId, jobId, slotId, runId, generation, ownerId }, at);
    await dispatcher.close(); services.splice(services.indexOf(dispatcher), 1);
    const execute = vi.fn(async () => ({}));
    const restarted = new Dispatcher({ home, execute, now: () => new Date(at) }); services.push(restarted);
    await restarted.start(); restarted.scan();
    expect(execute).not.toHaveBeenCalled();
    expect(restarted.store.snapshot().runs[0]?.state).toBe("started");
  });

  it("recovers pre-effect offers after restart but cannot reuse old connection tokens", async () => {
    const { dispatcher, home } = fixture();
    dispatcher.store.addJob(job({ target: "session", ownerSessionId: "owner" }));
    const owner = dispatcher.request({ op: "register_owner", sessionId: "owner", cwd: "/workspace" }) as OwnerConnection;
    const delivery = dispatcher.request({ op: "receive", owner, idle: true }) as Delivery;
    await dispatcher.close(); services.splice(services.indexOf(dispatcher), 1);
    const restarted = new Dispatcher({ home, now: () => new Date(at) }); services.push(restarted); await restarted.start();
    expect(() => restarted.request({ op: "begin_delivery", owner, fence: delivery.fence })).toThrow(/connection/);
    const current = restarted.request({ op: "register_owner", sessionId: "owner", cwd: "/workspace" }) as OwnerConnection;
    const next = restarted.request({ op: "receive", owner: current, idle: true }) as Delivery;
    expect(next.fence.generation).toBe(2);
  });

  it("admits only one supervised dispatcher and recovers its socket on restart", async () => {
    const { dispatcher, home } = fixture(); await dispatcher.start();
    const second = new Dispatcher({ home }); services.push(second);
    await expect(second.start()).rejects.toThrow(/locked/);
    const client = new AuthorityClient(home, "test");
    expect(await client.request({ op: "snapshot" })).toHaveProperty("dispatcher");
  });
});
