import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityStore, authorityPaths } from "../src/authority-store.js";
import { runWatchdog, slackNotifier } from "../src/watchdog-command.js";
import { healthPath, writePrivateJson } from "../src/watchdog-health.js";
const roots: string[] = [];
const at = "2026-11-09T00:00:00.000Z";
const later = "2026-11-09T00:03:00.000Z";
const exec = promisify(execFile);
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pi-watchdog-")); roots.push(home);
  const store = new AuthorityStore(home);
  store.close();
  return { home, directory: join(home, ".pi-schedule-watchdog"), paths: authorityPaths(home) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("standalone watchdog", () => {
  it("runs the actual CLI with healthy, incident and invalid-config exit statuses without credentials", async () => {
    const { home, directory, paths } = fixture();
    const invoke = () => exec(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/watchdog-command.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: home, SLACK_BOT_TOKEN: "", SLACK_CHANNEL: "" },
    });
    writePrivateJson(healthPath(paths.directory), { checkedAt: new Date().toISOString() });
    expect(JSON.parse((await invoke()).stdout).openIncidents).toBe(0);
    rmSync(healthPath(paths.directory));
    await expect(invoke()).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("dispatcher_unavailable") });
    const preserved = readFileSync(join(directory, "alerts.json"), "utf8");
    writePrivateJson(join(directory, "config.json"), { maintenanceUntil: "not-a-date" });
    await expect(invoke()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("watchdog check failed") });
    expect(readFileSync(join(directory, "alerts.json"), "utf8")).toBe(preserved);
  });
  it("reads valid maintenance config and rejects invalid config without losing incident state", async () => {
    const { home, directory } = fixture();
    await runWatchdog({ home, now: () => new Date(later), notify: async () => ({}) });
    writePrivateJson(join(directory, "config.json"), { maintenanceUntil: "2026-11-09T01:00:00Z", maintenanceJobIds: ["job"] });
    const status = await runWatchdog({ home, now: () => new Date(later), notify: async () => ({}) });
    expect(status.observations[0]?.status).toBe("maintenance");
    expect(status.openIncidents).toBe(0);
    const preserved = readFileSync(join(directory, "alerts.json"), "utf8");
    for (const config of [{ maintenanceUntil: "not-a-date" }, { maintenanceJobIds: "wrong-type" }, { unknown: true }]) {
      writePrivateJson(join(directory, "config.json"), config);
      await expect(runWatchdog({ home })).rejects.toThrow(/config.json/);
      expect(readFileSync(join(directory, "alerts.json"), "utf8")).toBe(preserved);
    }
  });
  it("benchmarks restarted OS commands with model/MCP unavailable, failed delivery bounded to 3 then one recovery", async () => {
    const { home, directory, paths } = fixture();
    const original = readFileSync(paths.database);
    let requests = 0, reject = true;
    const server = createServer((_request, response) => { requests++; response.writeHead(reject ? 503 : 200); response.end("mock"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No mock address");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const invoke = () => exec(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/watchdog-client.ts", import.meta.url)), home, later, endpoint], {
        env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "no-agent"), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", MCP_SERVER_URL: "http://127.0.0.1:1" },
      });
      for (let i = 0; i < 5; i++) await invoke();
      expect(requests).toBe(3);
      const status = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
      expect(status.undelivered[0]).toMatchObject({ attempts: 3, exhausted: true });
      expect(status.action).toMatch(/SLACK_BOT_TOKEN\/SLACK_CHANNEL/);
      expect(readFileSync(join(directory, "delivery-receipts.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
      reject = false;
      writePrivateJson(healthPath(paths.directory), { checkedAt: later });
      await invoke(); await invoke();
      expect(requests).toBe(4);
      const receipts = readFileSync(join(directory, "delivery-receipts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(receipts[3]).toMatchObject({ kind: "recovery", status: "sent", messageId: "mock-receipt" });
      expect(readFileSync(paths.database)).toEqual(original); // No scheduler writes, claims or workload execution.
    } finally { await new Promise<void>((resolve, rejectClose) => server.close((error) => error ? rejectClose(error) : resolve())); }
  }, 15000);
  it("caps a check at five pending sends and delivers the remainder on the next check", async () => {
    const { home, directory, paths } = fixture();
    writePrivateJson(healthPath(paths.directory), { checkedAt: at });
    await runWatchdog({ home, now: () => new Date(at), notify: async () => ({}) });
    writePrivateJson(join(directory, "alerts.json"), { version: 1, incidents: {}, outbox: Array.from({ length: 6 }, (_, i) => ({ id: `event-${i}`, key: "job", kind: "incident", status: "fixture", at, attempts: 0 })) });
    const notify = vi.fn(async () => ({ messageId: "mock" }));
    await runWatchdog({ home, now: () => new Date(at), notify });
    expect(notify).toHaveBeenCalledTimes(5);
    await runWatchdog({ home, now: () => new Date(at), notify });
    expect(notify).toHaveBeenCalledTimes(6);
    expect(readFileSync(join(directory, "delivery-receipts.jsonl"), "utf8").trim().split("\n")).toHaveLength(6);
  });
  it("persists a successful direct Slack response message ID", async () => {
    const { home, directory } = fixture();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: "123.456" })));
    await runWatchdog({ home, now: () => new Date(later), notify: slackNotifier({ SLACK_BOT_TOKEN: "fixture-token", SLACK_CHANNEL: "fixture-channel" }, request) });
    expect(JSON.parse(readFileSync(join(directory, "delivery-receipts.jsonl"), "utf8"))).toMatchObject({ status: "sent", messageId: "123.456", attempt: 1 });
  });
  it("bounds the direct transport timeout and persists its failure without retrying in a loop", async () => {
    const { home, directory } = fixture();
    const signal = AbortSignal.abort(new DOMException("mock timeout", "TimeoutError"));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    try {
      const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => { options?.signal?.throwIfAborted(); return new Response(); });
      await runWatchdog({ home, now: () => new Date(later), notify: slackNotifier({ SLACK_BOT_TOKEN: "fixture-token", SLACK_CHANNEL: "fixture-channel" }, request) });
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(join(directory, "delivery-receipts.jsonl"), "utf8"))).toMatchObject({ status: "failed", attempt: 1 });
    } finally { timeout.mockRestore(); }
  });
  it("uses direct Slack transport, checks API errors, and never leaks token values into local receipts", async () => {
    const { home, directory } = fixture();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "secret-in-error" }), { status: 200 }));
    const notify = slackNotifier({ SLACK_BOT_TOKEN: "test-secret-token", SLACK_CHANNEL: "test-channel" }, request);
    await runWatchdog({ home, now: () => new Date(later), notify });
    expect(request.mock.calls[0]?.[0]).toBe("https://slack.com/api/chat.postMessage");
    const local = readFileSync(join(directory, "delivery-receipts.jsonl"), "utf8") + readFileSync(join(directory, "status.json"), "utf8");
    expect(local).not.toContain("test-secret-token");
    expect(local).not.toContain("secret-in-error");
    await expect(slackNotifier({}, request)({ id: "e", key: "k", kind: "incident", status: "failed", at, attempts: 0 })).rejects.toThrow("not_configured");
  });
  it("preserves corrupt alert state rather than silently dropping incidents", async () => {
    const { home, directory } = fixture();
    await runWatchdog({ home, now: () => new Date(later), notify: async () => ({}) });
    writeFileSync(join(directory, "alerts.json"), "broken");
    await expect(runWatchdog({ home })).rejects.toThrow(/preserve/);
    expect(readFileSync(join(directory, "alerts.json"), "utf8")).toBe("broken");
  });
  it("retains local incident evidence when the authority is missing and does not initialize it", async () => {
    const { home, paths } = fixture();
    rmSync(paths.database);
    const status = await runWatchdog({ home, now: () => new Date(later), notify: async () => { throw new Error("offline"); } });
    expect(status.observations).toContainEqual(expect.objectContaining({ key: "authority_read", incident: true }));
    expect(() => readFileSync(paths.database)).toThrow();
  });
});
