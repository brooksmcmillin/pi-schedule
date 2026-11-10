import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityClient, listenAuthority } from "../src/authority-protocol.js";
import { AuthorityStore, authorityPaths } from "../src/authority-store.js";
import { BUILD_ID } from "../src/build.js";
import { doctor } from "../src/doctor.js";
import { Dispatcher } from "../src/dispatcher.js";
import { writePrivateJson, healthPath } from "../src/watchdog-health.js";

const roots: string[] = [];
function fixture() { vi.stubEnv("PI_SCHEDULE_PI", process.execPath); const home = mkdtempSync(join(tmpdir(), "pi-doctor-")); roots.push(home); return home; }
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

describe("read-only doctor", () => {
  it("diagnoses unavailable dispatcher without creating state or leaking secrets", async () => {
    const home = fixture(); vi.stubEnv("SLACK_BOT_TOKEN", "fixture-secret-never-print");
    const result = await doctor(home);
    expect(result.ready).toBe(false);
    expect(result.connection).toContain("unavailable");
    expect(result.authority.readable).toBe(false);
    expect(result.clientInventoryLimit).toContain("UNKNOWN");
    expect(result.clientInventoryLimit).toContain("not proof");
    expect(JSON.stringify(result)).not.toContain("fixture-secret-never-print");
    expect(existsSync(authorityPaths(home).directory)).toBe(false);
    expect(result.advice.join(" ")).toContain("Never kill all Pi");
  });
  it("reports effective runtime and exact known registrations with diagnostic build differences", async () => {
    const home = fixture();
    vi.stubEnv("PI_SCHEDULE_PI", process.execPath);
    const service = new Dispatcher({ home, tickMs: 60000 }); await service.start();
    try {
      const client = new AuthorityClient(home, "older-loaded-build");
      const owner = await client.request({ op: "register_owner", sessionId: "exact-session", cwd: home }) as { sessionId: string; cwd: string; generation: string };
      // Registered build identity must not leak into the strict owner/fence payload.
      await client.request({ op: "receive", owner, idle: false });
      const result = await doctor(home);
      expect(result.ready).toBe(true);
      expect(result.local.nodeExecutable).toBe(process.execPath);
      expect(result.dispatcher?.runtime.piExecutable).toBe(process.execPath);
      expect(result.dispatcher?.runtime.buildId).toBe(BUILD_ID);
      expect(result.dispatcher?.runtime.protocolVersion).toBeGreaterThan(0);
      expect(result.dispatcher?.matchesLocalBuild).toBe(true);
      expect(result.clients[0]).toMatchObject({ sessionId: "exact-session", cwd: home, buildId: "older-loaded-build", matchesDispatcherBuild: false });
      expect(result.clients[0]!.registeredAt).toBeTruthy();
      expect(result.clients[0]!.lastSeenAt).toBeTruthy();
      expect(result.advice.join(" ")).toContain("exact session/workspace owner");
      await client.request({ op: "unregister_owner", owner });
      expect((await doctor(home)).clients).toEqual([]);
    } finally { await service.close(); }
  });
  it("labels maintenance and stale/future/malformed heartbeat without activating work", async () => {
    const home = fixture(); const service = new Dispatcher({ home, tickMs: 60000 }); await service.start();
    try {
      const now = new Date("2026-11-10T00:00:00Z");
      for (const checkedAt of ["2026-11-09T00:00:00Z", "2099-01-01T00:00:00Z", "invalid"]) {
        writePrivateJson(healthPath(authorityPaths(home).directory), { checkedAt });
        expect((await doctor(home, now)).ready).toBe(false);
      }
      writePrivateJson(healthPath(authorityPaths(home).directory), { checkedAt: now.toISOString() });
      expect((await doctor(home, now)).ready).toBe(true);
      service.request({ op: "pause_admission", reason: "operator maintenance" });
      const before = service.store.snapshot();
      const result = await doctor(home, now);
      expect(result.ready).toBe(false);
      expect(result.dispatcher?.maintenance?.phase).toBe("paused");
      expect(service.store.snapshot()).toEqual(before);
    } finally { await service.close(); }
  });
  it.each(["missing", "directory"])("reports not-ready for %s Pi executable despite fresh dispatcher heartbeat", async (kind) => {
    const home = fixture(); vi.stubEnv("PI_SCHEDULE_PI", kind === "missing" ? join(home, "missing-pi") : home);
    const service = new Dispatcher({ home, tickMs: 60000 }); await service.start();
    try {
      const result = await doctor(home);
      expect(result.connection).toBe("online");
      expect(result.heartbeat.fresh).toBe(true);
      expect(result.dispatcher?.runtime.piExecutable).toBeNull();
      expect(result.ready).toBe(false);
      expect(result.advice.join(" ")).toContain("set PI_SCHEDULE_PI");
    } finally { await service.close(); }
  });
  it("labels older foundation authority incompatible and preserves persisted read access", async () => {
    const home = fixture(); const store = new AuthorityStore(home);
    const listener = await listenAuthority(store, home);
    try {
      const result = await doctor(home);
      expect(result.ready).toBe(false);
      expect(result.connection).toContain("runtime/client diagnostics");
      expect(result.authority.readable).toBe(true);
      expect(result.dispatcher).toBeNull();
    } finally { await listener.close(); store.close(); }
  });
});
