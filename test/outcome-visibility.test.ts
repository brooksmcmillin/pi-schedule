import { createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, ToolExecutionComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";
import { SchedulerClient } from "../src/client.js";
import { OwnerReceiver } from "../src/receiver.js";
import workerGuard from "../src/worker-guard.js";

// Real session/tool/rendering and socket/store boundaries; only the model is scripted.
describe("visible terminating owner outcomes", () => {
  it.each([
    ["partial", "sent", "One check remains", "Fixture input missing", "Supply the fixture input"],
    ["blocked_before_scan", "not_required", "Scan not started", "Needs owner authorization", "Obtain authorization"],
    ["succeeded", "not_required", "Fixture checks complete", "none", "No further action"],
    ["succeeded", "failed", "Fixture checks complete", "Notification rejected", "Inspect notification failure before retry"],
    ["unverified", "unverified", "No work summary provided.", "Not provided.", "Not provided; inspect this run before continuing."],
    ["failed", "unverified", "No work summary provided.", "Not provided.", "Not provided; inspect this run before continuing."],
  ])("retains %s/%s handoff without a post-tool model turn", async (application, notification, summary, blocker, nextAction) => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in unpaid fixture"));
    const home = mkdtempSync(join(tmpdir(), "pi-visible-outcome-"));
    let receiver: OwnerReceiver | undefined;
    let ctx: ExtensionContext | undefined;
    const dispatcher = new Dispatcher({ home, now: () => new Date("2026-11-16T00:00:00Z") });
    const manager = SessionManager.create(home, join(home, "sessions"));
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: home, agentDir: join(home, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        receiver = new OwnerReceiver(pi, new SchedulerClient(home).control, 60000);
        receiver.attach();
        pi.on("session_start", (_event, context) => { ctx = context; });
      }],
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
    await runtime.setRuntimeApiKey("anthropic", "synthetic-unpaid-fixture");
    const { session } = await createAgentSession({ cwd: home, agentDir: join(home, "agent"), modelRuntime: runtime,
      model: getModel("anthropic", "claude-sonnet-4-5"), thinkingLevel: "off", resourceLoader: loader,
      sessionManager: manager, settingsManager: settings, tools: ["schedule_outcome"],
    });
    try {
      await dispatcher.start();
      await session.bindExtensions({});
      const client = new SchedulerClient(home);
      const job = await client.create({ name: "synthetic visible handoff", prompt: "Run the synthetic fixture only",
        action: "prompt", target: "session", ownerSessionId: manager.getSessionId(), executionCwd: home,
        scope: "global", tier: "read_only", missedWindow: "catch_up_one",
        schedule: { type: "once", delayMs: 1000, delay: "1s" } });
      dispatcher.store.updateJob(job.id, (value) => { value.nextRunAt = "2026-11-15T00:00:00Z"; });
      const stream = vi.fn(() => {
        const run = dispatcher.store.snapshot().runs[0]!;
        const message = { role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
          content: [{ type: "toolCall", id: "outcome-call", name: "schedule_outcome", arguments: {
            version: 1, runId: run.runId, jobId: job.id, application, notification,
            ...(application === "unverified" ? {} : { handoff: application === "failed"
              ? { summary: " \n\t", blocker: "\t ", nextAction: "\n " } : { summary, blocker, nextAction } }),
          } }], stopReason: "toolUse", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const events = createAssistantMessageEventStream();
        events.push({ type: "done", reason: "toolUse", message } as never);
        events.end();
        return events;
      });
      vi.spyOn(runtime, "streamSimple").mockImplementation(stream as unknown as typeof runtime.streamSimple);
      await receiver!.poll(ctx!);
      await vi.waitFor(() => expect(dispatcher.store.snapshot().runs[0]?.state).toBe("completed"));
      expect(stream).toHaveBeenCalledOnce();
      const result = session.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ toolName: "schedule_outcome", isError: false });
      const persisted = SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages;
      const restored = persisted.find((message) => message.role === "toolResult");
      expect(restored).toMatchObject({ content: result!.content, details: result!.details, isError: false });
      initTheme("dark");
      const definition = session.getToolDefinition("schedule_outcome");
      const row = new ToolExecutionComponent("schedule_outcome", "outcome-call", {}, {}, definition,
        { requestRender: () => {} } as never, home);
      row.updateResult(restored as never);
      // Exercise Pi's real default collapsed rendering, not just the prompt or raw receipt.
      for (const width of [40, 100]) {
        const visible = row.render(width).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
        // Wrapping may split words, so compare after removing presentation whitespace.
        for (const text of [application, summary, blocker, nextAction, `External notification: ${notification}`, "not a chat reply"]) {
          expect(visible.replace(/\s/g, "")).toContain(text.replace(/\s/g, ""));
        }
      }
      const run = dispatcher.store.snapshot().runs[0]!;
      expect(run.receipt).toMatchObject({ application, notification, runId: run.runId, jobId: job.id });
      expect(run.receipt).not.toHaveProperty("handoff");
      await receiver!.poll(ctx!);
      expect(dispatcher.store.snapshot().runs).toHaveLength(1);
      expect(dispatcher.store.snapshot().jobs[0]?.job.runCount).toBe(1);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await receiver?.stop();
      session.dispose();
      vi.restoreAllMocks();
      await dispatcher.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("background tool saves only classifications and never copies a private handoff into output/history", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-private-outcome-"));
    const path = join(home, "application.json");
    vi.stubEnv("PI_SCHEDULE_WORKER_CHILD", "1");
    vi.stubEnv("PI_SCHEDULE_WORKER_TIER", "read_only");
    vi.stubEnv("PI_SCHEDULE_RUN_ID", "run");
    vi.stubEnv("PI_SCHEDULE_JOB_ID", "job");
    vi.stubEnv("PI_SCHEDULE_RECEIPT_PATH", path);
    let tool: any;
    try {
      workerGuard({ registerTool: (value: unknown) => { tool = value; }, on: () => {} } as never);
      const result = await tool.execute("id", { version: 1, runId: "run", jobId: "job", application: "partial", notification: "failed",
        handoff: { summary: "PRIVATE REPORT", blocker: "PRIVATE BLOCKER", nextAction: "PRIVATE ACTION" } }, undefined, undefined, {});
      expect(result.terminate).toBe(true);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(readFileSync(path, "utf8")).not.toContain("PRIVATE");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(result.details);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
