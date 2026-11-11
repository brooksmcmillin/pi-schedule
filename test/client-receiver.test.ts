import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulerClient } from "../src/client.js";
import { Dispatcher } from "../src/dispatcher.js";
import { OwnerReceiver } from "../src/receiver.js";
import { registerScheduleTool } from "../src/tool.js";
import type { JobAction, PrivilegeTier } from "../src/types.js";

const at = new Date("2026-11-09T00:00:00Z");
const roots: string[] = [], services: Dispatcher[] = [], receivers: OwnerReceiver[] = [];
afterEach(async () => {
  for (const receiver of receivers.splice(0)) await receiver.stop();
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pi-client-")); roots.push(home);
  let clock = new Date(at);
  const dispatcher = new Dispatcher({ home, now: () => new Date(clock), execute: async () => ({ detail: "background fixture" }) });
  services.push(dispatcher); await dispatcher.start();
  const client = new SchedulerClient(home);
  const create = async (action: JobAction = "prompt", tier: PrivilegeTier = "read_only", scope: "global" | "project" = "global") => {
    const job = await client.create({
    name: "owner action", prompt: "inspect", action, command: action === "shell" ? "check" : undefined,
    wakeOn: action === "shell" ? "failure" : undefined, failurePrompt: action === "shell" ? "inspect failure" : undefined,
    target: "session", ownerSessionId: "owner", executionCwd: "/workspace", scope,
    projectPath: scope === "project" ? "/workspace" : undefined, tier, missedWindow: "catch_up_one",
    schedule: { type: "once", delayMs: 1000, delay: "1s" },
    });
    clock = new Date(clock.getTime() + 1000);
    return job;
  };
  function receiver(sessionId = "owner", cwd = "/workspace", busy = false) {
    let idle = !busy;
    const hooks = new Map<string, Function[]>();
    const sendUserMessage = vi.fn((prompt: string) => {
      for (const hook of hooks.get("before_agent_start") ?? []) void hook({ prompt }, ctx);
    }), sendMessage = vi.fn(), notify = vi.fn(), setStatus = vi.fn();
    const exec = vi.fn(async () => ({ code: 1, killed: false, stdout: "", stderr: "fixture failure" }));
    const tools = new Map<string, any>();
    const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), on: (event: string, handler: Function) => hooks.set(event, [...hooks.get(event) ?? [], handler]), sendUserMessage, sendMessage, exec } as unknown as ExtensionAPI;
    const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => sessionId }, isIdle: () => idle,
      hasPendingMessages: () => false, ui: { notify, setStatus } } as unknown as ExtensionContext;
    const instance = new OwnerReceiver(pi, client.control); instance.attach(); receivers.push(instance);
    const settle = async (aborted = false) => {
      for (const hook of hooks.get("agent_settled") ?? []) await hook({ aborted }, ctx);
    };
    return { instance, ctx, hooks, tools, settle, sendUserMessage, sendMessage, notify, exec, setStatus, setIdle: (value: boolean) => { idle = value; } };
  }
  return { home, dispatcher, client, create, receiver };
}

