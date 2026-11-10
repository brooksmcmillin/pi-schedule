import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { listenAuthority, type AuthorityRequest } from "./authority-protocol.js";
import { AuthorityStore, authorityPaths } from "./authority-store.js";
import { ExecutionFailure, type ExecutionResult } from "./outcome.js";
import { healthPath, writePrivateJson } from "./watchdog-health.js";
import { AuthorityError, type AuthorityJob, type AuthorityRun, type RunFence } from "./authority-types.js";
import { CreateRateLimiter, decideDue, idempotencyKeyFor, LIMITS, nextAfter } from "./policy.js";
import { ScheduleRunner, TICK_MS } from "./runner.js";
import { routingError } from "./routing.js";
import { ScheduleStore, newJobId } from "./store.js";
import { computeNextRunAt } from "./schedule.js";
import { createPromptExecutor, runProcess } from "./worker.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface OwnerConnection { sessionId: string; cwd: string; generation: string }
export interface Delivery { job: AuthorityJob; fence: RunFence; forced: boolean }
export interface DeliveryResult extends ExecutionResult { lastShell?: AuthorityJob["lastShell"] }
export interface DispatcherOptions {
  home?: string;
  now?: () => Date;
  tickMs?: number;
  execute?: (delivery: Delivery) => Promise<DeliveryResult>;
}

const active = (run: AuthorityRun) => run.state === "claimed" || run.state === "started";
const visible = (job: AuthorityJob, cwd: string) => !job.cancelled && (job.scope === "global" || job.projectPath === cwd);
const ownerKey = (owner: Pick<OwnerConnection, "sessionId" | "cwd">) => JSON.stringify([owner.sessionId, owner.cwd]);
const fenceFor = ({ storeId, jobId, slotId, runId, generation, ownerId }: RunFence): RunFence => ({ storeId, jobId, slotId, runId, generation, ownerId });

/** Only this service owns scheduling. Session clients pull offers; they never scan or claim. */
export class Dispatcher {
  readonly store: AuthorityStore;
  private readonly home: string;
  private readonly now: () => Date;
  private readonly id = randomUUID();
  private readonly owners = new Map<string, OwnerConnection>();
  private readonly creates = new CreateRateLimiter();
  private readonly executions = new Set<Promise<void>>();
  private readonly execute: NonNullable<DispatcherOptions["execute"]>;
  private timer?: ReturnType<typeof setInterval>;
  private listener?: Awaited<ReturnType<typeof listenAuthority>>;
  private singleton?: DatabaseSync;
  private stopping = false;
  private lastScanError?: string;

  constructor(private readonly options: DispatcherOptions = {}) {
    this.home = options.home ?? homedir();
    this.now = options.now ?? (() => new Date());
    this.store = new AuthorityStore(this.home);
    const runner = new ScheduleRunner({
      store: new ScheduleStore(), background: true,
      pi: { exec: async (command, args, opts) => runProcess(command, args, {
        cwd: opts?.cwd ?? process.cwd(), timeoutMs: opts?.timeout ?? 600_000,
      }) } as ExtensionAPI,
      runPrompt: createPromptExecutor({ resultsDir: join(authorityPaths(this.home).directory, "results") }),
    });
    this.execute = options.execute ?? (async ({ job, fence, forced }) => runner.executeClaimed(
      { cwd: job.executionCwd, hasUI: false, isIdle: () => true } as ExtensionContext,
      job, fence.runId, forced ? "run_now" : "tick", forced, () => {
        if (this.stopping) throw new Error("Dispatcher stopping");
      },
    ));
  }

