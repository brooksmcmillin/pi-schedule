import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityStore, authorityPaths } from "../src/authority-store.js";
import { Dispatcher } from "../src/dispatcher.js";
import { applyMigration, inspectMigration, readMigration, receiptPath, rollbackMigration, type MigrationPlan } from "../src/migration.js";
import { defaultPaths, ScheduleStore } from "../src/store.js";
import { JobLockManager } from "../src/lock.js";
import type { AuthorityJob } from "../src/authority-types.js";

const roots: string[] = [];
const at = "2026-11-10T00:00:00.000Z";
const attestation = "Disposable fixture: legacy and new executors stopped; effects reconciled; explicit-target v1 rollback build checked";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pi-migrate-")); roots.push(home);
  const paths = defaultPaths(home);
  mkdirSync(paths.globalDir);
  const job: AuthorityJob = { id: "preserve-me", name: "preserve", target: "session", ownerSessionId: "exact-owner", executionCwd: home,
    prompt: "no effects", action: "prompt", scope: "global", enabled: true, tier: "suggest", missedWindow: "catch_up_one",
    schedule: { type: "interval", every: "1h", everyMs: 3600000 }, createdAt: at, updatedAt: at, nextRunAt: at,
    lastRunAt: null, lastStatus: null, runCount: 0 };
  writeFileSync(paths.globalFile, JSON.stringify({ version: 1, jobs: [job] }));
  writeFileSync(paths.runsFile, JSON.stringify({ runId: "historical", status: "delivered", detail: "handoff, not application success" }) + "\n");
  const plan: MigrationPlan = { version: 1, projects: [], bindings: [{ id: job.id, target: "session", executionCwd: home, ownerSessionId: "exact-owner" }] };
  return { home, paths, job, plan };
}
function crash(home: string, plan: MigrationPlan, action: string, fault: string) {
  writeFileSync(join(home, "plan.json"), JSON.stringify(plan));
  let status;
  try { execFileSync(process.execPath, ["--import", "tsx", "test/fixtures/migration-fault.ts", home, action, fault], { stdio: "pipe" }); }
  catch (error) { status = (error as { status: number }).status; }
  expect(status, `fault reached: ${fault}`).toBe(73);
}
function snapshot(home: string) { const store = new AuthorityStore(home, true); try { return store.snapshot(); } finally { store.close(); } }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("restartable migration and rollback (disposable, not live cutover proof)", () => {
  it("dry-run preserves unknown schemas/fields and does not create an authority or quarantine", () => {
    const { home, paths, plan } = fixture();
    const original = readFileSync(paths.globalFile, "utf8");
    expect(inspectMigration(home, plan).jobs).toHaveLength(1);
    expect(existsSync(authorityPaths(home).directory)).toBe(false);
    for (const bytes of ['{"version":9,"jobs":[]}', '{"version":1,"jobs":[],"future":true}', "unreadable"]) {
      writeFileSync(paths.globalFile, bytes);
      expect(() => inspectMigration(home, plan)).toThrow();
      expect(readFileSync(paths.globalFile, "utf8")).toBe(bytes);
      expect(readdirSync(paths.globalDir)).toHaveLength(2);
    }
    writeFileSync(paths.globalFile, original);
    const raw = JSON.parse(original); raw.jobs[0].future = true;
    writeFileSync(paths.globalFile, JSON.stringify(raw));
    expect(() => inspectMigration(home, plan)).toThrow(/Invalid authoritative/);
  });

  it("runs the shipped CLI dry-run/apply/rollback in a disposable home without exposing prompts", () => {
    const { home, plan, paths, job } = fixture();
    const manifest = join(home, "plan.json"); writeFileSync(manifest, JSON.stringify(plan));
    const cli = (action: string) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "src/migration-command.ts", action, "--home", home, "--plan", manifest, "--attestation", attestation], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    expect(cli("dry-run").jobs[0].id).toBe(job.id);
    expect(existsSync(authorityPaths(home).directory)).toBe(false);
    expect(cli("apply").phase).toBe("active");
    const result = cli("rollback");
    expect(result.phase).toBe("rolled-back");
    expect(JSON.stringify(result)).not.toContain(job.prompt);
    expect(JSON.parse(readFileSync(paths.globalFile, "utf8")).jobs).toEqual([job]);
  });

  it("never invents an owner or changes a binding", () => {
    const { home, paths, job, plan } = fixture();
    expect(() => inspectMigration(home, { ...plan, bindings: [] })).toThrow(/binding required/);
    expect(() => inspectMigration(home, { ...plan, bindings: [{ ...plan.bindings[0]!, ownerSessionId: "foreign" }] })).toThrow(/changes existing/);
    const { ownerSessionId: _owner, target: _target, executionCwd: _cwd, ...legacy } = job;
    writeFileSync(paths.globalFile, JSON.stringify({ version: 1, jobs: [legacy] }));
    expect(inspectMigration(home, plan).jobs[0]).toEqual(job);
  });

  it.each(["prepared", "fenced", "imported", "active"])("survives process exit after %s, preserving identity, cadence, history and pending work", (phase) => {
    const { home, paths, job, plan } = fixture();
    writeFileSync(join(home, "plan.json"), JSON.stringify(plan));
    const script = `import {applyMigration} from './src/migration.ts'; import {readFileSync} from 'node:fs'; const home=process.argv[1]; applyMigration(home,JSON.parse(readFileSync(home+'/plan.json','utf8')),'fixture drained/reconciled',p=>{if(p===process.argv[2])process.exit(73)});`;
    try { execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, home, phase], { stdio: "pipe" }); }
    catch (error) { expect((error as { status: number }).status).toBe(73); }
    const receipt = applyMigration(home, plan, attestation);
    expect(receipt.phase).toBe("active");
    expect(receipt.jobs).toEqual([job]);
    expect(snapshot(home).jobs.map((entry) => entry.job)).toEqual([job]);
    expect(snapshot(home).runs).toEqual([]);
    expect(JSON.parse(readFileSync(paths.globalFile, "utf8")).jobs).toEqual([]);
    expect(readMigration(home).history.bytes).toContain("historical");
    expect(statSync(receiptPath(home)).mode & 0o777).toBe(0o600);
    const again = applyMigration(home, plan, attestation);
    expect(again.id).toBe(receipt.id);
    expect(snapshot(home).jobs).toHaveLength(1);
  }, 10000);

  it("fences actual legacy mutations and delivery-lock acquisition, not just protocol clients", () => {
    const { home, paths, plan, job } = fixture();
    const old = new ScheduleStore(paths);
    applyMigration(home, plan, attestation);
    const before = snapshot(home);
    expect(() => old.upsert(job)).toThrow(/lock/);
    expect(() => new JobLockManager(paths.lockDir).tryAcquire("preserve-me")).toThrow();
    expect(snapshot(home)).toEqual(before);
    expect(JSON.parse(readFileSync(paths.globalFile, "utf8")).jobs).toEqual([]);
  });

  it("refuses an occupied service lock, any legacy lock, and unconfirmed drain without activating", async () => {
    const { home, paths, plan } = fixture();
    expect(() => applyMigration(home, plan, "")).toThrow(/confirmed legacy drain/);
    const dispatcher = new Dispatcher({ home, tickMs: 60000 }); await dispatcher.start();
    try { expect(() => applyMigration(home, plan, attestation)).toThrow(/service lock/); }
    finally { await dispatcher.close(); }
    mkdirSync(paths.lockDir); writeFileSync(join(paths.lockDir, "old.lock"), "unknown");
    expect(() => applyMigration(home, plan, attestation)).toThrow(/locks remain/);
    expect(readMigration(home).phase).toBe("prepared");
    const store = new AuthorityStore(home); try { expect(store.maintenance()?.phase).toBe("paused"); } finally { store.close(); }
  });

  it("detects changed source after backup instead of silently dropping later work", () => {
    const { home, paths, plan, job } = fixture();
    expect(() => applyMigration(home, plan, attestation, () => { throw new Error("interrupted"); })).toThrow("interrupted");
    writeFileSync(paths.globalFile, JSON.stringify({ version: 1, jobs: [job, { ...job, id: "new" }] }));
    expect(() => applyMigration(home, plan, attestation)).toThrow(/changed after backup/);
    expect(snapshot(home).jobs).toEqual([]);
  });

  it.each(["rollback-prepared", "rolled-back"])("resumes rollback after %s without replaying or losing post-cutover history", (phase) => {
    const { home, paths, plan, job } = fixture(); applyMigration(home, plan, attestation);
    const store = new AuthorityStore(home);
    const run = store.claim(job.id, "slot", "executor", "fixture", at);
    store.start(run, at);
    store.acknowledge(run, "completed", "2026-11-11T00:00:00.000Z", at, "fixture effect checked");
    const advanced = store.snapshot().jobs[0]!.job;
    store.close();
    expect(() => rollbackMigration(home, attestation, (p) => { if (p === phase) throw new Error("interrupted"); })).toThrow("interrupted");
    const receipt = rollbackMigration(home, attestation);
    expect(receipt.phase).toBe("rolled-back");
    const { manualRequested: _manual, ...compatible } = advanced;
    expect(JSON.parse(readFileSync(paths.globalFile, "utf8")).jobs).toEqual([compatible]);
    const history = readFileSync(paths.runsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(history).toHaveLength(2);
    expect(history[1].authorityRun.runId).toBe(run.runId);
    expect(receipt.rollback!.authority.runs[0]!.runId).toBe(run.runId);
    const paused = new AuthorityStore(home);
    try { expect(() => paused.claim(job.id, "new", "new", "new", at)).toThrow(/Admission paused/); } finally { paused.close(); }
    const legacy = new ScheduleStore(paths);
    legacy.setEnabled(job.id, home, false);
    rollbackMigration(home, attestation);
    expect(JSON.parse(readFileSync(paths.globalFile, "utf8")).jobs[0].enabled).toBe(false);
    expect(readFileSync(paths.runsFile, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2);
    expect(() => applyMigration(home, plan, attestation)).toThrow(/rolled back/);
  });

  it("blocks rollback on ambiguous executors", () => {
    const { home, plan, job } = fixture(); applyMigration(home, plan, attestation);
    const store = new AuthorityStore(home);
    const run = store.claim(job.id, "slot", "executor", "fixture", at); store.start(run, at);
    expect(() => rollbackMigration(home, attestation)).toThrow(/active\/ambiguous/);
    store.interrupt(run, "fixture executor stopped/effects reconciled", at);
    // Rollback remains paused, preventing new work even across dispatcher restart.
    expect(() => store.claim(job.id, "slot2", "executor", "fixture", at)).toThrow(/paused/);
    store.close();
    expect(rollbackMigration(home, attestation).phase).toBe("rolled-back");
  });

  it.each(["retire-write", "import-commit", "activate-commit"])("recovers an OS process exit inside %s before its receipt save", (fault) => {
    const { home, plan, job } = fixture(); crash(home, plan, "apply", fault);
    expect(applyMigration(home, plan, attestation).phase).toBe("active");
    expect(snapshot(home).jobs.map(({ job }) => job)).toEqual([job]);
    expect(snapshot(home).runs).toEqual([]);
    expect(readMigration(home).history.bytes).toContain("historical");
  });

  it.each(["restore-write", "restore-history", "rollback-park", "release-mutation", "release-delivery"])("recovers an OS process exit inside rollback %s without losing pending work", (fault) => {
    const { home, plan, paths, job } = fixture(); applyMigration(home, plan, attestation);
    crash(home, plan, "rollback", fault);
    expect(rollbackMigration(home, attestation).phase).toBe("rolled-back");
    expect(JSON.parse(readFileSync(paths.globalFile, "utf8")).jobs).toEqual([job]);
    expect(readFileSync(paths.runsFile, "utf8")).toContain("historical");
    const store = new AuthorityStore(home);
    try { expect(() => store.claim(job.id, "new", "new", "new", at)).toThrow(/paused/); } finally { store.close(); }
    const lock = new JobLockManager(paths.lockDir).tryAcquire(job.id);
    expect(lock).not.toBeNull(); lock?.release();
  });

  it("keeps aged legacy-writer definitions execution-inert and preserves them rather than overwriting on rollback", () => {
    const { home, paths, plan, job } = fixture(); applyMigration(home, plan, attestation);
    const before = snapshot(home);
    const old = new Date(Date.now() - 120000);
    utimesSync(paths.globalFile + ".lock", old, old);
    // The unchanged old writer steals its expired mutation lock in a separate process.
    const script = `import {ScheduleStore,defaultPaths} from './src/store.ts'; const [home,raw]=process.argv.slice(1); new ScheduleStore(defaultPaths(home)).upsert(JSON.parse(raw));`;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, home, JSON.stringify({ ...job, id: "new-legacy-pending" })], { stdio: "pipe" });
    expect(snapshot(home)).toEqual(before);
    expect(() => new JobLockManager(paths.lockDir).tryAcquire("new-legacy-pending")).toThrow();
    const divergent = readFileSync(paths.globalFile, "utf8");
    expect(() => rollbackMigration(home, attestation)).toThrow(/Legacy definitions changed/);
    expect(readFileSync(paths.globalFile, "utf8")).toBe(divergent);
    expect(readMigration(home).jobs).toEqual([job]);
  });

  it("detects an old writer overlapping backup/retirement without losing its new pending definition", () => {
    const { home, paths, plan, job } = fixture();
    const script = `import {ScheduleStore,defaultPaths} from './src/store.ts'; const [home,raw]=process.argv.slice(1); new ScheduleStore(defaultPaths(home)).upsert(JSON.parse(raw));`;
    expect(() => applyMigration(home, plan, attestation, (phase) => {
      if (phase === "prepared") execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, home, JSON.stringify({ ...job, id: "overlapping-pending" })], { stdio: "pipe" });
    })).toThrow(/changed after backup/);
    expect(readFileSync(paths.globalFile, "utf8")).toContain("overlapping-pending");
    expect(snapshot(home).jobs).toEqual([]);
    expect(readMigration(home).sources[0]!.bytes).toContain(job.id);
  });

  it("preserves a pending manual request on refused rollback and can safely abandon the rollback", async () => {
    const { home, plan, job } = fixture(); applyMigration(home, plan, attestation);
    const store = new AuthorityStore(home); store.updateJob(job.id, (j) => { j.manualRequested = true; }); store.close();
    expect(() => rollbackMigration(home, attestation)).toThrow(/Pending manual request/);
    expect(snapshot(home).jobs[0]!.job.manualRequested).toBe(true);
    const dispatcher = new Dispatcher({ home, tickMs: 60000 }); await dispatcher.start();
    try {
      expect(dispatcher.store.maintenance()?.phase).toBe("rollback");
      dispatcher.request({ op: "resume_admission" });
      expect(dispatcher.store.maintenance()?.phase).toBe("active");
      expect(dispatcher.store.snapshot().jobs[0]!.job.manualRequested).toBe(true);
    } finally { await dispatcher.close(); }
  });

  it.each(["prepared", "imported", "rollback-prepared", "rolled-back"])("cannot resume across incomplete or retired migration stage %s", async (phase) => {
    const { home, plan } = fixture();
    if (phase.startsWith("rollback") || phase === "rolled-back") {
      applyMigration(home, plan, attestation);
      expect(() => rollbackMigration(home, attestation, (p) => { if (p === phase) throw new Error("interrupt"); })).toThrow("interrupt");
    } else expect(() => applyMigration(home, plan, attestation, (p) => { if (p === phase) throw new Error("interrupt"); })).toThrow("interrupt");
    const dispatcher = new Dispatcher({ home, tickMs: 60000 }); await dispatcher.start();
    try {
      const before = dispatcher.store.maintenance();
      dispatcher.request({ op: "pause_admission", reason: "another pause must not erase migration identity" });
      expect(dispatcher.store.maintenance()).toEqual(before);
      expect(() => dispatcher.request({ op: "resume_admission" })).toThrow(/before resuming/);
    } finally { await dispatcher.close(); }
  });

  it("preserves definitions and history written by an obsolete client during interrupted rollback", () => {
    const { home, plan, paths } = fixture(); applyMigration(home, plan, attestation);
    expect(() => rollbackMigration(home, attestation, (p) => { if (p === "rollback-prepared") throw new Error("interrupt"); })).toThrow("interrupt");
    const changed = '{"version":1,"jobs":[],"unknownPending":"preserve"}';
    writeFileSync(paths.globalFile, changed);
    expect(() => rollbackMigration(home, attestation)).toThrow(/changed during rollback/);
    expect(readFileSync(paths.globalFile, "utf8")).toBe(changed);
    writeFileSync(paths.globalFile, '{"version":1,"jobs":[]}\n');
    writeFileSync(paths.runsFile, 'new unknown history bytes');
    expect(() => rollbackMigration(home, attestation)).toThrow(/history changed/);
    expect(readFileSync(paths.runsFile, "utf8")).toBe('new unknown history bytes');
  });

  it("preserves explicit project/background, daily/once and disabled job definitions in both directions", () => {
    const { home, plan, job, paths } = fixture();
    const project = join(home, "project"); mkdirSync(join(project, ".pi"), { recursive: true });
    const { ownerSessionId: _owner, ...background } = job;
    const jobs: AuthorityJob[] = [{ ...background, id: "daily-project", target: "background", scope: "project", projectPath: project, executionCwd: project, enabled: false,
      schedule: { type: "daily", hour: 9, minute: 5, at: "09:05" } }, { ...job, id: "once-project", scope: "project", projectPath: project,
      schedule: { type: "once", delayMs: 60000, delay: "1m" }, maxRuns: 1 }];
    writeFileSync(paths.projectFile(project), JSON.stringify({ version: 1, jobs }));
    const expanded: MigrationPlan = { ...plan, projects: [project], bindings: [...plan.bindings, ...jobs.map(({ id, target, executionCwd, ownerSessionId }) => ({ id, target, executionCwd, ...(ownerSessionId ? { ownerSessionId } : {}) }))] };
    applyMigration(home, expanded, attestation);
    expect(snapshot(home).jobs.map(({ job }) => job)).toEqual([job, ...jobs]);
    rollbackMigration(home, attestation);
    expect(JSON.parse(readFileSync(paths.projectFile(project), "utf8")).jobs).toEqual(jobs);
  });

  it("pause survives restart and allows completion/reconciliation but denies new delivery and mutations", async () => {
    const { home, plan, job } = fixture(); applyMigration(home, plan, attestation);
    let dispatcher = new Dispatcher({ home, tickMs: 60000 }); await dispatcher.start();
    dispatcher.request({ op: "pause_admission", reason: "operator-maintenance" });
    expect(() => dispatcher.store.addJob({ ...job, id: "another" })).toThrow(/paused/);
    expect(() => dispatcher.store.updateJob(job.id, (j) => { j.enabled = false; })).toThrow(/paused/);
    await dispatcher.close();
    dispatcher = new Dispatcher({ home, tickMs: 60000 }); await dispatcher.start();
    try {
      const owner = dispatcher.request({ op: "register_owner", sessionId: "exact-owner", cwd: home }) as { sessionId: string; cwd: string; generation: string };
      expect(dispatcher.request({ op: "receive", owner, idle: true })).toBeNull();
      expect(dispatcher.store.snapshot().jobs[0]!.job.nextRunAt).toBe(at);
    } finally { await dispatcher.close(); }
  });
});
