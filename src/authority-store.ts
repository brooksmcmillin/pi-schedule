import { randomUUID } from "node:crypto";
import { applicationSucceeded, boundReceipt, type ExecutionResult } from "./outcome.js";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AUTHORITY_PROTOCOL_VERSION, AUTHORITY_SCHEMA_VERSION, AuthorityError,
  requireText, requireTimestamp, validateJob, validateState,
  type AuthorityJob, type AuthorityRun, type AuthorityState, type RunFence,
} from "./authority-types.js";

/** Never shares any file with ScheduleStore, even for project-scoped jobs. */
export function authorityPaths(home: string = homedir()) {
  const directory = join(home, ".pi-schedule-authority", "v1");
  return { directory, database: join(directory, "authority.sqlite"), socket: join(directory, "control.sock") };
}

function active(run: AuthorityRun): boolean {
  return run.state === "claimed" || run.state === "started";
}

export class AuthorityStore {
  private readonly db: DatabaseSync;

  constructor(home: string = homedir(), readOnly = false) {
    const paths = authorityPaths(home);
    if (readOnly) {
      this.db = new DatabaseSync(paths.database, { readOnly: true });
      try { this.read(); } catch (error) { this.db.close(); throw error; }
      return;
    }
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    chmodSync(paths.directory, 0o700);
    // The private directory protects database/journal creation under permissive umasks.
    this.db = new DatabaseSync(paths.database);
    chmodSync(paths.database, 0o600);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (version === 0 && tables.length === 0) {
        this.db.exec("CREATE TABLE authority (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)");
        this.db.prepare("INSERT INTO authority VALUES (1, ?)").run(JSON.stringify({
          schemaVersion: AUTHORITY_SCHEMA_VERSION, storeId: randomUUID(), jobs: [], runs: [],
        }));
        this.db.exec(`PRAGMA user_version=${AUTHORITY_SCHEMA_VERSION}`);
      } else if (version !== AUTHORITY_SCHEMA_VERSION) {
        throw new AuthorityError("SCHEMA_MISMATCH", `Unsupported authority database version ${String(version)}. Upgrade pi-schedule or restore a compatible backup; no data was changed.`);
      }
      this.read();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* BEGIN may have failed. */ }
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  snapshot(): AuthorityState { return this.read(); }

  maintenance(): { id: string; phase: string } | undefined {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE name='maintenance'").get()) return;
    const row = this.db.prepare("SELECT document FROM maintenance WHERE id=1").get();
    return row ? JSON.parse(String(row.document)) : undefined;
  }

  /** Durable admission pause survives dispatcher restart; completion/reconciliation stays available. */
  pause(id: string, phase = "paused"): void {
    requireText(id, "maintenance identity");
    this.db.exec("CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)");
    this.db.prepare("INSERT OR REPLACE INTO maintenance VALUES (1, ?)").run(JSON.stringify({ id, phase }));
  }

  importMigration(id: string, jobs: AuthorityJob[]): void {
    const maintenance = this.maintenance();
    if (maintenance?.id === id && maintenance.phase === "imported") return;
    if (maintenance?.id !== id || maintenance.phase !== "paused") throw new AuthorityError("MAINTENANCE_REQUIRED", "Pause this migration before importing");
    this.mutate((state) => {
      if (state.jobs.length || state.runs.length) throw new AuthorityError("DESTINATION_NOT_EMPTY", "Initial migration requires an empty authority; preserve and inspect existing state");
      state.jobs = jobs.map((job) => ({ job: structuredClone(job), generation: 0 }));
      this.pause(id, "imported");
    });
  }

  activateMigration(id: string): void {
    const maintenance = this.maintenance();
    if (maintenance?.id !== id || !["imported", "active"].includes(maintenance.phase)) throw new AuthorityError("MAINTENANCE_REQUIRED", "Only an imported migration may activate");
    this.pause(id, "active");
  }

  private requireAdmission(): void {
    const maintenance = this.maintenance();
    if (maintenance && maintenance.phase !== "active") throw new AuthorityError("MAINTENANCE", `Admission paused (${maintenance.phase}); finish migration or reconcile runs before activation`);
  }

