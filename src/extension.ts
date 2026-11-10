import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SchedulerClient } from "./client.js";
import { OwnerReceiver } from "./receiver.js";
import { registerScheduleTool } from "./tool.js";

/** Interactive processes manage schedules and receive only their exact-owner inbox. */
export default function piScheduleExtension(pi: ExtensionAPI): void {
  if (process.env["PI_SCHEDULE_WORKER_CHILD"] === "1") return;
  const client = new SchedulerClient();
  new OwnerReceiver(pi, client.control).attach();
  registerScheduleTool(pi, client);
}
