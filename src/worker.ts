import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ScheduleRunner } from "./runner.js";
import { ScheduleStore } from "./store.js";
import type { ScheduledJob } from "./types.js";

const GUARD = fileURLToPath(new URL("./worker-guard.ts", import.meta.url));
const RUN_TIMEOUT_MS = 10 * 60_000; // Below the job lock's 30-minute stale threshold.

export interface ProcessResult {
  code: number;
  killed: boolean;
  stdout: string;
  stderr: string;
}

/** One process group per run: timeout and service shutdown also stop descendants. */
export async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs: number; outputDir?: string },
): Promise<ProcessResult> {
  const files: number[] = [];
  try {
    if (options.outputDir) {
      files.push(openSync(join(options.outputDir, "stdout.log"), "w", 0o600));
      files.push(openSync(join(options.outputDir, "stderr.log"), "w", 0o600));
    }
    return await new Promise((resolveResult, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", files[0] ?? "pipe", files[1] ?? "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let killed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch { /* already exited */ }
      };
      const stop = () => {
        if (killed) return;
        killed = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), 5_000);
        killTimer.unref();
      };
      const timeout = setTimeout(stop, options.timeoutMs);
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      const cleanup = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        // A completed run must not leave descendants behind, even on success.
        killGroup("SIGKILL");
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
      };
      child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16_384); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
      child.once("exit", cleanup);
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("close", (code) => {
        cleanup();
        resolveResult({ code: code ?? 128, killed, stdout, stderr });
      });
      child.stdin?.on("error", () => { /* EPIPE: exit status is authoritative. */ });
      child.stdin?.end(options.input ?? "");
    });
  } finally {
    for (const fd of files) closeSync(fd);
  }
}

export interface PromptExecutorOptions {
  resultsDir: string;
  piCommand?: string;
  timeoutMs?: number;
  processRunner?: typeof runProcess;
}

export function createPromptExecutor(options: PromptExecutorOptions) {
  return async (body: string, job: ScheduledJob, runId: string): Promise<string> => {
    const directory = join(options.resultsDir, runId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    delete env["PI_SESSION_ID"];
    delete env["PI_SESSION_FILE"];
    env["PI_SCHEDULE_WORKER_CHILD"] = "1";
    env["PI_SCHEDULE_WORKER_TIER"] = job.tier;
    const metadata = { runId, jobId: job.id, cwd: job.executionCwd, target: "background", startedAt: new Date().toISOString() };
    const resultFile = join(directory, "result.json");
    const record = (data: Record<string, unknown>) => writeFileSync(resultFile, JSON.stringify({ ...metadata, ...data }, null, 2) + "\n", { mode: 0o600 });
    record({ status: "running" });
    try {
      const result = await (options.processRunner ?? runProcess)(options.piCommand ?? process.env["PI_SCHEDULE_PI"] ?? "pi", [
        "--print", "--session-dir", join(directory, "sessions"), "--extension", GUARD,
      ], {
        cwd: job.executionCwd!, env, input: body,
        timeoutMs: options.timeoutMs ?? RUN_TIMEOUT_MS, outputDir: directory,
      });
      if (result.code !== 0 || result.killed) throw new Error(`Headless Pi exit=${result.code} killed=${result.killed}; logs: ${directory}`);
      record({ status: "completed", endedAt: new Date().toISOString(), exitCode: result.code });
      return `background completed; logs: ${directory}`;
    } catch (error) {
      record({ status: "error", endedAt: new Date().toISOString(), error: String(error) });
      throw error;
    }
  };
}

export interface WorkerOptions {
  store?: ScheduleStore;
  projects?: string[];
  jobId?: string;
  now?: () => Date;
  signal?: AbortSignal;
  runPrompt?: (body: string, job: ScheduledJob, runId: string) => Promise<string>;
  exec?: ExtensionAPI["exec"];
}

/** A single bounded scan, suitable for a systemd timer or cron. No interactive API. */
export async function runWorker(options: WorkerOptions = {}): Promise<ScheduledJob[]> {
  const store = options.store ?? new ScheduleStore();
  const projects = (options.projects ?? []).map((path) => resolve(path));
  const workspaces = new Set([
    ...store.listGlobal().filter((job) => job.target === "background").map((job) => job.executionCwd),
    ...projects,
  ]);
  const runPrompt = options.runPrompt ?? createPromptExecutor({ resultsDir: join(store.pathsInfo().globalDir, "results") });
  const exec: ExtensionAPI["exec"] = options.exec ?? (async (command, args, opts) => runProcess(command, args, {
    cwd: opts?.cwd ?? process.cwd(), timeoutMs: opts?.timeout ?? RUN_TIMEOUT_MS,
  }));
  const pi = {
    exec,
    sendUserMessage: () => { throw new Error("Worker cannot inject into an interactive session"); },
  } as unknown as ExtensionAPI;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const signal = options.signal ?? controller.signal;
  const runner = new ScheduleRunner({ store, pi, background: true, backgroundProjects: projects, runPrompt, now: options.now, signal });
  const results: ScheduledJob[] = [];
  const failures: string[] = [];
  try {
    for (const cwd of workspaces) {
      if (signal.aborted) break;
      if (!cwd || !isAbsolute(cwd)) continue;
      try {
        if (!statSync(cwd).isDirectory()) throw new Error(`Worker workspace is not a directory: ${cwd}`);
        const ctx = { cwd, hasUI: false, isIdle: () => true } as ExtensionContext;
        results.push(...await runner.fireDue(ctx, {
          source: options.jobId ? "run_now" : "tick",
          jobIds: options.jobId ? [options.jobId] : undefined,
        }));
      } catch (error) {
        failures.push(`${cwd}: ${String(error)}`);
      }
    }
    if (signal.aborted) throw new Error("Background worker stopped; no further jobs started");
    if (failures.length) throw new Error(failures.join("\n"));
    if (options.jobId && !results.length) throw new Error("No eligible background job fired (wrong target, disabled, terminated, locked, or unavailable workspace)");
    return results;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

export function parseWorkerArgs(args: string[]): { projects: string[]; jobId?: string } {
  const result: { projects: string[]; jobId?: string } = { projects: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--project") result.projects.push(resolve(value));
    else if (arg === "--job") result.jobId = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const results = await runWorker(parseWorkerArgs(process.argv.slice(2)));
    console.log(JSON.stringify(results.map(({ id, lastStatus, lastError }) => ({ id, lastStatus, lastError }))));
    if (results.some((job) => job.lastStatus === "error")) process.exitCode = 1;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
