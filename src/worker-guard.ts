import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PrivilegeGuard } from "./privilege.js";

export default function workerGuard(pi: ExtensionAPI): void {
  if (process.env["PI_SCHEDULE_WORKER_CHILD"] !== "1") return;
  const tier = process.env["PI_SCHEDULE_WORKER_TIER"];
  if (tier !== "read_only" && tier !== "suggest" && tier !== "mutate") {
    throw new Error("Invalid scheduled worker privilege tier");
  }
  const guard = new PrivilegeGuard();
  guard.attach(pi);
  pi.on("before_agent_start", () => { guard.enter(tier); });
}
