import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunLedger } from "../src/ledger.js";
import { parseSchedule } from "../src/schedule.js";
import { ScheduleStore, defaultPaths } from "../src/store.js";
import { createPromptExecutor, parseWorkerArgs, runProcess, runWorker } from "../src/worker.js";
import workerGuard from "../src/worker-guard.js";
import extension from "../src/extension.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "schedule-worker-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const store = new ScheduleStore(defaultPaths(join(root, "home")));
  const create = (over = {}) => store.create({
    name: "background review", prompt: "review only", schedule: parseSchedule("once 30s"),
    scope: "global", target: "background", executionCwd: cwd,
    now: new Date("2025-01-01T00:00:00Z"), ...over,
  });
  const now = () => new Date("2025-01-01T00:01:00Z");
  return { root, cwd, store, create, now };
}

describe("background worker", () => {
  it("executes independent jobs only and records a completed result", async () => {
    const f = fixture();
    const background = f.create();
    const session = f.create({ target: "session", ownerSessionId: "owner" });
    const legacy = f.create({ target: undefined });
    const runPrompt = vi.fn(async () => "background completed; logs: test");
    const result = await runWorker({ ...f, runPrompt });
    expect(result).toHaveLength(1);
    expect(runPrompt).toHaveBeenCalledOnce();
    expect(runPrompt.mock.calls[0]).toBeDefined();
    expect(f.store.get(background.id, f.cwd)).toMatchObject({ lastStatus: "ok", terminated: "once" });
    for (const job of [session, legacy]) expect(f.store.get(job.id, f.cwd)?.runCount).toBe(0);
    expect(new RunLedger(f.store.pathsInfo().runsFile).history()[0]?.detail).toContain("background completed");
  });

  it("does not consume project job files without explicit admission", async () => {
    const f = fixture();
    f.create(); // Same workspace as the project job; not an implicit admission.
    const project = f.create({ scope: "project", projectPath: f.cwd });
    const runPrompt = vi.fn(async () => "completed");
    await runWorker({ ...f, runPrompt });
    expect(f.store.get(project.id, f.cwd)?.runCount).toBe(0);
    await runWorker({ ...f, runPrompt, projects: [f.cwd] });
    expect(f.store.get(project.id, f.cwd)?.runCount).toBe(1);
  });

  it("cannot relabel a project row as global to bypass admission", async () => {
    const f = fixture();
    f.create();
    const project = f.create({ scope: "project", projectPath: f.cwd });
    const file = f.store.projectPath(f.cwd);
    const rows = JSON.parse(readFileSync(file, "utf8"));
    rows.jobs[0].scope = "global";
    writeFileSync(file, JSON.stringify(rows));
    await runWorker({ ...f, runPrompt: async () => "completed" });
    expect(f.store.get(project.id, f.cwd)?.runCount).toBe(0);
  });

  it("records worker errors without claiming successful completion", async () => {
    const f = fixture();
    const job = f.create();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runWorker({ ...f, runPrompt: async () => { throw new Error("headless failed"); } });
    expect(f.store.get(job.id, f.cwd)).toMatchObject({ lastStatus: "error", lastError: "headless failed" });
    vi.restoreAllMocks();
  });

  it("rejects forced session-owned jobs", async () => {
    const f = fixture();
    const job = f.create({ target: "session", ownerSessionId: "owner" });
    await expect(runWorker({ ...f, projects: [f.cwd], jobId: job.id })).rejects.toThrow("No eligible background job");
  });

  it("runs shell failures and their follow-up only in the worker", async () => {
    const f = fixture();
    const job = f.create({ action: "shell", command: "check", wakeOn: "failure", failurePrompt: "inspect failure", tier: "mutate" });
    const runPrompt = vi.fn(async () => "background completed");
    const exec = vi.fn(async () => ({ code: 1, killed: false, stdout: "", stderr: "failed" }));
    await runWorker({ ...f, exec, runPrompt });
    expect(exec).toHaveBeenCalledWith(expect.any(String), ["-lc", "check"], expect.objectContaining({ cwd: f.cwd }));
    expect(runPrompt).toHaveBeenCalledWith(expect.stringContaining("inspect failure"), expect.objectContaining({ id: job.id }), expect.any(String));
  });

  it("creates fresh session storage and strips inherited controller identity", async () => {
    const f = fixture();
    const job = f.create();
    vi.stubEnv("PI_SESSION_ID", "controller");
    vi.stubEnv("PI_SESSION_FILE", "/private/controller.jsonl");
    const processRunner = vi.fn(async () => ({ code: 0, killed: false, stdout: "ok", stderr: "" }));
    const run = createPromptExecutor({ resultsDir: f.root, piCommand: "/bin/pi", processRunner });
    await run("first", job, "run-1");
    await run("second", job, "run-2");
    expect(processRunner).toHaveBeenNthCalledWith(1, "/bin/pi", ["--print", "--session-dir", join(f.root, "run-1", "sessions"), "--extension", expect.stringContaining("worker-guard.ts")], expect.objectContaining({ cwd: f.cwd, input: "first", env: expect.objectContaining({ PI_SCHEDULE_WORKER_CHILD: "1", PI_SCHEDULE_WORKER_TIER: "read_only" }) }));
    const calls = processRunner.mock.calls as unknown as [string, string[], { env: NodeJS.ProcessEnv }][];
    expect(calls[0]?.[2].env.PI_SESSION_ID).toBeUndefined();
    expect(calls[0]?.[2].env.PI_SESSION_FILE).toBeUndefined();
    expect(calls[1]?.[1]).toContain(join(f.root, "run-2", "sessions"));
    expect(JSON.parse(readFileSync(join(f.root, "run-1", "result.json"), "utf8")).status).toBe("completed");
  });

  it("reports nonzero headless exit with durable error metadata", async () => {
    const f = fixture();
    const run = createPromptExecutor({ resultsDir: f.root, processRunner: async () => ({ code: 1, killed: false, stdout: "", stderr: "failed" }) });
    await expect(run("p", f.create(), "failed")).rejects.toThrow("exit=1");
    expect(JSON.parse(readFileSync(join(f.root, "failed", "result.json"), "utf8")).status).toBe("error");
  });

  it("executes real subprocesses and bounds hanging processes", async () => {
    const f = fixture();
    expect(await runProcess(process.execPath, ["-e", "process.stdout.write('isolated')"], { cwd: f.cwd, timeoutMs: 1_000 })).toMatchObject({ code: 0, stdout: "isolated", killed: false });
    expect(await runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.cwd, timeoutMs: 50 })).toMatchObject({ killed: true });
  });

  it("enforces the tier in children without starting another schedule scanner", async () => {
    vi.stubEnv("PI_SCHEDULE_WORKER_CHILD", "1");
    vi.stubEnv("PI_SCHEDULE_WORKER_TIER", "read_only");
    const handlers = new Map<string, Function>();
    const registerTool = vi.fn();
    const pi = { on: (name: string, fn: Function) => handlers.set(name, fn), registerTool } as unknown as ExtensionAPI;
    extension(pi);
    expect(handlers.size).toBe(0);
    expect(registerTool).not.toHaveBeenCalled();
    workerGuard(pi);
    handlers.get("before_agent_start")!();
    expect(await handlers.get("tool_call")!({ toolName: "bash" })).toMatchObject({ block: true });
    expect(handlers.has("session_start")).toBe(false);
  });

  it("propagates automatic scan errors instead of reporting an empty success", async () => {
    const f = fixture();
    f.create();
    vi.spyOn(f.store, "dueJobs").mockImplementation(() => { throw new Error("scan failed"); });
    await expect(runWorker({ ...f, runPrompt: async () => "completed" })).rejects.toThrow("scan failed");
  });

  it("stops starting jobs after shutdown is requested", async () => {
    const f = fixture();
    f.create();
    const second = f.create();
    const controller = new AbortController();
    const runPrompt = vi.fn(async () => { controller.abort(); return "completed"; });
    await expect(runWorker({ ...f, signal: controller.signal, runPrompt })).rejects.toThrow("worker stopped");
    expect(runPrompt).toHaveBeenCalledOnce();
    expect(f.store.get(second.id, f.cwd)?.runCount).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("cleans descendants when their parent exits successfully", async () => {
    const f = fixture();
    const source = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); c.unref();";
    const result = await runProcess(process.execPath, ["-e", source], { cwd: f.cwd, timeoutMs: 1_000 });
    expect(result.code).toBe(0);
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      try {
        expect(readFileSync(`/proc/${pid}/status`, "utf8")).toMatch(/State:\s+Z/);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }, { timeout: 1_000, interval: 10 });
  });

  it("validates worker arguments", () => {
    expect(parseWorkerArgs(["--project", "/tmp/project", "--job", "abc"])).toEqual({ projects: ["/tmp/project"], jobId: "abc" });
    expect(() => parseWorkerArgs(["--job"])).toThrow("Missing value");
    expect(() => parseWorkerArgs(["--unknown", "value"])).toThrow("Unknown argument");
  });
});
