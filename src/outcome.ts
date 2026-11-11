import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Only bounded classifications enter general history; reports and credentials stay private. */
export const applicationReceiptSchema = Type.Object({
  version: Type.Literal(1),
  pauseAfterRun: Type.Optional(Type.Boolean({ description: "Disable this job's automatic schedule when this run is acknowledged; resume explicitly with schedule enable." })),
  runId: Type.String({ minLength: 1 }),
  jobId: Type.String({ minLength: 1 }),
  application: Type.Union([
    Type.Literal("succeeded"), Type.Literal("no_candidates"), Type.Literal("escalated"),
    Type.Literal("blocked_before_scan"), Type.Literal("partial"), Type.Literal("failed"), Type.Literal("unverified"),
  ]),
  notification: Type.Union([
    Type.Literal("sent"), Type.Literal("not_required"), Type.Literal("failed"), Type.Literal("unverified"),
  ]),
}, { additionalProperties: false });
export type ApplicationReceipt = Static<typeof applicationReceiptSchema>;
export interface ExecutionResult {
  detail?: string;
  receipt?: unknown;
  receiptInvalid?: boolean;
  processExit?: { code: number; killed: boolean };
}

export class ExecutionFailure extends Error {
  constructor(message: string, public readonly result: ExecutionResult) { super(message); }
}

export function boundReceipt(value: unknown, runId: string, jobId: string): ApplicationReceipt | undefined {
  if (!Value.Check(applicationReceiptSchema, value) || value.runId !== runId || value.jobId !== jobId) return;
  return structuredClone(value);
}

export function applicationSucceeded(receipt: ApplicationReceipt | undefined): boolean {
  return receipt !== undefined && ["succeeded", "no_candidates", "escalated"].includes(receipt.application);
}

export function outcomeSummary(run: {
  state: string; uncertainty?: string; receipt?: ApplicationReceipt; receiptInvalid?: boolean;
}): string {
  const execution = run.uncertainty ? "unknown (reconciliation required)" : run.state;
  return `execution-${execution}; outcome-${run.receipt?.application ?? "unverified"}; notification-${run.receipt?.notification ?? "unverified"}${run.receiptInvalid ? "; invalid/mismatched receipt" : ""}`;
}
