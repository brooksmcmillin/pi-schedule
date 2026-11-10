import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorityJob, AuthorityRun, AuthorityState } from "../src/authority-types.js";
import { emptyWatchdogState, inspectWatchdog, persistAlerts, readWatchdogState, reconcileAlerts } from "../src/watchdog.js";
const at = "2026-11-09T00:00:00.000Z";
const clock = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000);
const job = (overrides: Partial<AuthorityJob> = {}): AuthorityJob => ({
  id: "job", name: "check", prompt: "inspect", target: "background", executionCwd: "/workspace", action: "prompt",
  schedule: { type: "interval", everyMs: 3600000, every: "1h" }, scope: "global", enabled: true,
  missedWindow: "catch_up_one", tier: "read_only", createdAt: at, updatedAt: at, lastRunAt: null,
  nextRunAt: at, runCount: 0, lastStatus: null, ...overrides,
});
const run = (overrides: Partial<AuthorityRun> = {}): AuthorityRun => ({
  storeId: "store", jobId: "job", slotId: `job:${at}`, runId: "run", generation: 1, ownerId: "dispatcher",
  state: "started", claimedAt: at, startedAt: at, updatedAt: at, protocolVersion: 2, buildId: "test", ...overrides,
});
const snapshot = (j = job(), runs: AuthorityRun[] = []): AuthorityState => ({ schemaVersion: 1, storeId: "store", jobs: [{ job: j, generation: runs.length }], runs });
const observe = (minutes: number, j = job(), runs: AuthorityRun[] = []) => inspectWatchdog(snapshot(j, runs), { checkedAt: clock(minutes).toISOString() }, clock(minutes));
const jobStatus = (minutes: number, j = job(), runs: AuthorityRun[] = []) => observe(minutes, j, runs)[1]!;
const receipt = { version: 1 as const, runId: "run", jobId: "job", application: "succeeded" as const, notification: "sent" as const };

describe("watchdog detection", () => {
  it("uses strict 2m health/start and 12m slot deadlines", () => {
    expect(inspectWatchdog(snapshot(), { checkedAt: at }, clock(2))[0]?.incident).toBe(false);
    expect(inspectWatchdog(snapshot(), { checkedAt: at }, clock(2.01))[0]?.incident).toBe(true);
    expect(inspectWatchdog(snapshot(), undefined, clock(0))[0]?.incident).toBe(true);
    expect(jobStatus(2).incident).toBe(false);
    expect(jobStatus(2.01).status).toMatch(/^start_overdue/);
    expect(jobStatus(12).status).toMatch(/^start_overdue/);
    expect(jobStatus(12.01).status).toMatch(/^completion_overdue/);
  });
  it("detects late starts separately from running prompts and successful execution without an app receipt", () => {
    const j = job({ nextRunAt: clock(60).toISOString() });
    expect(jobStatus(3, j, [run({ state: "claimed", startedAt: undefined })]).status).toMatch(/^start_overdue/);
    expect(jobStatus(12, j, [run()]).incident).toBe(false);
    expect(jobStatus(12.01, j, [run()]).status).toMatch(/^stale_running/);
    expect(jobStatus(13, j, [run({ state: "completed" })]).status).toMatch(/^completion_overdue/);
    // Late start at 11m still has the original slot+12m completion budget.
    expect(jobStatus(13, j, [run({ startedAt: clock(11).toISOString() })]).status).toMatch(/^completion_overdue/);
    expect(jobStatus(13, j, [run({ state: "completed", receipt })]).incident).toBe(false);
  });
  it.each(["failed", "blocked_before_scan", "partial"] as const)("alerts on %s receipt on the next check", (application) => {
    expect(jobStatus(1, job(), [run({ state: "completed", receipt: { ...receipt, application } })]).status).toMatch(/^failed_outcome/);
  });
  it("alerts immediately for process failure, invalid receipt, notification failure and ambiguous executors", () => {
    for (const r of [run({ state: "failed" }), run({ state: "completed", receiptInvalid: true }), run({ receipt: { ...receipt, notification: "failed" } })]) {
      expect(jobStatus(1, job(), [r]).status).toMatch(/^failed_outcome/);
    }
    expect(jobStatus(1, job(), [run({ uncertainty: "executor_or_effect_unknown" })]).status).toMatch(/^unknown_execution/);
  });
  it("distinguishes disabled, maintenance, exact-owner waiting and automatic termination outcomes", () => {
    expect(jobStatus(90, job({ enabled: false })).status).toBe("disabled");
    expect(jobStatus(90, job({ target: "session", ownerSessionId: "owner" })).status).toMatch(/^owner_unavailable_or_busy/);
    expect(inspectWatchdog(snapshot(), undefined, clock(90), { maintenanceUntil: clock(100).toISOString() }).every((o) => o.status === "maintenance")).toBe(true);
    expect(inspectWatchdog(snapshot(), { checkedAt: at }, clock(90), { maintenanceJobIds: ["job"] })[1]?.status).toBe("maintenance");
    for (const terminated of ["once", "maxRuns"] as const) {
      expect(jobStatus(13, job({ enabled: false, terminated }), [run({ state: "completed" })]).incident).toBe(true);
      expect(jobStatus(13, job({ enabled: false, terminated }), [run({ state: "completed", receipt })]).status).toBe("terminated_success");
    }
  });
  it("ignores proven pre-effect interruptions awaiting the owner", () => {
    expect(jobStatus(13, job({ target: "session", ownerSessionId: "owner" }), [run({ state: "interrupted", startedAt: undefined })]).incident).toBe(false);
  });
});

