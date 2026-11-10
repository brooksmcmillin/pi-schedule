import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, renameSync } from "node:fs";
import { boundReceipt } from "./outcome.js";
import { registerOutcomeTool } from "./outcome-tool.js";
import { PrivilegeGuard } from "./privilege.js";

export default function workerGuard(pi: ExtensionAPI): void {
  if (process.env["PI_SCHEDULE_WORKER_CHILD"] !== "1") return;
  const tier = process.env["PI_SCHEDULE_WORKER_TIER"];
  if (tier !== "read_only" && tier !== "suggest" && tier !== "mutate") {
    throw new Error("Invalid scheduled worker privilege tier");
  }
  const runId = process.env["PI_SCHEDULE_RUN_ID"];
  const jobId = process.env["PI_SCHEDULE_JOB_ID"];
  const path = process.env["PI_SCHEDULE_RECEIPT_PATH"];
  if (runId && jobId && path) registerOutcomeTool(pi, (receipt) => {
    if (!boundReceipt(receipt, runId, jobId)) throw new Error("Outcome does not belong to this scheduled run");
    writeFileSync(`${path}.tmp`, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  });
  const guard = new PrivilegeGuard();
  guard.attach(pi);
  pi.on("before_agent_start", () => { guard.enter(tier); });
}
