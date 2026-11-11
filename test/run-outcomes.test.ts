import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityStore } from "../src/authority-store.js";
import type { AuthorityJob } from "../src/authority-types.js";
import { Dispatcher } from "../src/dispatcher.js";
import { SchedulerClient } from "../src/client.js";
import { createPromptExecutor } from "../src/worker.js";
import { outcomeSummary, type ApplicationReceipt } from "../src/outcome.js";

const at = "2026-11-09T00:00:00.000Z";
const later = "2026-11-09T01:00:00.000Z";
const roots: string[] = [];
const stores: AuthorityStore[] = [];
const services: Dispatcher[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(overrides: Partial<AuthorityJob> = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-outcome-")); roots.push(home);
  const store = new AuthorityStore(home); stores.push(store);
  const job = store.addJob({ id: "job", name: "review", prompt: "inspect", target: "background", executionCwd: home,
    action: "prompt", schedule: { type: "interval", everyMs: 3600000, every: "1h" }, scope: "global",
    enabled: true, missedWindow: "catch_up_one", tier: "read_only", createdAt: at, updatedAt: at,
    lastRunAt: null, nextRunAt: at, runCount: 0, lastStatus: null, ...overrides });
  const begin = (slot = at) => {
    const run = store.claim(job.id, slot, "fixture", "receipt-test", at);
    store.start(run, at); return run;
  };
  return { home, store, job, begin };
}
function receipt(runId: string, application: ApplicationReceipt["application"] = "succeeded", notification: ApplicationReceipt["notification"] = "not_required"): ApplicationReceipt {
  return { version: 1, runId, jobId: "job", application, notification };
}

describe("run-bound application outcomes", () => {
  it.each([undefined, { version: 1, runId: "older", jobId: "job", application: "succeeded", notification: "sent" }, { runId: "bad" }])("execution completion is unverified without a matching valid receipt: %j", (value) => {
    const f = fixture(), run = f.begin();
    const completed = f.store.acknowledge(run, "completed", later, at, undefined, undefined, { receipt: value });
    expect(outcomeSummary(completed)).toContain("execution-completed; outcome-unverified");
    expect(f.store.snapshot().jobs[0]?.job.lastSuccessfulCompletionAt).toBeUndefined();
    expect(completed.receiptInvalid).toBe(value !== undefined);
  });

  it.each(["blocked_before_scan", "partial", "failed", "no_candidates", "escalated"] as const)("retains distinct %s and notification failure", (application) => {
    const f = fixture(), run = f.begin();
    const result = f.store.acknowledge(run, "completed", later, at, undefined, undefined, { receipt: receipt(run.runId, application, "failed") });
    expect(outcomeSummary(result)).toContain(`outcome-${application}; notification-failed`);
    expect(f.store.snapshot().jobs[0]?.job.lastSuccessfulCompletionAt).toBe(["no_candidates", "escalated"].includes(application) ? at : undefined);
  });

  it.each(["completed", "failed"] as const)("persists a run-bound pause on %s acknowledgement without terminating the job", (outcome) => {
    const f = fixture(), run = f.begin();
    const paused = { ...receipt(run.runId, "blocked_before_scan"), pauseAfterRun: true };
    expect(() => f.store.updateJob("job", (job) => { job.enabled = false; })).toThrow(/active/);
    expect(() => f.store.acknowledge({ ...run, generation: run.generation + 1 }, outcome, later, at,
      undefined, undefined, { receipt: paused })).toThrow(/generation/);
    expect(f.store.snapshot().jobs[0]?.job.enabled).toBe(true);
    f.store.acknowledge(run, outcome, later, at, undefined, undefined, { receipt: paused });
    const reopened = new AuthorityStore(f.home); stores.push(reopened);
    expect(reopened.snapshot().jobs[0]?.job).toMatchObject({ enabled: false, runCount: 1, nextRunAt: later });
    expect(reopened.snapshot().jobs[0]?.job.terminated).toBeUndefined();
    expect(() => reopened.claim("job", later, "fixture", "test", later)).toThrow(/disabled/);
    reopened.updateJob("job", (job) => { job.enabled = true; });
    expect(reopened.claim("job", later, "fixture", "test", later).state).toBe("claimed");
  });

  it.each(["stale-run", "foreign-job", "malformed", "invalid-result", "omitted", "false"])("does not pause for %s receipts", (kind) => {
    const f = fixture(), run = f.begin();
    const value = { ...receipt(run.runId, "blocked_before_scan"), pauseAfterRun: true } as Record<string, unknown>;
    if (kind === "stale-run") value.runId = "stale";
    if (kind === "foreign-job") value.jobId = "foreign";
    if (kind === "malformed") value.pauseAfterRun = "true";
    if (kind === "omitted") delete value.pauseAfterRun;
    if (kind === "false") value.pauseAfterRun = false;
    f.store.acknowledge(run, "completed", later, at, undefined, undefined,
      { receipt: value, receiptInvalid: kind === "invalid-result" });
    expect(f.store.snapshot().jobs[0]?.job.enabled).toBe(true);
  });

  it("advances failed slots without losing last successful completion or accepting an old generation", () => {
    const f = fixture(), first = f.begin();
    f.store.acknowledge(first, "completed", later, at, undefined, undefined, { receipt: receipt(first.runId) });
    const second = f.begin(later);
    f.store.acknowledge(second, "failed", "2026-11-09T02:00:00Z", later);
    expect(f.store.snapshot().jobs[0]?.job).toMatchObject({ runCount: 2, nextRunAt: "2026-11-09T02:00:00Z", lastSuccessfulCompletionAt: at, lastStatus: "error" });
    expect(() => f.store.acknowledge(first, "completed", later, at)).toThrow(/generation/);
  });

  it.each([{ schedule: { type: "once", delayMs: 1000, delay: "1s" } }, { maxRuns: 1 }] as const)("counts failed attempts toward once/maxRuns, not verified success", (override) => {
    const f = fixture(override), run = f.begin();
    f.store.acknowledge(run, "failed", later, at);
    expect(f.store.snapshot().jobs[0]?.job).toMatchObject({ enabled: false, runCount: 1, lastStatus: "error" });
    expect(f.store.snapshot().jobs[0]?.job.lastSuccessfulCompletionAt).toBeUndefined();
  });

  it("does not retry a failed executor on every tick and renders independent outcomes in history", async () => {
    const f = fixture();
    const execute = vi.fn(async () => { throw new Error("fixture failure"); });
    const dispatcher = new Dispatcher({ home: f.home, now: () => new Date(at), execute }); services.push(dispatcher);
    await dispatcher.start();
    await vi.waitFor(() => expect(dispatcher.store.snapshot().runs[0]?.state).toBe("failed"));
    for (let i = 0; i < 10; i++) dispatcher.scan();
    expect(execute).toHaveBeenCalledOnce();
    const history = await new SchedulerClient(f.home).history();
    expect(history.runs[0]?.outcomeSummary).toContain("execution-failed; outcome-unverified");
  });

  it.each([{ code: 1, killed: false }, { code: 0, killed: true }])("retains a published receipt and process exit on executor failure: %j", async (processExit) => {
    const f = fixture();
    const executePrompt = createPromptExecutor({ resultsDir: f.home, processRunner: async (_command, _args, options) => {
      writeFileSync(options.env!.PI_SCHEDULE_RECEIPT_PATH!, JSON.stringify(receipt(options.env!.PI_SCHEDULE_RUN_ID!, "partial", "failed")));
      return { ...processExit, stdout: "PRIVATE", stderr: "PRIVATE" };
    } });
    const dispatcher = new Dispatcher({ home: f.home, now: () => new Date(at), execute: async ({ job, fence }) => executePrompt("inspect", job, fence.runId) });
    services.push(dispatcher); await dispatcher.start();
    await vi.waitFor(() => expect(dispatcher.store.snapshot().runs[0]?.state).toBe("failed"));
    const history = await new SchedulerClient(f.home).history();
    expect(history.runs[0]).toMatchObject({ state: "failed", processExit, receipt: { application: "partial", notification: "failed" } });
    expect(history.runs[0]?.receipt?.runId).toBe(history.runs[0]?.runId);
    expect(JSON.stringify(history)).not.toContain("PRIVATE");
    expect(dispatcher.store.snapshot().jobs[0]?.job.lastSuccessfulCompletionAt).toBeUndefined();
  });

  it.each(["missing", "stale", "valid", "malformed"])("background exit0 with %s receipt is classified separately", async (kind) => {
    const f = fixture();
    const run = createPromptExecutor({ resultsDir: f.home, processRunner: async (_command, _args, options) => {
      const env = options.env!;
      expect(env.PI_SCHEDULE_RUN_ID).toBe("current");
      expect(env.PI_SCHEDULE_JOB_ID).toBe("job");
      if (kind !== "missing") writeFileSync(env.PI_SCHEDULE_RECEIPT_PATH!, kind === "malformed" ? "{" : JSON.stringify(receipt(kind === "stale" ? "older" : "current")));
      return { code: 0, killed: false, stdout: "", stderr: "" };
    } });
    const result = await run("inspect", f.job, "current");
    const authorityRun = f.store.claim("job", at, "test", "test", at);
    // Bind the executor result to its actual UUID in the valid case; stale remains rejected.
    if (kind === "valid") result.receipt = receipt(authorityRun.runId);
    f.store.start(authorityRun, at);
    const finished = f.store.acknowledge(authorityRun, "completed", later, at, undefined, undefined, result);
    expect(finished.receipt?.application).toBe(kind === "valid" ? "succeeded" : undefined);
    expect(finished.receiptInvalid).toBe(kind === "stale" || kind === "malformed");
  });
});
