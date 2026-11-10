import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSchedule } from "../src/schedule.js";
import { ScheduleStore, defaultPaths } from "../src/store.js";
import { createPromptExecutor, parseWorkerArgs, runProcess, runWorker } from "../src/worker.js";
import workerGuard from "../src/worker-guard.js";
import extension from "../src/extension.js";
import { Dispatcher } from "../src/dispatcher.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "schedule-worker-")); roots.push(root);
  const cwd = join(root, "workspace"); mkdirSync(cwd);
  const store = new ScheduleStore(defaultPaths(join(root, "home")));
  const create = () => store.create({ name: "background review", prompt: "review only", schedule: parseSchedule("once 30s"),
    scope: "global", target: "background", executionCwd: cwd, now: new Date("2025-01-01T00:00:00Z") });
  return { root, cwd, store, create };
}

describe("background executor and dispatcher trigger", () => {
  it("only requests dispatcher arbitration and refuses legacy project discovery", async () => {
    const f = fixture();
    const dispatcher = new Dispatcher({ home: f.root });
    try {
      await dispatcher.start();
      expect(await runWorker({ home: f.root })).toEqual({ status: "scanned" });
      await expect(runWorker({ home: f.root, projects: [f.cwd] })).rejects.toThrow(/retired/);
    } finally { await dispatcher.close(); }
  });

  it("does not execute legacy jobs when dispatcher is absent", async () => {
    const f = fixture(), job = f.create();
    await expect(runWorker({ home: f.root })).rejects.toThrow(/unavailable/);
    expect(f.store.get(job.id, f.cwd)?.runCount).toBe(0);
  });

  it("creates fresh session storage and strips inherited controller identity", async () => {
    const f = fixture(), job = f.create();
    vi.stubEnv("PI_SESSION_ID", "controller"); vi.stubEnv("PI_SESSION_FILE", "/private/controller.jsonl");
    const processRunner = vi.fn(async () => ({ code: 0, killed: false, stdout: "ok", stderr: "" }));
    const run = createPromptExecutor({ resultsDir: f.root, piCommand: "/bin/pi", processRunner });
    await run("first", job, "run-1"); await run("second", job, "run-2");
    expect(processRunner).toHaveBeenNthCalledWith(1, "/bin/pi", ["--print", "--session-dir", join(f.root, "run-1", "sessions"), "--extension", expect.stringContaining("worker-guard.ts")], expect.objectContaining({ cwd: f.cwd, input: "first", env: expect.objectContaining({ PI_SCHEDULE_WORKER_CHILD: "1", PI_SCHEDULE_WORKER_TIER: "read_only" }) }));
    const calls = processRunner.mock.calls as unknown as [string, string[], { env: NodeJS.ProcessEnv }][];
    expect(calls[0]?.[2].env.PI_SESSION_ID).toBeUndefined(); expect(calls[0]?.[2].env.PI_SESSION_FILE).toBeUndefined();
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

  it("enforces tier in children without starting a schedule client or scanner", async () => {
    vi.stubEnv("PI_SCHEDULE_WORKER_CHILD", "1"); vi.stubEnv("PI_SCHEDULE_WORKER_TIER", "read_only");
    const handlers = new Map<string, Function>(), registerTool = vi.fn();
    const pi = { on: (name: string, fn: Function) => handlers.set(name, fn), registerTool } as unknown as ExtensionAPI;
    extension(pi); expect(handlers.size).toBe(0); expect(registerTool).not.toHaveBeenCalled();
    workerGuard(pi); handlers.get("before_agent_start")!();
    expect(await handlers.get("tool_call")!({ toolName: "bash" })).toMatchObject({ block: true });
    expect(handlers.has("session_start")).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("cleans descendants when their parent exits successfully", async () => {
    const f = fixture();
    const source = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); c.unref();";
    const result = await runProcess(process.execPath, ["-e", source], { cwd: f.cwd, timeoutMs: 1_000 });
    expect(result.code).toBe(0); const pid = Number(result.stdout.trim()); expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      try { expect(readFileSync(`/proc/${pid}/status`, "utf8")).toMatch(/State:\s+Z/); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }, { timeout: 1_000, interval: 10 });
  });

  it("validates worker arguments", () => {
    expect(parseWorkerArgs(["--project", "/tmp/project", "--job", "abc"])).toEqual({ projects: ["/tmp/project"], jobId: "abc" });
    expect(() => parseWorkerArgs(["--job"])).toThrow("Missing value");
    expect(() => parseWorkerArgs(["--unknown", "value"])).toThrow("Unknown argument");
  });
});
