import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applicationReceiptSchema, type ApplicationReceipt } from "./outcome.js";

export function registerOutcomeTool(pi: ExtensionAPI,
  save: (receipt: ApplicationReceipt, ctx: ExtensionContext) => void): void {
  pi.registerTool({
    name: "schedule_outcome", label: "Schedule outcome",
    description: "Record the current scheduled run's application and notification outcomes. Set pauseAfterRun=true to pause this job at acknowledgement when human authorization or intervention is required. Report the blocker once, not on unchanged wakes. Not a certification of model judgments. Do not include reports, credentials or repository contents.",
    parameters: applicationReceiptSchema,
    async execute(_id, receipt, _signal, _update, ctx) {
      save(receipt, ctx);
      return { content: [{ type: "text", text: receipt.pauseAfterRun ? "Run-bound outcome recorded; schedule pause requested for acknowledgement" : "Run-bound outcome recorded" }], details: receipt, terminate: true };
    },
  });
}
