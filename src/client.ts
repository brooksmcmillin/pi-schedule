import { outcomeSummary } from "./outcome.js";
import { BUILD_ID } from "./build.js";
import { homedir } from "node:os";
import { AuthorityClient } from "./authority-protocol.js";
import { AuthorityStore } from "./authority-store.js";
import { AuthorityError, validateState, type AuthorityJob, type AuthorityState } from "./authority-types.js";
import { DEFAULT_MISSED_WINDOW, DEFAULT_TIER } from "./policy.js";
import { defaultPaths } from "./store.js";
import type { ScheduleToolStore } from "./tool.js";
import type { CreateJobInput } from "./types.js";

/** Clients may read persisted authority while offline, but never write it. */
export class SchedulerClient implements ScheduleToolStore {
  readonly control: AuthorityClient;
  status = "Dispatcher not checked";
  constructor(private readonly home: string = homedir()) {
    this.control = new AuthorityClient(home, BUILD_ID);
  }
  pathsInfo() { return defaultPaths(this.home); }

  async snapshot(): Promise<AuthorityState> {
    try {
      const raw = await this.control.request({ op: "snapshot" }) as AuthorityState & { dispatcher?: { error?: string } };
      if (!raw.dispatcher) throw new AuthorityError("VERSION_MISMATCH", "Authority lacks dispatcher support. Upgrade and restart dispatcher; no scheduling fallback");
      const { dispatcher, ...state } = raw;
      validateState(state);
      this.status = dispatcher.error ? `Dispatcher error: ${dispatcher.error}` : "Dispatcher online";
      return state;
    } catch (error) {
      this.status = `Dispatcher unavailable/incompatible: ${String(error)}. Read-only persisted view; jobs remain pending. Start/check dispatcher and reload clients.`;
      try {
        const store = new AuthorityStore(this.home, true);
        try { return store.snapshot(); } finally { store.close(); }
      } catch (readError) {
        throw new AuthorityError("OFFLINE_READ_FAILED", `${this.status} Persisted state unavailable: ${String(readError)}`);
      }
    }
  }

  async create(input: CreateJobInput): Promise<AuthorityJob> {
    if (!input.target || !input.executionCwd || (input.target === "session" && !input.ownerSessionId)) {
      throw new AuthorityError("INVALID_JOB", "Explicit execution target, workspace and session owner required");
    }
    const { now: _now, ...definition } = input;
    return await this.control.request({ op: "create_job", definition: {
      ...definition, target: input.target, executionCwd: input.executionCwd,
      name: input.name.trim(), prompt: input.prompt ?? "", action: input.action ?? "prompt",
      missedWindow: input.missedWindow ?? DEFAULT_MISSED_WINDOW, tier: input.tier ?? DEFAULT_TIER,
    } }) as AuthorityJob;
  }

  async listForCwd(cwd: string) {
    const state = await this.snapshot();
    const jobs = state.jobs.map(({ job }) => job).filter((job) => !job.cancelled && (job.scope === "global" || job.projectPath === cwd));
    const due = jobs.filter((job) => job.manualRequested || (job.enabled && Date.parse(job.nextRunAt) <= Date.now()));
    const active = state.runs.filter((run) => run.state === "claimed" || run.state === "started");
    this.status += `; pending/due: ${due.map((job) => `${job.id} (${active.some((run) => run.jobId === job.id) ? "active or ambiguous execution — inspect history" : job.target === "session" ? "waiting for exact idle owner" : "waiting for dispatcher"})`).join(", ") || "none"}`;
    return jobs;
  }
  async get(id: string, cwd: string) { return (await this.listForCwd(cwd)).find((job) => job.id === id); }
  async remove(id: string, cwd: string) {
    return await this.control.request({ op: "edit_job", jobId: id, cwd, action: "cancel" }) as AuthorityJob;
  }
  async setEnabled(id: string, cwd: string, enabled: boolean) {
    return await this.control.request({ op: "edit_job", jobId: id, cwd, action: enabled ? "enable" : "disable" }) as AuthorityJob;
  }
  async runNow(id: string, cwd: string, requesterSessionId?: string) {
    // Never use an offline snapshot to authorize execution: the dispatcher rechecks
    // the captured slot, current enabled state and durable claim in one handler.
    const job = await this.get(id, cwd);
    if (!job) throw new AuthorityError("JOB_NOT_FOUND", `Unknown job ${id}`);
    return this.control.request({ op: "run_now", jobId: id, cwd, nextRunAt: job.nextRunAt, requesterSessionId });
  }
  async history(id?: string, limit = 10) {
    const state = await this.snapshot();
    return { dispatcherStatus: this.status, runs: state.runs.filter((run) => !id || run.jobId === id).slice(-Math.min(Math.max(limit, 1), 50)).reverse().map((run) => ({ ...run, outcomeSummary: outcomeSummary(run) })) };
  }
}
