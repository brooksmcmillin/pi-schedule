import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AuthorityJob, AuthorityRun, AuthorityState } from "./authority-types.js";
import { applicationSucceeded } from "./outcome.js";
import { writePrivateJson, type DispatcherHealth } from "./watchdog-health.js";

const MINUTE = 60_000;
export const WATCHDOG_LIMITS = { healthMs: 2 * MINUTE, startMs: 2 * MINUTE, completionMs: 12 * MINUTE };
export interface WatchdogConfig { maintenanceUntil?: string; maintenanceJobIds?: string[] }
export interface Observation { key: string; status: string; incident: boolean; jobId?: string; slotId?: string; successfulRunId?: string }
export interface AlertEvent { id: string; key: string; kind: "incident" | "recovery"; status: string; at: string; attempts: number; delivered?: boolean }
export interface WatchdogState { version: 1; incidents: Record<string, { id: string; status: string; successfulRunId?: string }>; outbox: AlertEvent[] }
export const emptyWatchdogState = (): WatchdogState => ({ version: 1, incidents: {}, outbox: [] });
const stateSchema = Type.Object({
  version: Type.Literal(1),
  incidents: Type.Record(Type.String(), Type.Object({ id: Type.String(), status: Type.String(), successfulRunId: Type.Optional(Type.String()) })),
  outbox: Type.Array(Type.Object({
    id: Type.String(), key: Type.String(), kind: Type.Union([Type.Literal("incident"), Type.Literal("recovery")]),
    status: Type.String(), at: Type.String(), attempts: Type.Integer({ minimum: 0 }), delivered: Type.Optional(Type.Boolean()),
  })),
});

export function readWatchdogState(path: string): WatchdogState {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWatchdogState();
    throw new Error("Cannot read watchdog state; preserve it and restore a compatible backup");
  }
  if (!Value.Check(stateSchema, value)) throw new Error("Unsupported watchdog state; preserve it and upgrade or restore a compatible backup");
  return value;
}

export function persistAlerts(path: string, observations: Observation[], now: Date): WatchdogState {
  const state = reconcileAlerts(readWatchdogState(path), observations, now);
  writePrivateJson(path, state);
  return state;
}

const active = (run: AuthorityRun) => run.state === "claimed" || run.state === "started";
const successful = (run: AuthorityRun) => run.state === "completed" && !run.receiptInvalid && applicationSucceeded(run.receipt) && run.receipt?.notification !== "failed";

/** slotId is jobId:scheduled ISO timestamp; forced early slots carry manual:. */
function slotTime(job: AuthorityJob, run: AuthorityRun): number {
  const prefix = `${job.id}:`;
  return run.slotId.startsWith(prefix) ? Date.parse(run.slotId.slice(prefix.length)) : Date.parse(run.claimedAt);
}

