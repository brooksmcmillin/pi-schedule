import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AuthorityStore } from "../src/authority-store.js";
import { Dispatcher, type Delivery, type OwnerConnection } from "../src/dispatcher.js";
import { outcomeSummary } from "../src/outcome.js";

const at = "2026-11-09T00:00:00.000Z";
describe("local kill/restart benchmark (synthetic effects only)", () => {
  it.each(["before_claim", "claimed", "started", "effect"])("SIGKILL at %s preserves honest outcomes and fences replacement", async (phase) => {
    const home = mkdtempSync(join(tmpdir(), "pi-kill-"));
    let restarted: Dispatcher | undefined;
    const seed = new AuthorityStore(home);
    seed.addJob({ id: "job", name: "fixture", prompt: "synthetic", target: "session", ownerSessionId: "owner", executionCwd: home,
      action: "prompt", schedule: { type: "interval", everyMs: 3600000, every: "1h" }, scope: "global", enabled: true,
      missedWindow: "catch_up_one", tier: "mutate", createdAt: at, updatedAt: at, lastRunAt: null, nextRunAt: at, runCount: 0, lastStatus: null });
    seed.close();
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/interrupted-dispatcher.ts", import.meta.url)), home, phase], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk.toString(); });
      await vi.waitFor(() => expect(output).toContain("\n"), { timeout: 5000 });
      const previous = JSON.parse(output.trim()) as { owner: OwnerConnection; delivery?: Delivery };
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      restarted = new Dispatcher({ home, now: () => new Date(at) }); await restarted.start();
      const owner = restarted.request({ op: "register_owner", sessionId: "owner", cwd: home }) as OwnerConnection;
      if (phase === "started" || phase === "effect") {
        expect(restarted.request({ op: "receive", owner, idle: true })).toBeNull();
        const run = restarted.store.snapshot().runs[0]!;
        expect(run).toMatchObject({ state: "started", uncertainty: "executor_or_effect_unknown" });
        expect(outcomeSummary(run)).toContain("execution-unknown (reconciliation required); outcome-unverified");
        expect(() => restarted!.request({ op: "finish_delivery", owner: previous.owner, fence: previous.delivery!.fence, outcome: "completed", detail: "stale" })).toThrow(/connection/);
        if (phase === "effect") expect(readFileSync(join(home, "external-effect"), "utf8")).toBe(run.runId);
        // The fixture executor is proven dead by waitpid; the synthetic effect is inspected above.
        restarted.request({ op: "reconcile_execution", fence: previous.delivery!.fence, executorStopped: true, effectsReconciled: true, outcome: "failed" });
        restarted.scan();
        expect(restarted.request({ op: "receive", owner, idle: true })).toBeNull();
        expect(restarted.store.snapshot().runs).toHaveLength(1);
        expect(restarted.store.snapshot().runs[0]?.state).toBe("failed");
        expect(restarted.store.snapshot().jobs[0]?.job.nextRunAt).toBe("2026-11-09T01:00:00.000Z");
      } else {
        const delivery = restarted.request({ op: "receive", owner, idle: true }) as Delivery;
        expect(delivery.fence.generation).toBe(phase === "claimed" ? 2 : 1);
        if (previous.delivery) expect(() => restarted!.store.start(previous.delivery!.fence, at)).toThrow(/generation/);
        if (phase === "claimed") expect(restarted.store.snapshot().runs[0]?.state).toBe("interrupted");
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
      await restarted?.close(); rmSync(home, { recursive: true, force: true });
    }
  }, 10000);
});
