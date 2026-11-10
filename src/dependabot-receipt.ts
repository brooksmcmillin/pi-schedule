import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApplicationReceipt } from "./outcome.js";
import { Type } from "typebox";
import { Value } from "typebox/value";

// Extra report fields remain private and do not invalidate ordinary producer output.
const completionFacts = Type.Object({
  totalCandidates: Type.Integer({ minimum: 0 }),
  decisions: Type.Array(Type.Object({ decision: Type.String({ minLength: 1, pattern: "\\S" }) })),
  errors: Type.Array(Type.Unknown()),
  deferredCount: Type.Optional(Type.Integer({ minimum: 0 })),
  escalations: Type.Optional(Type.Array(Type.Unknown())),
});

/** Structural projection of a private Dependabot report, never a review/merge eligibility decision. */
export function dependabotReceipt(value: unknown, runId: string, jobId: string): ApplicationReceipt {
  if (!value || typeof value !== "object") throw new Error("Dependabot report must be an object");
  const report = value as Record<string, unknown>;
  if (!runId || !jobId || report.runId !== runId) throw new Error("Dependabot report does not match the current run ID");
  const delivery = report.delivery && typeof report.delivery === "object" ? report.delivery as Record<string, unknown> : {};
  const notification: ApplicationReceipt["notification"] = delivery.success === true ? "sent"
    : delivery.success === false || report.status === "not_sent" ? "failed"
    : delivery.status === "not_required" ? "not_required" : "unverified";
  const count = (field: string) => Array.isArray(report[field]) ? report[field].length : 0;
  const scanned = typeof report.scannedAt === "string" && Number.isFinite(Date.parse(report.scannedAt));
  const completed = typeof report.completedAt === "string" && Number.isFinite(Date.parse(report.completedAt));
  let application: ApplicationReceipt["application"] = "unverified";
  if (report.scanStatus === "not_started" || report.status === "blocked_before_scan") application = "blocked_before_scan";
  else if (report.scanStatus === "partial" || (scanned && (!completed || count("errors") > 0 || (typeof report.deferredCount === "number" && report.deferredCount > 0)))) application = "partial";
  else if (scanned && completed && Date.parse(report.completedAt as string) >= Date.parse(report.scannedAt as string) && Value.Check(completionFacts, report)) {
    if (report.decisions.length < report.totalCandidates) application = "partial";
    else if (report.decisions.length > report.totalCandidates) application = "unverified";
    else if (report.totalCandidates === 0) application = "no_candidates";
    else if (count("escalations") > 0 || report.decisions.some((entry) => entry.decision === "escalate")) application = "escalated";
    else application = "succeeded";
  }
  return { version: 1, runId, jobId, application, notification };
}

/** Optional worker-side integration. Only a bounded receipt is written, never the report. */
export function writeDependabotReceipt(reportPath: string, env: NodeJS.ProcessEnv = process.env): ApplicationReceipt {
  const runId = env.PI_SCHEDULE_RUN_ID, jobId = env.PI_SCHEDULE_JOB_ID, path = env.PI_SCHEDULE_RECEIPT_PATH;
  if (!runId || !jobId || !path) throw new Error("Current scheduler run/job/receipt environment is required");
  const receipt = dependabotReceipt(JSON.parse(readFileSync(reportPath, "utf8")), runId, jobId);
  writeFileSync(`${path}.tmp`, JSON.stringify(receipt) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: tsx src/dependabot-receipt.ts <private-report.json>");
    console.log(JSON.stringify(writeDependabotReceipt(process.argv[2]!)));
  } catch (error) {
    // JSON syntax errors can quote private report content; do not relay their messages.
    console.error(error instanceof SyntaxError ? "Invalid private Dependabot report JSON" : String(error));
    process.exitCode = 1;
  }
}
