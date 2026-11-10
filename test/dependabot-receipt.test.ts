import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { dependabotReceipt, writeDependabotReceipt } from "../src/dependabot-receipt.js";
import { Dispatcher } from "../src/dispatcher.js";
import { SchedulerClient } from "../src/client.js";
import { createPromptExecutor } from "../src/worker.js";

const roots: string[] = [];
const exec = promisify(execFile);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const report = (overrides: Record<string, unknown> = {}) => ({ runId: "current", scannedAt: "2026-11-09T00:00:00Z", completedAt: "2026-11-09T00:01:00Z", totalCandidates: 0, decisions: [], errors: [], delivery: { success: true, channel: "private", ts: "private" }, ...overrides });
function fixture() { const root = mkdtempSync(join(tmpdir(), "pi-dependabot-")); roots.push(root); return root; }

describe("package-owned Dependabot receipt adapter", () => {
  it.each([
    [report(), "no_candidates", "sent"],
    [report({ totalCandidates: 1, decisions: [{ decision: "escalate", reason: "PRIVATE" }], escalations: [{ url: "PRIVATE" }] }), "escalated", "sent"],
    [report({ scannedAt: undefined, completedAt: undefined, scanStatus: "not_started", delivery: { success: false } }), "blocked_before_scan", "failed"],
    [report({ delivery: { success: false } }), "no_candidates", "failed"],
    [report({ totalCandidates: 5, decisions: [{ decision: "merged" }], deferredCount: 4 }), "partial", "sent"],
    [report({ totalCandidates: 1, decisions: [{ decision: "merged" }] }), "succeeded", "sent"],
    [{ runId: "current", status: "not_sent", reason: "PRIVATE" }, "unverified", "failed"],
  ])("projects application=%s without copying private contents", (input, application, notification) => {
    const receipt = dependabotReceipt(input, "current", "job");
    expect(receipt).toEqual({ version: 1, runId: "current", jobId: "job", application, notification });
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|private|channel|reason|url/);
  });

  it.each([
    { totalCandidates: undefined, decisions: [null], errors: undefined },
    { totalCandidates: -1 }, { totalCandidates: 0.5 }, { decisions: [null] },
    { decisions: [{ decision: " " }] }, { errors: "missing" }, { errors: undefined },
    { deferredCount: "unknown" }, { escalations: {} },
    { completedAt: "2026-11-08T00:00:00Z" },
    { totalCandidates: 0, decisions: [{ decision: "merged" }] },
  ])("keeps malformed/incomplete completion facts unverified: %j", (overrides) => {
    expect(dependabotReceipt(report(overrides), "current", "job")).toMatchObject({ application: "unverified", notification: "sent" });
  });

  it("retains partial coverage and derives escalation from ordinary decision records", () => {
    expect(dependabotReceipt(report({ totalCandidates: 2, decisions: [{ decision: "merged" }] }), "current", "job").application).toBe("partial");
    expect(dependabotReceipt(report({ totalCandidates: 1, decisions: [{ decision: "escalate", private: "ignored" }] }), "current", "job").application).toBe("escalated");
  });

  it("rejects stale reports and persists a mode-600 projection with exact worker identity", () => {
    const root = fixture(), path = join(root, "receipt.json"), reportPath = join(root, "report.json");
    writeFileSync(reportPath, JSON.stringify(report({ token: "NEVER_COPY", notes: ["PRIVATE"] })));
    const env = { PI_SCHEDULE_RUN_ID: "current", PI_SCHEDULE_JOB_ID: "job", PI_SCHEDULE_RECEIPT_PATH: path };
    expect(writeDependabotReceipt(reportPath, env)).toMatchObject({ runId: "current", application: "no_candidates" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = readFileSync(path, "utf8");
    expect(() => writeDependabotReceipt(reportPath, { ...env, PI_SCHEDULE_RUN_ID: "new" })).toThrow(/match/);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(before).not.toMatch(/NEVER_COPY|PRIVATE/);
  });

  it("CLI writes only the bounded projection, never report text or credentials", async () => {
    const root = fixture(), reportPath = join(root, "report.json"), path = join(root, "receipt.json");
    writeFileSync(reportPath, JSON.stringify(report({ token: "SECRET", totalCandidates: 1, decisions: [{ decision: "merged", private: "CONTENTS" }] })));
    const result = await exec(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/dependabot-receipt.ts", import.meta.url)), reportPath],
      { env: { ...process.env, PI_SCHEDULE_RUN_ID: "current", PI_SCHEDULE_JOB_ID: "job", PI_SCHEDULE_RECEIPT_PATH: path } });
    expect(JSON.parse(result.stdout)).toMatchObject({ runId: "current", application: "succeeded" });
    expect(result.stdout + result.stderr).not.toMatch(/SECRET|CONTENTS/);
  });

  it("composes background exit, adapter receipt, durable authority and rendered history", async () => {
    const home = fixture();
    const executePrompt = createPromptExecutor({ resultsDir: join(home, "results"), processRunner: async (_command, _args, options) => {
      const env = options.env!;
      const reportPath = join(home, "private-report.json");
      writeFileSync(reportPath, JSON.stringify(report({ runId: env.PI_SCHEDULE_RUN_ID, delivery: { success: false }, secret: "DO_NOT_LEAK" })));
      writeDependabotReceipt(reportPath, env);
      return { code: 0, killed: false, stdout: "PRIVATE_REPO", stderr: "" };
    } });
    const dispatcher = new Dispatcher({ home, now: () => new Date("2026-11-09T00:00:00Z"), execute: async ({ job, fence }) => executePrompt("inspect", job, fence.runId) });
    try {
      dispatcher.store.addJob({ id: "job", name: "fixture", prompt: "inspect", action: "prompt", target: "background", executionCwd: home, schedule: { type: "once", delayMs: 1, delay: "1ms" }, scope: "global", enabled: true, missedWindow: "catch_up_one", tier: "read_only", createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z", lastRunAt: null, nextRunAt: "2026-11-09T00:00:00Z", runCount: 0, lastStatus: null });
      await dispatcher.start();
    } finally { await dispatcher.close(); }
    // close drains the synthetic executor; read-only history remains available.
    const history = await new SchedulerClient(home).history();
    expect(history.runs[0]?.outcomeSummary).toBe("execution-completed; outcome-no_candidates; notification-failed");
    expect(history.runs[0]?.receipt?.runId).toBe(history.runs[0]?.runId);
    expect(JSON.stringify(history)).not.toMatch(/DO_NOT_LEAK|PRIVATE_REPO/);
  });
});
