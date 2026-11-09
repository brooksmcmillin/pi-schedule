import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityStore, authorityPaths } from "../src/authority-store.js";
import { type AuthorityJob, type AuthorityRun, type RunFence } from "../src/authority-types.js";
import { ScheduleStore, defaultPaths } from "../src/store.js";

const exec = promisify(execFile);
const roots: string[] = [];
const stores: AuthorityStore[] = [];
const at = "2026-11-09T00:00:00.000Z";
const later = "2026-11-10T00:00:00.000Z";

export function job(overrides: Partial<AuthorityJob> = {}): AuthorityJob {
  return {
    id: "job-test", name: "check", prompt: "inspect", target: "session", ownerSessionId: "session-1",
    executionCwd: "/workspace", action: "prompt", schedule: { type: "interval", everyMs: 3600000, every: "1h" },
    scope: "global", enabled: true, missedWindow: "skip", tier: "suggest", createdAt: at,
    updatedAt: at, lastRunAt: null, nextRunAt: at, runCount: 0, lastStatus: null, ...overrides,
  };
}

export function fence(run: AuthorityRun): RunFence {
  const { storeId, jobId, slotId, runId, generation, ownerId } = run;
  return { storeId, jobId, slotId, runId, generation, ownerId };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pi-authority-"));
  roots.push(home);
  const store = new AuthorityStore(home);
  stores.push(store);
  return { home, store };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function processRead(home: string, operation = "snapshot", owner = "reader") {
  const { stdout } = await exec(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/authority-process.ts", import.meta.url)), home, operation, owner]);
  return JSON.parse(stdout);
}

describe("AuthorityStore", () => {
  it.each([
    { type: "interval", everyMs: 3600000, every: "1h" },
    { type: "daily", hour: 9, minute: 30, at: "09:30" },
    { type: "once", delayMs: 30000, delay: "30s" },
  ] as const)("preserves complete definitions for $type and shell fields", (schedule) => {
    const { store } = fixture();
    const definition = job({ schedule, action: "shell", command: "true", tier: "mutate", timeoutMs: 10000,
      scope: "project", projectPath: "/workspace", wakeOn: "failure", maxRuns: 4,
      successPrompt: "done", failurePrompt: "failed", terminated: null, lastError: "previous",
      lastIdempotencyKey: "previous-slot", lastShell: { ok: true, command: "true", cwd: "/workspace", timeoutMs: 10000, code: 0, killed: false, stdout: "", stderr: "" } });
    store.addJob(definition);
    expect(store.snapshot().jobs[0]?.job).toEqual(definition);
    expect(() => store.addJob(definition)).toThrow(/already exists/);
  });

  it("rejects ownerless/relative/unsupported jobs without overwriting valid state", () => {
    const { store } = fixture();
    store.addJob(job());
    const before = store.snapshot();
    for (const invalid of [job({ ownerSessionId: undefined }), job({ executionCwd: "relative" }), job({ schedule: { type: "interval", everyMs: 0, every: "0s" } }), job({ target: "background" })]) {
      expect(() => store.addJob({ ...invalid, id: "invalid" })).toThrow();
      expect(store.snapshot()).toEqual(before);
    }
    store.addJob(job({ id: "background", target: "background", ownerSessionId: undefined }));
  });

  it("atomically admits one owner across concurrent OS processes", async () => {
    const { home, store } = fixture();
    store.addJob(job());
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => processRead(home, "claim", `owner-${i}`)));
    expect(results.filter((result) => result.runId)).toHaveLength(1);
    expect(results.filter((result) => result.code === "CLAIM_BUSY")).toHaveLength(5);
    expect(store.snapshot().runs).toHaveLength(1);
    expect(store.snapshot().runs[0]?.generation).toBe(1);
  }, 15000);

  it("fences stale transitions and due-time acknowledgments after explicit reconciliation", () => {
    const { store } = fixture();
    store.addJob(job());
    const old = fence(store.claim("job-test", "slot-test", "dispatcher-a", "build-a", at));
    store.start(old, at);
    // Even a far-future request cannot steal a potentially live execution.
    expect(() => store.claim("job-test", "other-slot", "dispatcher-b", "build-b", "2099-01-01T00:00:00Z")).toThrow(/active executor/);
    store.interrupt(old, "Fixture executor stopped; no external effects", at);
    const current = fence(store.claim("job-test", "slot-test", "dispatcher-b", "build-b", at));
    expect(current.generation).toBe(2);
    expect(current.runId).not.toBe(old.runId);
    store.start(current, at);
    const before = store.snapshot();
    expect(() => store.start(old, at)).toThrow(/generation/);
    expect(() => store.interrupt(old, "stale", at)).toThrow(/generation/);
    expect(() => store.acknowledge(old, "completed", later, at)).toThrow(/generation/);
    for (const invalid of [{ ...current, storeId: "other" }, { ...current, ownerId: "other" }, { ...current, slotId: "other" }, { ...current, runId: old.runId }]) {
      expect(() => store.acknowledge(invalid, "completed", later, at)).toThrow(/generation/);
    }
    expect(store.snapshot()).toEqual(before);
    store.acknowledge(current, "completed", later, at);
    expect(store.snapshot().jobs[0]?.job.nextRunAt).toBe(later);
    expect(store.snapshot().jobs[0]?.job.runCount).toBe(1);
    expect(() => store.acknowledge(current, "completed", later, at)).toThrow(/Only a started/);
    expect(() => store.claim("job-test", "slot-test", "dispatcher-b", "build-b", at)).toThrow(/terminal attempt/);
  });

  it.each([{ schedule: { type: "once", delayMs: 30000, delay: "30s" } }, { maxRuns: 1 }] as const)("preserves once/maxRuns termination", (overrides) => {
    const { store } = fixture();
    store.addJob(job(overrides));
    const run = fence(store.claim("job-test", "slot-test", "owner", "build", at));
    expect(() => store.acknowledge(run, "completed", later, at)).toThrow(/Only a started/);
    store.start(run, at);
    store.acknowledge(run, "failed", later, at);
    expect(store.snapshot().jobs[0]?.job.enabled).toBe(false);
    expect(() => store.claim("job-test", "next", "owner", "build", later)).toThrow(/disabled/);
  });

  it("isolates real legacy-store reads/writes and survives a fresh process restart", async () => {
    const { home, store } = fixture();
    store.addJob(job());
    const run = store.claim("job-test", "slot-test", "owner", "build", at);
    const before = store.snapshot();
    const legacy = new ScheduleStore(defaultPaths(home));
    expect(legacy.listForCwd(join(home, "project"))).toEqual([]);
    const oldJob = legacy.create({ name: "legacy", prompt: "legacy", scope: "global", schedule: { type: "interval", everyMs: 1000, every: "1s" } });
    legacy.markAttempt(oldJob, new Date(at), "ok");
    legacy.remove(oldJob.id, home);
    expect(store.snapshot()).toEqual(before);
    stores.splice(stores.indexOf(store), 1);
    store.close();
    expect(await processRead(home)).toEqual(before);
    expect((await processRead(home)).runs[0].runId).toBe(run.runId);
    expect(statSync(authorityPaths(home).directory).mode & 0o777).toBe(0o700);
    expect(statSync(authorityPaths(home).database).mode & 0o777).toBe(0o600);
  });

  it.each(["duplicate-job", "duplicate-run", "active-generation"])("rejects persisted %s corruption without changing bytes", (kind) => {
    const { home, store } = fixture();
    store.addJob(job());
    store.claim("job-test", "slot-test", "owner", "build", at);
    const state = store.snapshot();
    if (kind === "duplicate-job") state.jobs.push(structuredClone(state.jobs[0]!));
    else if (kind === "duplicate-run") state.runs.push(structuredClone(state.runs[0]!));
    else state.jobs[0]!.generation++;
    const path = authorityPaths(home).database;
    const db = new DatabaseSync(path);
    db.prepare("UPDATE authority SET document=?").run(JSON.stringify(state));
    db.close();
    const bytes = readFileSync(path);
    expect(() => new AuthorityStore(home)).toThrow(/Duplicate|stale active/);
    expect(() => store.snapshot()).toThrow(/Duplicate|stale active/);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it.each(["database", "document", "corrupt"])("rejects $type schema problems non-destructively", (kind) => {
    const { home, store } = fixture();
    store.addJob(job());
    const path = authorityPaths(home).database;
    const db = new DatabaseSync(path);
    if (kind === "database") db.exec("PRAGMA user_version=99");
    else if (kind === "corrupt") db.prepare("UPDATE authority SET document=?").run("broken JSON");
    else {
      const state = store.snapshot();
      state.schemaVersion = 99;
      db.prepare("UPDATE authority SET document=?").run(JSON.stringify(state));
    }
    db.close();
    const bytes = readFileSync(path);
    expect(() => new AuthorityStore(home)).toThrow(/compatible backup/);
    expect(readFileSync(path)).toEqual(bytes);
  });
});
