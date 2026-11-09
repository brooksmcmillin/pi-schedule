import { isAbsolute } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ScheduledJob } from "./types.js";

export const AUTHORITY_SCHEMA_VERSION = 1;
export const AUTHORITY_PROTOCOL_VERSION = 1;

export class AuthorityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AuthorityError";
  }
}

export interface AuthorityJob extends ScheduledJob {
  target: "session" | "background";
  executionCwd: string;
}

export interface RunFence {
  storeId: string;
  jobId: string;
  slotId: string;
  runId: string;
  generation: number;
  ownerId: string;
}

export type ExecutionState = "claimed" | "started" | "completed" | "failed" | "interrupted";

export interface AuthorityRun extends RunFence {
  state: ExecutionState;
  claimedAt: string;
  updatedAt: string;
  protocolVersion: number;
  buildId: string;
  detail?: string;
}

export interface AuthorityState {
  schemaVersion: number;
  storeId: string;
  jobs: { job: AuthorityJob; generation: number }[];
  runs: AuthorityRun[];
}

const text = Type.String({ minLength: 1 });
const iso = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T" });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const optionalText = Type.Optional(Type.String());
const nullableIso = Type.Union([iso, Type.Null()]);
const shell = Type.Object({
  ok: Type.Boolean(), command: Type.String(), cwd: text, timeoutMs: positive,
  code: Type.Integer(), killed: Type.Boolean(), stdout: Type.String(), stderr: Type.String(),
}, { additionalProperties: false });

export const authorityJobSchema = Type.Object({
  id: text, name: text, prompt: Type.String(),
  target: Type.Union([Type.Literal("session"), Type.Literal("background")]),
  ownerSessionId: Type.Optional(text), executionCwd: text,
  action: Type.Union([Type.Literal("prompt"), Type.Literal("shell"), Type.Literal("notify"), Type.Literal("message")]),
  command: optionalText,
  wakeOn: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("failure"), Type.Literal("success"), Type.Literal("never")])),
  successPrompt: optionalText, failurePrompt: optionalText,
  timeoutMs: Type.Optional(positive), maxRuns: Type.Optional(positive),
  schedule: Type.Union([
    Type.Object({ type: Type.Literal("interval"), everyMs: positive, every: text }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal("daily"), hour: Type.Integer({ minimum: 0, maximum: 23 }), minute: Type.Integer({ minimum: 0, maximum: 59 }), at: text }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal("once"), delayMs: positive, delay: text }, { additionalProperties: false }),
  ]),
  scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
  projectPath: Type.Optional(text), enabled: Type.Boolean(),
  missedWindow: Type.Union([Type.Literal("catch_up_one"), Type.Literal("skip")]),
  tier: Type.Union([Type.Literal("read_only"), Type.Literal("suggest"), Type.Literal("mutate")]),
  terminated: Type.Optional(Type.Union([Type.Literal("maxRuns"), Type.Literal("once"), Type.Null()])),
  createdAt: iso, updatedAt: iso, lastRunAt: nullableIso, nextRunAt: iso,
  runCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  lastStatus: Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("skipped"), Type.Literal("locked"), Type.Null()]),
  lastError: optionalText, lastIdempotencyKey: optionalText, lastShell: Type.Optional(shell),
}, { additionalProperties: false });

export const fenceSchema = Type.Object({
  storeId: text, jobId: text, slotId: text, runId: text, generation: positive, ownerId: text,
}, { additionalProperties: false });

const runSchema = Type.Object({
  ...fenceSchema.properties,
  state: Type.Union([Type.Literal("claimed"), Type.Literal("started"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("interrupted")]),
  claimedAt: iso, updatedAt: iso, protocolVersion: Type.Literal(AUTHORITY_PROTOCOL_VERSION), buildId: text,
  detail: optionalText,
}, { additionalProperties: false });

const stateSchema = Type.Object({
  schemaVersion: Type.Literal(AUTHORITY_SCHEMA_VERSION), storeId: text,
  jobs: Type.Array(Type.Object({ job: authorityJobSchema, generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false })),
  runs: Type.Array(runSchema),
}, { additionalProperties: false });

export function requireText(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new AuthorityError("INVALID_REQUEST", `${label} must be nonempty`);
}

export function requireTimestamp(value: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new AuthorityError("INVALID_REQUEST", "Expected an ISO timestamp");
  }
}

export function validateJob(value: unknown): asserts value is AuthorityJob {
  if (!Value.Check(authorityJobSchema, value)) throw new AuthorityError("INVALID_JOB", "Invalid authoritative job; preserve all schedule fields and supply explicit target, workspace and session owner");
  const job = value as AuthorityJob;
  if (!isAbsolute(job.executionCwd) || (job.scope === "project" && (!job.projectPath || !isAbsolute(job.projectPath))) ||
      (job.target === "session" ? !job.ownerSessionId?.trim() : job.ownerSessionId !== undefined)) {
    throw new AuthorityError("INVALID_JOB", "Use an absolute workspace/project path and an owner only for session targets");
  }
  for (const at of [job.createdAt, job.updatedAt, job.nextRunAt, job.lastRunAt]) if (at !== null) requireTimestamp(at);
  if (job.action === "shell" && (!job.command?.trim() || job.tier !== "mutate")) throw new AuthorityError("INVALID_JOB", "Shell jobs require a command and mutate tier");
}

export function validateState(value: unknown): asserts value is AuthorityState {
  if (!value || typeof value !== "object" || (value as AuthorityState).schemaVersion !== AUTHORITY_SCHEMA_VERSION) {
    throw new AuthorityError("SCHEMA_MISMATCH", `Unsupported authority schema; expected ${AUTHORITY_SCHEMA_VERSION}. Upgrade pi-schedule or restore a compatible backup; state was not changed.`);
  }
  if (!Value.Check(stateSchema, value)) throw new AuthorityError("INVALID_STATE", "Invalid authority state. Restore a compatible backup; state was not changed.");
  const state = value as AuthorityState;
  const jobs = new Map(state.jobs.map((entry) => [entry.job.id, entry]));
  if (jobs.size !== state.jobs.length || new Set(state.runs.map((run) => run.runId)).size !== state.runs.length) throw new AuthorityError("INVALID_STATE", "Duplicate job/run identity");
  for (const entry of state.jobs) validateJob(entry.job);
  const activeJobs = new Set<string>();
  for (const run of state.runs) {
    const entry = jobs.get(run.jobId);
    if (!entry || run.storeId !== state.storeId || run.generation > entry.generation) throw new AuthorityError("INVALID_STATE", "Inconsistent run fence");
    requireTimestamp(run.claimedAt);
    requireTimestamp(run.updatedAt);
    if (run.state === "claimed" || run.state === "started") {
      if (activeJobs.has(run.jobId) || run.generation !== entry.generation) throw new AuthorityError("INVALID_STATE", "Multiple or stale active claims");
      activeJobs.add(run.jobId);
    }
  }
}