export function inspectWatchdog(snapshot: AuthorityState, health: DispatcherHealth | undefined, now: Date, config: WatchdogConfig = {}): Observation[] {
  const at = now.getTime();
  const maintenance = Date.parse(config.maintenanceUntil ?? "") > at;
  const healthAge = at - Date.parse(health?.checkedAt ?? "");
  const healthy = Number.isFinite(healthAge) && healthAge <= WATCHDOG_LIMITS.healthMs;
  const observations: Observation[] = [{ key: `${snapshot.storeId}:dispatcher`, status: maintenance ? "maintenance" : healthAge < 0 ? "clock_adjustment" : healthy ? "healthy" : "dispatcher_unavailable: inspect pi-schedule-dispatcher.service and dispatcher-health.json", incident: !maintenance && !healthy }];
  for (const { job } of snapshot.jobs) {
    const key = `${snapshot.storeId}:job:${job.id}`;
    let successfulRunId: string | undefined;
    const add = (status: string, incident = false, run?: AuthorityRun) => observations.push({ key, jobId: job.id, status, incident, slotId: run?.slotId, successfulRunId });
    if (maintenance || config.maintenanceJobIds?.includes(job.id)) { add("maintenance"); continue; }
    if (job.cancelled || (!job.enabled && !job.terminated)) { add("disabled"); continue; }
    const runs = snapshot.runs.filter((run) => run.jobId === job.id).sort((a, b) => b.generation - a.generation);
    successfulRunId = runs.find(successful)?.runId;
    const latest = runs[0];
    const running = runs.find(active);
    // A new attempt does not erase a previous failed/overdue outcome until success.
    const unresolved = runs.slice(0, runs.findIndex(successful) < 0 ? runs.length : runs.findIndex(successful))
      .filter((run) => run.state !== "interrupted" || run.startedAt);
    const bad = unresolved.find((run) => run.state === "failed" || run.receiptInvalid ||
      run.receipt?.notification === "failed" || (run.receipt && !applicationSucceeded(run.receipt) && run.receipt.application !== "unverified"));
    if (bad) { add("failed_outcome: inspect run/application/notification receipt; reconcile before any replay", true, bad); continue; }
    if (running?.uncertainty) { add("unknown_execution: reconcile executor and external effects; do not retry blindly", true, running); continue; }
    if (running?.startedAt && at - Date.parse(running.startedAt) > WATCHDOG_LIMITS.completionMs && job.action === "prompt") {
      add("stale_running: inspect executor; watchdog never stops or retries it", true, running); continue;
    }
    const overdue = unresolved.find((run) => at - slotTime(job, run) > WATCHDOG_LIMITS.completionMs);
    if (overdue) { add("completion_overdue: no successful application receipt by slot+12m", true, overdue); continue; }
    if (running) {
      if (!running.startedAt && at - slotTime(job, running) > WATCHDOG_LIMITS.startMs) add("start_overdue: claimed slot has no start", true, running);
      else add("running", false, running);
      continue;
    }
    if (job.terminated) { add(latest && successful(latest) ? "terminated_success" : "terminated_outcome_pending"); continue; }
    if (at > Date.parse(job.nextRunAt)) {
      // Owner availability is deliberately not inferred from background receipts.
      if (job.target === "session") { add("owner_unavailable_or_busy: waiting for exact idle session"); continue; }
      if (at - Date.parse(job.nextRunAt) > WATCHDOG_LIMITS.completionMs) add("completion_overdue: due slot has no successful completion", true);
      else if (at - Date.parse(job.nextRunAt) > WATCHDOG_LIMITS.startMs) add("start_overdue: due slot has no start", true);
      else add("due");
    } else add(latest && successful(latest) ? "scheduled_success" : "scheduled");
  }
  return observations;
}

/** One open incident per job, not one per reason/slot. Persist before attempting delivery. */
export function reconcileAlerts(previous: WatchdogState, observations: Observation[], now: Date): WatchdogState {
  const state = structuredClone(previous);
  const current = new Map(observations.map((entry) => [entry.key, entry]));
  for (const [key, incident] of Object.entries(state.incidents)) {
    const observed = current.get(key);
    const newSuccess = observed?.successfulRunId && observed.successfulRunId !== incident.successfulRunId;
    if (observed?.incident && !newSuccess) { incident.status = observed.status; continue; }
    // A new attempt/clock rollback is not recovery, but an intervening successful generation is.
    if (!newSuccess && observed && ["running", "scheduled", "due", "terminated_outcome_pending", "clock_adjustment"].includes(observed.status)) continue;
    const status = newSuccess ? "successful_application_completion" : observed?.status ?? "job_removed";
    state.outbox.push({ id: randomUUID(), key, kind: "recovery", status, at: now.toISOString(), attempts: 0 });
    delete state.incidents[key];
  }
  for (const observed of observations) {
    if (!observed.incident || state.incidents[observed.key]) continue;
    const id = randomUUID();
    state.incidents[observed.key] = { id, status: observed.status, successfulRunId: observed.successfulRunId };
    state.outbox.push({ id, key: observed.key, kind: "incident", status: observed.status, at: now.toISOString(), attempts: 0 });
  }
  return state;
}