  async start(): Promise<void> {
    const paths = authorityPaths(this.home);
    // A separate SQLite writer lock lasts until process death. Only its holder may
    // remove a crashed service's socket; concurrent starters cannot unlink a live one.
    this.singleton = new DatabaseSync(join(paths.directory, "dispatcher.sqlite"));
    chmodSync(join(paths.directory, "dispatcher.sqlite"), 0o600);
    try {
      this.singleton.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
      if (existsSync(paths.socket)) {
        await new Promise<void>((resolveProbe, reject) => {
          const socket = createConnection(paths.socket);
          socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Existing authority socket did not answer; inspect it before restarting")); });
          socket.once("connect", () => { socket.destroy(); reject(new Error("An authority service is already listening; stop it before starting dispatcher")); });
          socket.once("error", (error: NodeJS.ErrnoException) => {
            socket.destroy();
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolveProbe();
            else reject(error);
          });
        });
        if (existsSync(paths.socket)) unlinkSync(paths.socket);
      }
      // Claimed is pre-effect: old connection generations are no longer registered.
      // Started is ambiguous and stays active, including mutating headless children.
      for (const run of this.store.snapshot().runs) {
        if (run.state === "claimed") this.store.interrupt(fenceFor(run), "Restart before begin; previous dispatcher/connection cannot start", this.now().toISOString());
        else if (run.state === "started") this.store.markUnknown(fenceFor(run), this.now().toISOString());
      }
      this.listener = await listenAuthority(this.store, this.home, (request) => this.request(request));
      this.timer = setInterval(() => {
        try { this.scan(); this.lastScanError = undefined; }
        catch (error) { this.lastScanError = String(error); console.error(`[pi-schedule] ${this.lastScanError}`); }
      }, this.options.tickMs ?? TICK_MS);
      this.timer.unref();
      this.scan();
    } catch (error) {
      await this.listener?.close();
      this.singleton.close();
      this.singleton = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.listener?.close();
    await Promise.all(this.executions);
    this.singleton?.close();
    this.store.close();
  }

  request(request: AuthorityRequest): unknown {
    if (this.stopping) throw new AuthorityError("STOPPING", "Dispatcher is stopping; inspect history before retrying");
    switch (request.op) {
      case "snapshot": return { ...this.store.snapshot(), dispatcher: { id: this.id, error: this.lastScanError } };
      case "create_job": {
        const definition = request.definition;
        const count = this.store.snapshot().jobs.filter(({ job }) => !job.cancelled && job.scope === definition.scope &&
          (job.scope === "global" || job.projectPath === definition.projectPath)).length;
        if (count >= LIMITS.maxJobsPerScope) throw new AuthorityError("JOB_LIMIT", "Scope job limit reached; cancel unused jobs");
        if (!this.creates.tryTake(this.now().getTime())) throw new AuthorityError("RATE_LIMIT", "Dispatcher create rate limit reached; wait one minute");
        const at = this.now();
        return this.store.addJob({ ...definition, id: newJobId(), enabled: true,
          createdAt: at.toISOString(), updatedAt: at.toISOString(),
          nextRunAt: computeNextRunAt(definition.schedule, at).toISOString(),
          lastRunAt: null, runCount: 0, lastStatus: null });
      }
      case "edit_job": {
        this.getVisible(request.jobId, request.cwd);
        return this.store.updateJob(request.jobId, (job) => {
          job.enabled = request.action === "enable";
          if (job.enabled) job.terminated = null;
          else job.manualRequested = false;
          if (request.action === "cancel") job.cancelled = true;
          job.updatedAt = this.now().toISOString();
        });
      }
      case "run_now": {
        const job = this.getVisible(request.jobId, request.cwd);
        const ownerError = job.target === "session" ? routingError(job, request.requesterSessionId, request.cwd) : undefined;
        if (ownerError) throw new AuthorityError("WRONG_OWNER", ownerError);
        if (job.terminated) throw new AuthorityError("JOB_DISABLED", "Enable or recreate this terminated job before running");
        if (job.nextRunAt !== request.nextRunAt) return { status: "superseded", job };
        const existing = this.store.snapshot().runs.find((run) => run.jobId === job.id && active(run));
        if (existing) return { status: "pending", reason: "active_or_ambiguous_execution", run: existing };
        if (!job.manualRequested) this.store.updateJob(job.id, (entry) => { entry.manualRequested = true; });
        this.scan();
        return { status: "pending", reason: job.target === "session" ? "waiting_for_exact_idle_owner" : "dispatcher_execution", job: this.getVisible(job.id, request.cwd) };
      }
      case "scan": this.scan(); return { status: "scanned" };
      case "register_owner": {
        if (!isAbsolute(request.cwd)) throw new AuthorityError("INVALID_OWNER", "Owner workspace must be absolute");
        const key = ownerKey(request);
        const previous = this.owners.get(key);
        const owner = { sessionId: request.sessionId, cwd: request.cwd, generation: randomUUID() };
        this.owners.set(key, owner);
        if (previous) this.releaseUnstarted(previous);
        return owner;
      }
      case "unregister_owner": {
        this.requireOwner(request.owner);
        this.owners.delete(ownerKey(request.owner));
        this.releaseUnstarted(request.owner);
        return { status: "closed" };
      }
      case "receive": {
        this.requireOwner(request.owner);
        if (!request.idle) return null;
        for (const { job } of this.store.snapshot().jobs) {
          if (job.target !== "session" || job.ownerSessionId !== request.owner.sessionId || job.executionCwd !== request.owner.cwd) continue;
          const delivery = this.prepare(job, request.owner.generation);
          if (delivery) return delivery;
        }
        return null;
      }
      case "defer_delivery": {
        this.requireDelivery(request.owner, request.fence);
        return this.store.interrupt(request.fence, "Exact receiver confirms no effect attempted; waiting for idle", this.now().toISOString());
      }
      case "handoff_delivery": {
        this.requireDelivery(request.owner, request.fence);
        return this.store.handoff(request.fence, this.now().toISOString());
      }
      case "reconcile_execution": {
        const state = this.store.snapshot();
        const run = state.runs.find((entry) => entry.runId === request.fence.runId);
        if (!run?.uncertainty || !request.executorStopped || !request.effectsReconciled) {
          throw new AuthorityError("RECONCILIATION_REQUIRED", "Confirm executor death and reconcile external effects for an unknown run before closing it");
        }
        const job = state.jobs.find((entry) => entry.job.id === run.jobId)!.job;
        return this.finish(job, request.fence, request.outcome, { receipt: request.receipt, detail: "Executor stopped; effects reconciled explicitly" });
      }
      case "begin_delivery": {
        this.requireDelivery(request.owner, request.fence);
        return this.store.start(request.fence, this.now().toISOString());
      }
      case "finish_delivery": {
        const job = this.requireDelivery(request.owner, request.fence);
        return this.finish(job, request.fence, request.outcome, request);
      }
      default: throw new AuthorityError("DISPATCHER_ONLY", "Clients cannot claim or mutate execution state. Upgrade/reload pi-schedule and use dispatcher operations");
    }
  }

  private requireOwner(owner: OwnerConnection): void {
    if (this.owners.get(ownerKey(owner))?.generation !== owner.generation) {
      throw new AuthorityError("STALE_CONNECTION", "Owner connection changed or dispatcher restarted; register again");
    }
  }

  private requireDelivery(owner: OwnerConnection, fence: RunFence): AuthorityJob {
    this.requireOwner(owner);
    const job = this.getVisible(fence.jobId, owner.cwd);
    if (job.target !== "session" || job.ownerSessionId !== owner.sessionId || job.executionCwd !== owner.cwd || fence.ownerId !== owner.generation) {
      throw new AuthorityError("WRONG_OWNER", "Delivery does not belong to this exact session/workspace/connection");
    }
    return job;
  }

  private releaseUnstarted(owner: OwnerConnection): void {
    for (const run of this.store.snapshot().runs) {
      if (run.ownerId === owner.generation && run.state === "claimed") {
        this.store.interrupt(fenceFor(run), "Connection revoked before begin; old generation cannot start", this.now().toISOString());
      } else if (run.ownerId === owner.generation && run.state === "started") {
        this.store.markUnknown(fenceFor(run), this.now().toISOString());
      }
    }
  }

  private getVisible(id: string, cwd: string): AuthorityJob {
    const job = this.store.snapshot().jobs.find(({ job }) => job.id === id && visible(job, cwd))?.job;
    if (!job) throw new AuthorityError("JOB_NOT_FOUND", `Unknown job ${id} in this scope`);
    return job;
  }

  private prepare(job: AuthorityJob, ownerId: string): Delivery | undefined {
    const at = this.now();
    if (job.cancelled || (!job.enabled && !job.manualRequested) || job.terminated || (!job.manualRequested && Date.parse(job.nextRunAt) > at.getTime())) return;
    if (this.store.snapshot().runs.some((run) => run.jobId === job.id && active(run))) return;
    const forced = Boolean(job.manualRequested);
    if (!forced && decideDue(job, at, this.options.tickMs ?? TICK_MS).action === "skip") {
      this.store.updateJob(job.id, (entry) => {
        entry.nextRunAt = nextAfter(entry.schedule, at).toISOString();
        entry.lastStatus = "skipped";
        entry.lastError = "missed_window";
        entry.updatedAt = at.toISOString();
      });
      return;
    }
    const slotId = forced && Date.parse(job.nextRunAt) > at.getTime() ? `manual:${idempotencyKeyFor(job)}` : idempotencyKeyFor(job);
    try {
      const run = this.store.claim(job.id, slotId, ownerId, "pi-schedule-0.3.6-receipts-v1", at.toISOString(), forced);
      return { job, fence: fenceFor(run), forced };
    } catch (error) {
      if (error instanceof AuthorityError && ["CLAIM_BUSY", "SLOT_CONSUMED"].includes(error.code)) return;
      throw error;
    }
  }

  scan(): void {
    if (this.stopping) return;
    let count = 0;
    for (const { job } of this.store.snapshot().jobs) {
      if (job.target !== "background" || count >= LIMITS.maxFiresPerTick) continue;
      const delivery = this.prepare(job, this.id);
      if (!delivery) continue;
      this.store.start(delivery.fence, this.now().toISOString());
      count++;
      const promise = Promise.resolve().then(() => this.execute(delivery)).then(
        (result) => { this.finish(job, delivery.fence, "completed", result); },
        (error) => { this.finish(job, delivery.fence, "failed", {
          ...(error instanceof ExecutionFailure ? error.result : {}), detail: String(error),
        }); },
      ).catch((error) => { this.lastScanError = String(error); console.error(`[pi-schedule] acknowledgment failed: ${error}`); });
      this.executions.add(promise);
      void promise.finally(() => this.executions.delete(promise));
    }
    writePrivateJson(healthPath(authorityPaths(this.home).directory), { checkedAt: this.now().toISOString() });
  }

  private finish(job: AuthorityJob, fence: RunFence, outcome: "completed" | "failed", result: DeliveryResult) {
    const at = this.now();
    return this.store.acknowledge(fence, outcome, nextAfter(job.schedule, at).toISOString(), at.toISOString(), result.detail, result.lastShell, result);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dispatcher = new Dispatcher();
  try {
    await dispatcher.start();
    const stop = () => { void dispatcher.close().then(() => process.exit(0)); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    console.log("pi-schedule dispatcher ready");
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