describe("dispatcher clients and owner receiver", () => {
  it.each(["prompt", "shell", "notify", "message"] as const)("composes real socket/store and %s receiver without local schedule writes", async (action) => {
    const f = await fixture(); const job = await f.create(action, action === "shell" ? "mutate" : "read_only");
    const owner = f.receiver(), foreign = f.receiver("foreign"), wrongCwd = f.receiver("owner", "/elsewhere");
    for (const r of [foreign, wrongCwd]) await r.instance.poll(r.ctx);
    expect(f.dispatcher.store.snapshot().runs).toHaveLength(0);
    await owner.instance.poll(owner.ctx);
    if (action === "prompt" || action === "shell") {
      expect(f.dispatcher.store.snapshot().runs[0]).toMatchObject({ state: "started", handedOffAt: expect.any(String) });
      await owner.settle();
    }
    expect(f.dispatcher.store.snapshot().jobs[0]?.job).toMatchObject({ id: job.id, runCount: 1, terminated: "once", lastStatus: "ok" });
    expect(f.dispatcher.store.snapshot().runs[0]?.state).toBe("completed");
    expect(foreign.sendUserMessage).not.toHaveBeenCalled(); expect(wrongCwd.sendUserMessage).not.toHaveBeenCalled();
    if (action === "prompt" || action === "shell") expect(owner.sendUserMessage).toHaveBeenCalledOnce();
    else expect(owner.sendUserMessage).not.toHaveBeenCalled();
    if (action === "shell") {
      expect(owner.exec).toHaveBeenCalledWith(expect.any(String), ["-lc", "check"], expect.objectContaining({ cwd: "/workspace" }));
      expect(owner.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("inspect failure"));
      expect(f.dispatcher.store.snapshot().jobs[0]?.job.lastShell?.code).toBe(1);
    }
  });

  it("handoff remains active until settled; validates receipts and records aborts independently", async () => {
    const f = await fixture(); const job = await f.create(); const owner = f.receiver();
    await owner.instance.poll(owner.ctx);
    const run = f.dispatcher.store.snapshot().runs[0]!;
    expect(run.state).toBe("started");
    await owner.instance.poll(owner.ctx);
    expect(owner.sendUserMessage).toHaveBeenCalledOnce();
    const tool = owner.tools.get("schedule_outcome");
    const receipt = { version: 1, runId: run.runId, jobId: job.id, application: "blocked_before_scan", notification: "failed" };
    await expect(tool.execute("id", { ...receipt, runId: "stale" }, undefined, undefined, owner.ctx)).rejects.toThrow(/current scheduled run/);
    await tool.execute("id", receipt, undefined, undefined, owner.ctx);
    await owner.settle();
    expect(f.dispatcher.store.snapshot().runs[0]).toMatchObject({ state: "completed", receipt });
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.lastSuccessfulCompletionAt).toBeUndefined();
  });

  it("pauses a recurring blocked observer at settlement and prevents later wakes until enabled", async () => {
    const f = await fixture(); const job = await f.create();
    f.dispatcher.store.updateJob(job.id, (value) => {
      value.schedule = { type: "interval", everyMs: 60000, every: "1m" };
    });
    const owner = f.receiver();
    await owner.instance.poll(owner.ctx);
    const run = f.dispatcher.store.snapshot().runs[0]!;
    await expect(f.client.setEnabled(job.id, "/workspace", false)).rejects.toThrow(/active/);
    const receipt = { version: 1, runId: run.runId, jobId: job.id,
      application: "blocked_before_scan", notification: "sent", pauseAfterRun: true };
    await owner.tools.get("schedule_outcome").execute("pause", receipt, undefined, undefined, owner.ctx);
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.enabled).toBe(true);
    await owner.settle();
    expect(f.dispatcher.store.snapshot().jobs[0]?.job).toMatchObject({ enabled: false, runCount: 1 });
    expect(f.dispatcher.store.snapshot().runs[0]).toMatchObject({ state: "completed", receipt });
    // Make the next slot overdue without enabling it: repeated polling must remain quiet.
    f.dispatcher.store.updateJob(job.id, (value) => { value.nextRunAt = at.toISOString(); });
    for (let i = 0; i < 12; i++) await owner.instance.poll(owner.ctx);
    expect(owner.sendUserMessage).toHaveBeenCalledOnce();
    expect(f.dispatcher.store.snapshot().runs).toHaveLength(1);
    await f.client.setEnabled(job.id, "/workspace", true);
    await owner.instance.poll(owner.ctx);
    expect(owner.sendUserMessage).toHaveBeenCalledTimes(2);
    await owner.settle();
  });

  it("retains a succeeded receipt but records failed execution and no successful completion after abort", async () => {
    const f = await fixture(); const job = await f.create(); const owner = f.receiver();
    await owner.instance.poll(owner.ctx);
    const run = f.dispatcher.store.snapshot().runs[0]!;
    const receipt = { version: 1, runId: run.runId, jobId: job.id, application: "succeeded", notification: "sent" };
    await owner.tools.get("schedule_outcome").execute("receipt", receipt, undefined, undefined, owner.ctx);
    await owner.settle(true);
    expect(f.dispatcher.store.snapshot().runs[0]).toMatchObject({ state: "failed", receipt });
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.lastSuccessfulCompletionAt).toBeUndefined();
  });

  it("settling without a receipt remains unverified and aborted execution remains failed", async () => {
    const f = await fixture(); await f.create(); const owner = f.receiver();
    await owner.instance.poll(owner.ctx); await owner.settle(true);
    expect(f.dispatcher.store.snapshot().runs[0]).toMatchObject({ state: "failed" });
    expect(f.dispatcher.store.snapshot().runs[0]?.receipt).toBeUndefined();
  });

  it("ignores unrelated turn settlement while a scheduled shell awaits its own agent followup", async () => {
    const f = await fixture(); const job = await f.create("shell", "mutate"); const owner = f.receiver();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    owner.exec.mockImplementation(async () => { await paused; return { code: 1, killed: false, stdout: "", stderr: "fixture" }; });
    const running = owner.instance.poll(owner.ctx);
    await vi.waitFor(() => expect(owner.exec).toHaveBeenCalledOnce());
    for (const hook of owner.hooks.get("before_agent_start") ?? []) await hook({ prompt: "unrelated human request" }, owner.ctx);
    await owner.settle(true);
    release(); await running;
    const run = f.dispatcher.store.snapshot().runs[0]!;
    expect(run).toMatchObject({ state: "started", handedOffAt: expect.any(String) });
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.runCount).toBe(0);
    const receipt = { version: 1, runId: run.runId, jobId: job.id, application: "succeeded", notification: "sent" };
    await owner.tools.get("schedule_outcome").execute("receipt", receipt, undefined, undefined, owner.ctx);
    await owner.settle();
    expect(f.dispatcher.store.snapshot().runs[0]).toMatchObject({ state: "completed", receipt });
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.runCount).toBe(1);
  });

  it("does not follow up, acknowledge or replay a shell across shutdown and session replacement", async () => {
    const f = await fixture(); await f.create("shell", "mutate");
    const owner = f.receiver();
    let finish!: () => void;
    const paused = new Promise<void>((resolve) => { finish = resolve; });
    owner.exec.mockImplementation(async () => { await paused; return { code: 1, killed: false, stdout: "", stderr: "fixture failure" }; });
    const requests = vi.spyOn(f.client.control, "request");
    const running = owner.instance.poll(owner.ctx);
    await vi.waitFor(() => expect(owner.exec).toHaveBeenCalledOnce());
    expect(f.dispatcher.store.snapshot().runs[0]?.state).toBe("started");
    for (const hook of owner.hooks.get("session_shutdown") ?? []) await hook({ reason: "new" }, owner.ctx);
    const replacement = f.receiver("replacement");
    for (const hook of replacement.hooks.get("session_start") ?? []) await hook({ reason: "new" }, replacement.ctx);
    finish(); await running;
    await replacement.instance.poll(replacement.ctx);
    const resumed = f.receiver("owner"); await resumed.instance.poll(resumed.ctx);
    for (const receiver of [owner, replacement, resumed]) {
      expect(receiver.sendUserMessage).not.toHaveBeenCalled();
      expect(receiver.sendMessage).not.toHaveBeenCalled();
    }
    expect(requests.mock.calls.filter(([request]) => request.op === "finish_delivery")).toHaveLength(0);
    expect(f.dispatcher.store.snapshot().runs).toHaveLength(1);
    expect(f.dispatcher.store.snapshot().runs[0]?.state).toBe("started");
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.runCount).toBe(0);
    expect(resumed.exec).not.toHaveBeenCalled();
  });

  it("keeps a busy owner pending and safely defers the begin-response race", async () => {
    const f = await fixture(); await f.create(); const owner = f.receiver("owner", "/workspace", true);
    await owner.instance.poll(owner.ctx);
    expect(f.dispatcher.store.snapshot().runs).toHaveLength(0);
    owner.setIdle(true);
    const original = f.client.control.request.bind(f.client.control);
    vi.spyOn(f.client.control, "request").mockImplementation(async (request) => {
      const response = await original(request);
      if (request.op === "begin_delivery") owner.setIdle(false);
      return response;
    });
    await owner.instance.poll(owner.ctx);
    expect(owner.sendUserMessage).not.toHaveBeenCalled();
    expect(f.dispatcher.store.snapshot().runs[0]?.state).toBe("interrupted");
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.runCount).toBe(0);
    vi.restoreAllMocks(); owner.setIdle(true); await owner.instance.poll(owner.ctx);
    expect(owner.sendUserMessage).toHaveBeenCalledOnce();
  });

  it.each(["read_only", "suggest", "mutate"] as const)("preserves %s privilege hooks for a dispatcher-delivered prompt", async (tier) => {
    const f = await fixture(); await f.create("prompt", tier); const owner = f.receiver();
    await owner.instance.poll(owner.ctx);
    for (const hook of owner.hooks.get("before_agent_start") ?? []) await hook({}, owner.ctx);
    const result = await owner.hooks.get("tool_call")?.[0]?.({ toolName: "bash" }, owner.ctx);
    if (tier === "mutate") expect(result?.block).not.toBe(true);
    else expect(result).toMatchObject({ block: true });
  });

  it("arbitrates create/enable/disable/cancel/run-now and exposes scoped offline pending/history", async () => {
    const f = await fixture(); const job = await f.create("notify", "read_only", "project");
    expect(await f.client.listForCwd("/elsewhere")).toEqual([]);
    await f.client.setEnabled(job.id, "/workspace", false);
    expect(await f.client.runNow(job.id, "/workspace", "owner")).toMatchObject({ status: "pending" });
    expect(await f.client.listForCwd("/workspace")).toEqual([expect.objectContaining({ id: job.id, enabled: false, manualRequested: true })]);
    expect(f.client.status).toContain(`pending/due: ${job.id} (waiting for exact idle owner)`);
    await f.client.setEnabled(job.id, "/workspace", true);
    expect(await f.client.runNow(job.id, "/workspace", "owner")).toMatchObject({ status: "pending", reason: "waiting_for_exact_idle_owner" });
    const foreign = f.receiver("foreign"); await foreign.instance.poll(foreign.ctx);
    expect(f.dispatcher.store.snapshot().runs).toHaveLength(0);
    await f.dispatcher.close(); services.splice(services.indexOf(f.dispatcher), 1);
    expect(await f.client.listForCwd("/workspace")).toHaveLength(1);
    expect(f.client.status).toMatch(/Read-only persisted view.*pending/s);
    expect(await f.client.history()).toHaveProperty("runs");
    await expect(f.client.setEnabled(job.id, "/workspace", false)).rejects.toThrow(/unavailable/);
    const restarted = new Dispatcher({ home: f.home }); services.push(restarted); await restarted.start();
    await f.client.remove(job.id, "/workspace");
    expect(await f.client.listForCwd("/workspace")).toEqual([]);
  });

  it("requires exact requester session/workspace for manual session work", async () => {
    const f = await fixture(); const job = await f.create();
    for (const requester of [undefined, "foreign"]) {
      await expect(f.client.runNow(job.id, "/workspace", requester)).rejects.toThrow(/different session/);
    }
    await expect(f.client.runNow(job.id, "/elsewhere", "owner")).rejects.toThrow(/workspace/);
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.manualRequested).not.toBe(true);
    let tool: any;
    registerScheduleTool({ registerTool: (value: unknown) => { tool = value; } } as ExtensionAPI, f.client);
    const result = await tool.execute("id", { action: "run_now", id: job.id }, undefined, undefined,
      { cwd: "/workspace", sessionManager: { getSessionId: () => "owner" } });
    expect(result.details.result).toMatchObject({ status: "pending" });
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.manualRequested).toBe(true);
  });

  it("surfaces incompatible dispatcher status and never turns mutations into local writes", async () => {
    const f = await fixture(); await f.create();
    vi.spyOn(f.client.control, "request").mockRejectedValue(new Error("VERSION_MISMATCH"));
    expect(await f.client.listForCwd("/workspace")).toHaveLength(1);
    expect(f.client.status).toMatch(/incompatible/);
    await expect(f.client.remove("unknown", "/workspace")).rejects.toThrow("VERSION_MISMATCH");
    expect(f.dispatcher.store.snapshot().jobs).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("schedule tool reports unavailable writes visibly instead of leaking async rejections", async () => {
    const f = await fixture(); let tool: any;
    registerScheduleTool({ registerTool: (value: unknown) => { tool = value; } } as ExtensionAPI, f.client);
    await f.dispatcher.close(); services.splice(services.indexOf(f.dispatcher), 1);
    const result = await tool.execute("id", { action: "create", name: "test", prompt: "check", every: "1h" }, undefined, undefined,
      { cwd: "/workspace", sessionManager: { getSessionId: () => "owner" } });
    expect(result.details.error).toMatch(/unavailable/);
  });
});
