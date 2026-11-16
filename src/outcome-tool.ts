import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applicationReceiptSchema, type ApplicationReceipt } from "./outcome.js";

const outcomeToolSchema = Type.Object({
  ...applicationReceiptSchema.properties,
  handoff: Type.Optional(Type.Object({
    summary: Type.String({ minLength: 1, maxLength: 300 }),
    blocker: Type.String({ minLength: 1, maxLength: 200 }),
    nextAction: Type.String({ minLength: 1, maxLength: 300 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export function registerOutcomeTool(pi: ExtensionAPI,
  save: (receipt: ApplicationReceipt, ctx: ExtensionContext) => void,
  ownerSession = false): void {
  pi.registerTool({
    name: "schedule_outcome", label: "Schedule outcome",
    description: "Record the current scheduled run's application and notification outcomes and end this turn. For owner-session work, supply a concise sanitized handoff (summary, blocker or 'none', nextAction). It is displayed at this tool boundary; no later reply is assumed. Set pauseAfterRun=true to pause this job at acknowledgement when human authorization or intervention is required. Not a certification of model judgments. Do not include private reports, credentials or repository contents.",
    parameters: outcomeToolSchema,
    async execute(_id, { handoff, ...receipt }, _signal, _update, ctx) {
      save(receipt, ctx);
      const recorded = receipt.pauseAfterRun ? "Run-bound outcome recorded; schedule pause requested for acknowledgement" : "Run-bound outcome recorded";
      // Keep owner handoffs in the visible transcript, never in general scheduler history.
      const text = ownerSession ? [
        `Scheduled outcome: ${receipt.application}`,
        `Summary: ${handoff?.summary.trim() || "No work summary provided."}`,
        `Blocker: ${handoff?.blocker.trim() || "Not provided."}`,
        `Next action: ${handoff?.nextAction.trim() || "Not provided; inspect this run before continuing."}`,
        `External notification: ${receipt.notification} (not a chat reply). ${recorded}.`,
      ].join("\n") : recorded;
      return { content: [{ type: "text", text }], details: receipt, terminate: true };
    },
  });
}