  /** Insert definitions only. Existing identities cannot be overwritten around a claim fence. */
  addJob(job: AuthorityJob): AuthorityJob {
    validateJob(job);
    return this.mutate((state) => {
      this.requireAdmission();
      if (state.jobs.some((entry) => entry.job.id === job.id)) throw new AuthorityError("JOB_EXISTS", `Job ${job.id} already exists`);
      state.jobs.push({ job: structuredClone(job), generation: 0 });
      return job;
    });
  }

  /** Dispatcher-only policy edits; never replace a definition around an active executor. */
  updateJob(jobId: string, update: (job: AuthorityJob) => void): AuthorityJob {
    return this.mutate((state) => {
      this.requireAdmission();
      const entry = state.jobs.find((entry) => entry.job.id === jobId);
      if (!entry || entry.job.cancelled) throw new AuthorityError("JOB_NOT_FOUND", `Unknown job ${jobId}`);
      if (state.runs.some((run) => run.jobId === jobId && active(run))) throw new AuthorityError("CLAIM_BUSY", "Job has an active or ambiguous executor; inspect history before editing");
      update(entry.job);
      validateJob(entry.job);
      return entry.job;
    });
  }

  claim(jobId: string, slotId: string, ownerId: string, buildId: string, at: string, forced = false): AuthorityRun {
    for (const [label, value] of Object.entries({ jobId, slotId, ownerId, buildId })) requireText(value, label);
    requireTimestamp(at);
    return this.mutate((state) => {
      this.requireAdmission();
      const entry = state.jobs.find((entry) => entry.job.id === jobId);
      if (!entry) throw new AuthorityError("JOB_NOT_FOUND", `Unknown job ${jobId}`);
      if ((!entry.job.enabled && !forced) || entry.job.terminated || entry.job.cancelled) throw new AuthorityError("JOB_DISABLED", `Job ${jobId} is disabled or terminated`);
      if (state.runs.some((run) => run.jobId === jobId && active(run))) throw new AuthorityError("CLAIM_BUSY", "Job still has an active executor. Reconcile it; elapsed time alone is not proof of death.");
      if (state.runs.some((run) => run.jobId === jobId && run.slotId === slotId && run.state !== "interrupted")) throw new AuthorityError("SLOT_CONSUMED", "This slot already has a terminal attempt; do not replay external effects blindly");
      if (entry.generation === Number.MAX_SAFE_INTEGER) throw new AuthorityError("GENERATION_EXHAUSTED", "Claim generation exhausted; archive and replace this job identity");
      const run: AuthorityRun = {
        storeId: state.storeId, jobId, slotId, runId: randomUUID(), generation: ++entry.generation,
        ownerId, state: "claimed", claimedAt: at, updatedAt: at,
        protocolVersion: AUTHORITY_PROTOCOL_VERSION, buildId,
      };
      state.runs.push(run);
      return run;
    });
  }

  start(fence: RunFence, at: string): AuthorityRun {
    requireTimestamp(at);
    return this.mutate((state) => {
      this.requireAdmission();
      const run = this.currentRun(state, fence);
      if (run.state !== "claimed") throw new AuthorityError("INVALID_TRANSITION", "Only a claimed run can start");
      run.state = "started";
      run.startedAt = at;
      run.updatedAt = at;
      return run;
    });
  }

  handoff(fence: RunFence, at: string): AuthorityRun {
    requireTimestamp(at);
    return this.mutate((state) => {
      const run = this.currentRun(state, fence);
      if (run.state !== "started") throw new AuthorityError("INVALID_TRANSITION", "Only started work can be handed off");
      run.handedOffAt ??= at;
      run.updatedAt = at;
      return run;
    });
  }

  /** Unknown is still active: neither elapsed time nor a lost connection permits replacement. */
  markUnknown(fence: RunFence, at: string): AuthorityRun {
    requireTimestamp(at);
    return this.mutate((state) => {
      const run = this.currentRun(state, fence);
      if (run.state !== "started") throw new AuthorityError("INVALID_TRANSITION", "Only started work can become unknown");
      run.uncertainty = "executor_or_effect_unknown";
      run.updatedAt = at;
      return run;
    });
  }

