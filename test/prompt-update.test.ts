import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityStore } from "../src/authority-store.js";
import type { AuthorityJob } from "../src/authority-types.js";
import { SchedulerClient } from "../src/client.js";
import { Dispatcher, type Delivery } from "../src/dispatcher.js";
import { registerScheduleTool, type ScheduleToolStore } from "../src/tool.js";

const createdAt = "2026-11-09T00:00:00.000Z";
const updatedAt = "2026-11-10T00:00:00.000Z";
const nextRunAt = "2026-11-21T18:00:00.000Z";
const roots: string[] = [];
const services: Dispatcher[] = [];
const definition = (overrides: Partial<AuthorityJob> = {}): AuthorityJob => ({
  id: "finite-pilot", name: "report", prompt: "metadata only", target: "background",
  executionCwd: "/workspace", action: "prompt", tier: "mutate", scope: "global",
  schedule: { type: "interval", everyMs: 604800000, every: "7d" },
  maxRuns: 2, enabled: false, missedWindow: "catch_up_one", runCount: 0,
  createdAt, updatedAt: createdAt, nextRunAt, lastRunAt: null, lastStatus: null,
  ...overrides,
});
async function fixture(overrides: Partial<AuthorityJob> = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-prompt-update-"));
  roots.push(home);
  const execute = vi.fn(async (_delivery: Delivery) => ({ detail: "fixture" }));
  const dispatcher = new Dispatcher({ home, now: () => new Date(updatedAt), execute });
  services.push(dispatcher);
  dispatcher.store.addJob(definition(overrides));
  await dispatcher.start();
  return { home, dispatcher, execute, client: new SchedulerClient(home) };
}
function toolFor(store: ScheduleToolStore) {
  let tool: any;
  registerScheduleTool({ registerTool: (value: any) => { tool = value; } } as ExtensionAPI, store);
  return {
    schema: tool.parameters,
    execute: (params: Record<string, unknown>) => tool.execute("update", params, undefined, undefined,
      { cwd: "/workspace" } as ExtensionContext),
  };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("in-place prompt updates", () => {
  it("composes the tool, client, socket and store without resetting finite schedule or history", async () => {
    const f = await fixture();
    // Retain a real terminal attempt and its generation, not just empty history.
    const run = f.dispatcher.store.claim("finite-pilot", "earlier-slot", "fixture", "test", createdAt, true);
    f.dispatcher.store.start(run, createdAt);
    f.dispatcher.store.acknowledge(run, "completed", nextRunAt, createdAt);
    const before = f.dispatcher.store.snapshot();
    const tool = toolFor(f.client);
    expect(tool.schema.properties.action.enum).toContain("update");
    const prompt = "Read local enriched observations.\nPreserve unknown outcomes.";
    const result = await tool.execute({ action: "update", id: "finite-pilot", prompt });
    expect(result.details.job).toEqual({ ...before.jobs[0]!.job, prompt, updatedAt });
    expect(f.dispatcher.store.snapshot()).toEqual({
      ...before, jobs: [{ ...before.jobs[0]!, job: result.details.job }],
    });
    await tool.execute({ action: "update", id: "finite-pilot", prompt });
    f.dispatcher.scan();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.dispatcher.store.snapshot().runs).toEqual(before.runs);
    const persisted = new AuthorityStore(f.home, true);
    try { expect(persisted.snapshot()).toEqual(f.dispatcher.store.snapshot()); }
    finally { persisted.close(); }
  });

  it("passes the updated prompt to the next arbitrated background execution", async () => {
    const f = await fixture({ enabled: true });
    await f.client.updatePrompt("finite-pilot", "/workspace", "review enriched context");
    await f.client.runNow("finite-pilot", "/workspace");
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    expect(f.execute.mock.calls[0]![0]).toMatchObject({
      job: { id: "finite-pilot", prompt: "review enriched context", maxRuns: 2 },
      fence: { jobId: "finite-pilot", generation: 1 },
    });
    await vi.waitFor(() => expect(f.dispatcher.store.snapshot().runs[0]?.state).toBe("completed"));
    expect(f.dispatcher.store.snapshot().jobs[0]?.job.runCount).toBe(1);
  });

  it.each(["prompt", "notify", "message", "shell"] as const)("updates %s payload without changing its kind or other settings", async (action) => {
    const f = await fixture({ action, ...(action === "shell" ? { command: "check", failurePrompt: "handle failure", wakeOn: "failure" } : {}) });
    const before = f.dispatcher.store.snapshot();
    await f.client.updatePrompt("finite-pilot", "/workspace", "new task text");
    expect(f.dispatcher.store.snapshot().jobs[0]).toEqual({
      ...before.jobs[0], job: { ...before.jobs[0]!.job, prompt: "new task text", updatedAt },
    });
  });

  it.each(["claimed", "started", "ambiguous"] as const)("refuses updates around a %s executor without altering its fence", async (state) => {
    const f = await fixture();
    const run = f.dispatcher.store.claim("finite-pilot", "slot", "fixture", "test", createdAt, true);
    if (state !== "claimed") f.dispatcher.store.start(run, createdAt);
    if (state === "ambiguous") f.dispatcher.store.markUnknown(run, createdAt);
    const before = f.dispatcher.store.snapshot();
    await expect(f.client.updatePrompt("finite-pilot", "/workspace", "changed")).rejects.toMatchObject({ code: "CLAIM_BUSY" });
    expect(f.dispatcher.store.snapshot()).toEqual(before);
    if (state === "claimed") {
      f.dispatcher.store.interrupt(run, "fixture confirms no execution", updatedAt);
      await expect(f.client.updatePrompt("finite-pilot", "/workspace", "changed")).resolves.toMatchObject({ prompt: "changed" });
    }
  });

  it("preserves session ownership, project visibility and terminal budgets", async () => {
    const f = await fixture({ target: "session", ownerSessionId: "owner", scope: "project", projectPath: "/workspace", terminated: "maxRuns", runCount: 2 });
    const before = f.dispatcher.store.snapshot();
    await expect(f.client.updatePrompt("finite-pilot", "/other", "changed")).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(f.client.updatePrompt("missing", "/workspace", "changed")).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    expect(f.dispatcher.store.snapshot()).toEqual(before);
    await expect(f.client.updatePrompt("finite-pilot", "/workspace", "changed")).resolves.toMatchObject({
      enabled: false, terminated: "maxRuns", runCount: 2, maxRuns: 2, ownerSessionId: "owner", target: "session", nextRunAt,
    });
    await f.client.remove("finite-pilot", "/workspace");
    const cancelled = f.dispatcher.store.snapshot();
    await expect(f.client.updatePrompt("finite-pilot", "/workspace", "again")).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    expect(f.dispatcher.store.snapshot()).toEqual(cancelled);
  });

  it("rejects empty prompts, unsupported tool fields and protocol patches without changing state", async () => {
    const f = await fixture();
    const tool = toolFor(f.client);
    const before = f.dispatcher.store.snapshot();
    for (const prompt of ["", " \n "]) {
      await expect(f.client.updatePrompt("finite-pilot", "/workspace", prompt)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect((await tool.execute({ action: "update", id: "finite-pilot", prompt })).details.error).toBe("prompt_required");
    }
    expect((await tool.execute({ action: "update", prompt: "changed" })).details.error).toBe("id_required");
    for (const extra of [{ maxRuns: 10 }, { target: "session" }, { command: "other" }, { enabled: true }, { every: "1m" }]) {
      expect((await tool.execute({ action: "update", id: "finite-pilot", prompt: "changed", ...extra })).details.error).toBe("unsupported_update_fields");
      await expect(f.client.control.request({ op: "update_prompt", jobId: "finite-pilot", cwd: "/workspace", prompt: "changed", ...extra } as any)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(f.dispatcher.store.snapshot()).toEqual(before);
  });

  it("keeps maintenance admission and offline mutations fenced with no legacy write fallback", async () => {
    const f = await fixture();
    const before = f.dispatcher.store.snapshot();
    f.dispatcher.store.pause("fixture maintenance");
    await expect(f.client.updatePrompt("finite-pilot", "/workspace", "changed")).rejects.toMatchObject({ code: "MAINTENANCE" });
    expect(f.dispatcher.store.snapshot()).toEqual(before);
    await f.dispatcher.close();
    services.splice(services.indexOf(f.dispatcher), 1);
    await expect(f.client.updatePrompt("finite-pilot", "/workspace", "changed")).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    const persisted = new AuthorityStore(f.home, true);
    try { expect(persisted.snapshot()).toEqual(before); } finally { persisted.close(); }
    const legacy = { pathsInfo: () => f.client.pathsInfo() } as ScheduleToolStore;
    expect((await toolFor(legacy).execute({ action: "update", id: "finite-pilot", prompt: "changed" })).details.error).toBe("update_unavailable");
  });
});