describe("durable incident reconciliation", () => {
  it("does not recover a dispatcher incident from a future heartbeat after clock rollback", () => {
    let state = reconcileAlerts(emptyWatchdogState(), inspectWatchdog(snapshot(), { checkedAt: at }, clock(3)), clock(3));
    const count = state.outbox.length;
    state = reconcileAlerts(state, inspectWatchdog(snapshot(), { checkedAt: at }, clock(-5)), clock(-5));
    expect(state.outbox).toHaveLength(count);
    expect(state.incidents["store:dispatcher"]).toBeDefined();
  });
  it("persists private state before delivery and reloads one incident across checks", () => {
    const root = mkdtempSync(join(tmpdir(), "watchdog-state-"));
    try {
      const path = join(root, "alerts.json");
      persistAlerts(path, observe(3), clock(3));
      persistAlerts(path, observe(200), clock(200));
      expect(readWatchdogState(path).outbox).toHaveLength(1);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const success = observe(201, job({ nextRunAt: clock(260).toISOString() }), [run({ state: "completed", receipt })]);
      persistAlerts(path, success, clock(201));
      persistAlerts(path, success, clock(202));
      expect(readWatchdogState(path).outbox.map((e) => e.kind)).toEqual(["incident", "recovery"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("deduplicates across slots/reasons/restarts, sleep catch-up and clock rollback; recovers once", () => {
    let state = reconcileAlerts(emptyWatchdogState(), observe(3), clock(3));
    expect(state.outbox).toHaveLength(1);
    state = reconcileAlerts(JSON.parse(JSON.stringify(state)), observe(200), clock(200));
    state = reconcileAlerts(state, observe(-5), clock(-5));
    state = reconcileAlerts(state, observe(3), clock(3));
    expect(state.outbox).toHaveLength(1);
    // New in-flight work cannot recover a failed/overdue previous incident.
    state = reconcileAlerts(state, observe(4, job(), [run()]), clock(4));
    expect(state.outbox).toHaveLength(1);
    const success = observe(5, job({ nextRunAt: clock(60).toISOString() }), [run({ state: "completed", receipt })]);
    state = reconcileAlerts(state, success, clock(5));
    state = reconcileAlerts(state, success, clock(6));
    expect(state.outbox.map((e) => e.kind)).toEqual(["incident", "recovery"]);
    expect(state.incidents).toEqual({});
  });
  it.each(["due", "active"])("recovers an intervening successful generation with the next short-cadence slot %s", (next) => {
    const failed = run({ state: "failed" });
    let state = reconcileAlerts(emptyWatchdogState(), observe(1, job(), [failed]), clock(1));
    const succeeded = run({ runId: "success", generation: 2, state: "completed", receipt: { ...receipt, runId: "success" } });
    const pending = run({ runId: "pending", generation: 3, slotId: `job:${clock(4).toISOString()}`, startedAt: clock(4).toISOString() });
    const j = job({ schedule: { type: "interval", everyMs: 60_000, every: "1m" }, nextRunAt: clock(4).toISOString() });
    const runs = next === "active" ? [failed, succeeded, pending] : [failed, succeeded];
    state = reconcileAlerts(state, observe(5, j, runs), clock(5));
    state = reconcileAlerts(JSON.parse(JSON.stringify(state)), observe(5, j, runs), clock(5));
    expect(state.outbox.map((e) => e.kind)).toEqual(["incident", "recovery"]);
    expect(state.outbox[1]?.status).toBe("successful_application_completion");
    const nextFailure = run({ ...pending, state: "failed" });
    state = reconcileAlerts(state, observe(6, j, [failed, succeeded, nextFailure]), clock(6));
    state = reconcileAlerts(state, observe(7, j, [failed, succeeded, nextFailure]), clock(7));
    expect(state.outbox.map((e) => e.kind)).toEqual(["incident", "recovery", "incident"]);
  });
  it("rejects an otherwise successful receipt marked invalid", () => {
    expect(jobStatus(1, job(), [run({ state: "completed", receipt, receiptInvalid: true })]).status).toMatch(/^failed_outcome/);
  });
  it("keeps failure visible during a new attempt until a successful result", () => {
    const failed = run({ state: "failed" });
    const newer = run({ runId: "next", generation: 2, startedAt: clock(10).toISOString() });
    expect(jobStatus(11, job(), [failed, newer]).status).toMatch(/^failed_outcome/);
  });
  it("emits one maintenance/disabled recovery, not a false success claim", () => {
    let state = reconcileAlerts(emptyWatchdogState(), observe(3), clock(3));
    const disabled = observe(4, job({ enabled: false }));
    state = reconcileAlerts(state, disabled, clock(4));
    expect(state.outbox[1]).toMatchObject({ kind: "recovery", status: "disabled" });
  });
});
