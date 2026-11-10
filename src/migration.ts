import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuthorityStore, authorityPaths } from "./authority-store.js";
import { AuthorityError, validateJob, type AuthorityJob, type AuthorityState } from "./authority-types.js";
import { defaultPaths } from "./store.js";

export interface MigrationPlan {
  version: 1;
  projects: string[];
  // Explicit reviewed bindings, including existing bindings; never infer an owner.
  bindings: { id: string; target: "session" | "background"; executionCwd: string; ownerSessionId?: string }[];
}
interface Backup { path: string; bytes: string; sha256: string }
export interface MigrationReceipt {
  version: 1; id: string; home: string; planHash: string; storeId: string;
  phase: "prepared" | "fenced" | "imported" | "active" | "rollback-prepared" | "rolled-back";
  attestation: string; sources: Backup[]; history: Backup; jobs: AuthorityJob[];
  rollback?: { stores: { path: string; bytes: string }[]; historyBefore: string; history: string; authority: AuthorityState; attestation: string };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fail(message: string): never { throw new AuthorityError("MIGRATION_BLOCKED", message); }

/** fsync both contents and rename so a completed stage is restartable after process loss. */
export function durableWrite(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export const receiptPath = (home: string) => join(authorityPaths(home).directory, "migration.json");
const save = (receipt: MigrationReceipt) => durableWrite(receiptPath(receipt.home), JSON.stringify(receipt, null, 2) + "\n");
const backup = (path: string, missing = ""): Backup => {
  if (existsSync(path) && !lstatSync(path).isFile()) fail(`Expected regular legacy file: ${path}; preserve and inspect it`);
  const bytes = existsSync(path) ? readFileSync(path, "utf8") : missing;
  return { path, bytes, sha256: hash(bytes) };
};

export function readMigration(home: string): MigrationReceipt {
  const receipt = JSON.parse(readFileSync(receiptPath(home), "utf8")) as MigrationReceipt;
  if (receipt.version !== 1 || receipt.home !== home || !receipt.id || !Array.isArray(receipt.sources)) fail("Unknown migration receipt; preserve it and use a compatible tool");
  for (const source of [...receipt.sources, receipt.history]) if (hash(source.bytes) !== source.sha256) fail("Backup checksum mismatch; do not continue");
  for (const job of receipt.jobs) validateJob(job);
  return receipt;
}

/** Dry-run only: does not use legacy readers that quarantine unknown schemas. */
export function inspectMigration(home: string, plan: MigrationPlan) {
  if (plan.version !== 1 || !Array.isArray(plan.projects) || !Array.isArray(plan.bindings) || !isAbsolute(home) || plan.projects.some((p) => !isAbsolute(p))) fail("Use manifest version 1 and absolute home/projects");
  const paths = defaultPaths(home);
  const names = [paths.globalFile, ...plan.projects.map(paths.projectFile)];
  if (new Set(names).size !== names.length || new Set(plan.bindings.map((b) => b.id)).size !== plan.bindings.length) fail("Duplicate source or binding identity");
  const sources = names.map((path) => backup(path, '{"version":1,"jobs":[]}\n'));
  const jobs: AuthorityJob[] = [];
  for (const source of sources) {
    let data;
    try { data = JSON.parse(source.bytes); } catch { fail(`Invalid JSON preserved at ${source.path}`); }
    if (data.version !== 1 || !Array.isArray(data.jobs) || Object.keys(data).some((key) => !["version", "jobs"].includes(key))) fail(`Unknown legacy schema preserved at ${source.path}`);
    for (const raw of data.jobs) {
      const binding = plan.bindings.find((b) => b.id === raw.id);
      if (!binding) fail(`Explicit reviewed target/workspace/owner binding required for ${raw.id}`);
      for (const key of ["target", "executionCwd", "ownerSessionId"] as const) {
        if (raw[key] !== undefined && raw[key] !== binding[key]) fail(`Binding changes existing ${key} for ${raw.id}; reconcile explicitly before migration`);
      }
      const job = { action: "prompt", prompt: "", missedWindow: "catch_up_one", tier: "read_only", ...raw, ...binding };
      validateJob(job);
      const expected = job.scope === "global" ? paths.globalFile : paths.projectFile(job.projectPath!);
      if (expected !== source.path) fail(`Job ${job.id} scope does not match its source`);
      jobs.push(job);
    }
  }
  if (new Set(jobs.map((j) => j.id)).size !== jobs.length || plan.bindings.length !== jobs.length) fail("Duplicate job IDs or unused bindings; no rows may disappear silently");
  const history = backup(paths.runsFile);
  // Preserve opaque history verbatim: a legacy handoff is not an application receipt.
  for (const line of history.bytes.split("\n").filter(Boolean)) {
    try { JSON.parse(line); } catch { fail("Unreadable legacy history preserved; inspect it before cutover"); }
  }
  return { sources, history, jobs, planHash: hash(JSON.stringify(plan)) };
}

function exclusive<T>(home: string, work: (store: AuthorityStore) => T): T {
  const store = new AuthorityStore(home);
  const singleton = new DatabaseSync(join(authorityPaths(home).directory, "dispatcher.sqlite"));
  try {
    try { singleton.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
    catch { fail("Dispatcher or another migration still owns the service lock. Pause admission, drain/reconcile, and stop only the dispatcher service first"); }
    return work(store);
  } finally { singleton.close(); store.close(); }
}
function noActive(store: AuthorityStore): void {
  const runs = store.snapshot().runs.filter((run) => run.state === "claimed" || run.state === "started");
  if (runs.length) fail(`Reconcile active/ambiguous runs before cutover: ${runs.map((run) => run.runId).join(", ")}`);
}
function marker(path: string, id: string, checkOriginal: () => void): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  if (!lstatSync(path).isDirectory()) fail(`Legacy mutation lock exists: ${path}; reconcile its owner, never assume elapsed time proves death`);
  const file = join(path, "retired");
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") !== id) fail(`Foreign retirement fence: ${path}`);
  } else {
    if (readdirSync(path).length) fail(`Unknown lock directory: ${path}`);
    checkOriginal();
    durableWrite(file, id);
  }
}
function retire(home: string, receipt: MigrationReceipt): void {
  const paths = defaultPaths(home);
  mkdirSync(paths.globalDir, { recursive: true, mode: 0o700 });
  // Historical JobLockManager always mkdirs this parent before acquiring a job.
  if (existsSync(paths.lockDir) && lstatSync(paths.lockDir).isDirectory()) {
    if (readdirSync(paths.lockDir).length) fail("Legacy delivery locks remain; drain/reconcile individual executors and remove only their confirmed obsolete locks");
    rmdirSync(paths.lockDir);
  }
  if (!existsSync(paths.lockDir)) durableWrite(paths.lockDir, receipt.id);
  if (readFileSync(paths.lockDir, "utf8") !== receipt.id) fail("Foreign legacy delivery fence");
  for (const source of receipt.sources) {
    mkdirSync(dirname(source.path), { recursive: true, mode: 0o700 });
    marker(source.path + ".lock", receipt.id, () => {
      const current = backup(source.path, '{"version":1,"jobs":[]}\n');
      if (current.sha256 !== source.sha256) fail(`Legacy store changed after backup: ${source.path}; preserve both versions and reconcile before continuing`);
    });
    const bytes = existsSync(source.path) ? readFileSync(source.path, "utf8") : '{"version":1,"jobs":[]}\n';
    if (hash(bytes) !== source.sha256 && bytes !== '{"version":1,"jobs":[]}\n') fail(`Legacy store changed after backup: ${source.path}; preserve both versions and reconcile before continuing`);
    durableWrite(source.path, '{"version":1,"jobs":[]}\n');
  }
}

export function applyMigration(home: string, plan: MigrationPlan, attestation: string, afterStage?: (phase: string) => void): MigrationReceipt {
  if (!attestation.trim()) fail("Record confirmed legacy drain, executor stoppage and reconciliation of uncertain effects; this command does not stop Pi sessions");
  return exclusive(home, (store) => {
    let receipt: MigrationReceipt;
    if (existsSync(receiptPath(home))) {
      receipt = readMigration(home);
      if (receipt.planHash !== hash(JSON.stringify(plan)) || receipt.storeId !== store.snapshot().storeId) fail("Manifest/store differs from the recorded migration");
      if (receipt.phase.startsWith("rollback") || receipt.phase === "rolled-back") fail("Migration was rolled back; do not reactivate it blindly");
    } else {
      const inspected = inspectMigration(home, plan);
      noActive(store);
      if (store.snapshot().jobs.length) fail("Destination already has jobs; do not merge independent authorities blindly");
      store.pause("migration-preparing");
      receipt = { version: 1, id: randomUUID(), home, storeId: store.snapshot().storeId, phase: "prepared", attestation, ...inspected };
      save(receipt);
      afterStage?.(receipt.phase);
    }
    if (receipt.phase === "imported" && store.maintenance()?.id === receipt.id && store.maintenance()?.phase === "active") {
      receipt.phase = "active"; save(receipt);
    }
    if (receipt.phase === "active") {
      // Verify retirement even on repeat, without resetting current cadence/history.
      for (const source of receipt.sources) if (JSON.parse(readFileSync(source.path, "utf8")).jobs.length) fail("Legacy definitions changed despite execution fencing; preserve and reconcile both versions before rollback");
      return receipt;
    }
    noActive(store);
    if (receipt.phase === "prepared") {
      store.pause(receipt.id);
      retire(home, receipt);
      receipt.phase = "fenced"; save(receipt); afterStage?.(receipt.phase);
    }
    if (receipt.phase === "fenced") {
      store.importMigration(receipt.id, receipt.jobs);
      receipt.phase = "imported"; save(receipt); afterStage?.(receipt.phase);
    }
    if (receipt.phase === "imported") {
      store.activateMigration(receipt.id);
      receipt.phase = "active"; save(receipt); afterStage?.(receipt.phase);
    }
    return receipt;
  });
}

/** Roll back only to the explicit-target legacy v1 format, never ownerless older clients. */
export function rollbackMigration(home: string, attestation: string, afterStage?: (phase: string) => void): MigrationReceipt {
  if (!attestation.trim()) fail("Rollback requires confirmed new executor stoppage/effects reconciliation and a compatible explicit-target legacy build");
  return exclusive(home, (store) => {
    const receipt = readMigration(home);
    if (receipt.storeId !== store.snapshot().storeId) fail("Authority identity changed");
    if (receipt.phase === "active") {
      store.pause(receipt.id, "rollback");
      noActive(store);
      const authority = store.snapshot();
      for (const source of receipt.sources) {
        if (readFileSync(source.path, "utf8") !== '{"version":1,"jobs":[]}\n') fail(`Legacy definitions changed at ${source.path}; preserve and reconcile these edits before rollback`);
      }
      const stores = receipt.sources.map((source) => ({ path: source.path, jobs: [] as AuthorityJob[] }));
      for (const { job } of authority.jobs) {
        if (job.manualRequested) fail(`Pending manual request on ${job.id} is not legacy-compatible; reconcile without dropping it`);
        const path = job.scope === "global" ? defaultPaths(home).globalFile : defaultPaths(home).projectFile(job.projectPath!);
        const destination = stores.find((source) => source.path === path);
        if (!destination) fail(`New scope ${path} has no reviewed rollback destination`);
        const { cancelled, manualRequested: _manual, ...definition } = job;
        destination.jobs.push({ ...definition, enabled: cancelled ? false : definition.enabled });
      }
      const history = authority.runs.map((run) => {
        const job = authority.jobs.find((entry) => entry.job.id === run.jobId)!.job;
        return JSON.stringify({ runId: run.runId, jobId: run.jobId, jobName: job.name, scope: job.scope, projectPath: job.projectPath,
          idempotencyKey: run.slotId, source: "tick", status: run.state === "completed" ? "delivered" : run.state === "failed" ? "error" : "skipped",
          startedAt: run.startedAt ?? run.claimedAt, endedAt: run.endedAt, detail: "Authority execution only; see retained run/application receipt", tier: job.tier, missedWindow: job.missedWindow, action: job.action, authorityRun: run });
      }).join("\n");
      const historyBefore = backup(receipt.history.path).bytes;
      receipt.rollback = { stores: stores.map((s) => ({ path: s.path, bytes: JSON.stringify({ version: 1, jobs: s.jobs }, null, 2) + "\n" })),
        historyBefore, history: historyBefore + (history ? "\n" + history + "\n" : ""), authority, attestation };
      receipt.phase = "rollback-prepared"; save(receipt); afterStage?.(receipt.phase);
    }
    if (receipt.phase === "rollback-prepared") {
      noActive(store);
      if (!receipt.rollback || !["rollback", "rolled-back"].includes(store.maintenance()?.phase ?? "")) fail("Rollback checkpoint/admission fence missing");
      for (const source of receipt.rollback.stores) {
        const current = readFileSync(source.path, "utf8");
        if (current !== '{"version":1,"jobs":[]}\n' && current !== source.bytes) fail(`Legacy definitions changed during rollback at ${source.path}; both versions preserved in place/receipt`);
        durableWrite(source.path, source.bytes);
      }
      const currentHistory = backup(receipt.history.path).bytes;
      if (currentHistory !== receipt.rollback.historyBefore && currentHistory !== receipt.rollback.history) fail("Legacy history changed during rollback; preserve and reconcile both histories before retrying");
      durableWrite(receipt.history.path, receipt.rollback.history);
      // Commit intent before releasing any old-writer fence. Resume must not overwrite later legacy writes.
      store.pause(receipt.id, "rolled-back");
      receipt.phase = "rolled-back"; save(receipt); afterStage?.(receipt.phase);
    }
    if (receipt.phase !== "rolled-back") fail("Only an active migration can roll back");
    for (const source of receipt.sources) {
      const lock = source.path + ".lock";
      const file = join(lock, "retired");
      if (existsSync(file) && readFileSync(file, "utf8") === receipt.id) renameSync(lock, lock + ".retired-" + receipt.id);
    }
    const lockDir = defaultPaths(home).lockDir;
    if (existsSync(lockDir) && lstatSync(lockDir).isFile() && readFileSync(lockDir, "utf8") === receipt.id) unlinkSync(lockDir);
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    return receipt;
  });
}