  /** Caller must reconcile/stop the executor and uncertain effects before authorizing replacement. */
  interrupt(fence: RunFence, detail: string, at: string): AuthorityRun {
    requireText(detail, "reconciliation detail");
    requireTimestamp(at);
    return this.mutate((state) => {
      const run = this.currentRun(state, fence);
      if (!active(run)) throw new AuthorityError("INVALID_TRANSITION", "Only an active run can be interrupted");
      run.state = "interrupted";
      run.endedAt = at;
      run.detail = detail;
      run.updatedAt = at;
      return run;
    });
  }

  /** Execution acknowledgment, not a claim of application success or exactly-once effects. */
  acknowledge(fence: RunFence, outcome: "completed" | "failed", nextRunAt: string, at: string, detail?: string, lastShell?: AuthorityJob["lastShell"], result: ExecutionResult = {}): AuthorityRun {
    requireTimestamp(nextRunAt);
    requireTimestamp(at);
    if (outcome !== "completed" && outcome !== "failed") throw new AuthorityError("INVALID_REQUEST", "Invalid execution outcome");
    return this.mutate((state) => {
      const run = this.currentRun(state, fence);
      if (run.state !== "started") throw new AuthorityError("INVALID_TRANSITION", "Only a started run can acknowledge completion");
      run.state = outcome;
      run.updatedAt = at;
      run.endedAt = at;
      run.uncertainty = undefined;
      run.detail = detail;
      run.receipt = boundReceipt(result.receipt, run.runId, run.jobId);
      run.receiptInvalid = Boolean(result.receiptInvalid || (result.receipt !== undefined && !run.receipt));
      run.processExit = result.processExit;
      const job = state.jobs.find((entry) => entry.job.id === run.jobId)!.job;
      job.nextRunAt = nextRunAt;
      job.lastRunAt = at;
      if (outcome === "completed" && applicationSucceeded(run.receipt)) job.lastSuccessfulCompletionAt = at;
      job.updatedAt = at;
      job.runCount++;
      job.lastIdempotencyKey = run.slotId;
      job.lastStatus = outcome === "completed" ? "ok" : "error";
      job.lastError = outcome === "failed" ? detail : undefined;
      job.lastShell = lastShell;
      job.manualRequested = false;
      // Apply only a validated, run-bound request inside the acknowledgement fence.
      if (!run.receiptInvalid && run.receipt?.pauseAfterRun) job.enabled = false;
      // Existing lastStatus is a legacy delivery summary, not application outcome.
      if (job.schedule.type === "once" || (job.maxRuns !== undefined && job.runCount >= job.maxRuns)) {
        job.enabled = false;
        job.terminated = job.schedule.type === "once" ? "once" : "maxRuns";
      }
      return run;
    });
  }

  private currentRun(state: AuthorityState, fence: RunFence): AuthorityRun {
    const entry = state.jobs.find((entry) => entry.job.id === fence.jobId);
    const run = state.runs.find((run) => run.runId === fence.runId);
    if (!entry || !run || state.storeId !== fence.storeId || entry.generation !== fence.generation ||
        run.storeId !== fence.storeId || run.jobId !== fence.jobId || run.slotId !== fence.slotId ||
        run.generation !== fence.generation || run.ownerId !== fence.ownerId) {
      throw new AuthorityError("STALE_FENCE", "Run identity/generation no longer owns this job; reload current authority state");
    }
    return run;
  }

  private read(): AuthorityState {
    const row = this.db.prepare("SELECT document FROM authority WHERE id=1").get();
    let state: unknown;
    try { state = JSON.parse(String(row?.document)); }
    catch { throw new AuthorityError("INVALID_STATE", "Authority state is unreadable. Restore a compatible backup; data was not changed."); }
    validateState(state);
    return state;
  }

  private mutate<T>(fn: (state: AuthorityState) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      const result = fn(state);
      validateState(state);
      this.db.prepare("UPDATE authority SET document=? WHERE id=1").run(JSON.stringify(state));
      this.db.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
