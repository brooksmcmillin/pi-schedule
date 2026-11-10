import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuthorityClient } from "./authority-protocol.js";
import type { AuthorityJob } from "./authority-types.js";
import type { Delivery, OwnerConnection } from "./dispatcher.js";
import { PrivilegeGuard } from "./privilege.js";
import { ScheduleRunner } from "./runner.js";
import { ScheduleStore } from "./store.js";

/** Polls only this owner's inbox. It cannot scan jobs, advance timing or claim runs. */
export class OwnerReceiver {
  private owner?: OwnerConnection;
  private timer?: ReturnType<typeof setInterval>;
  private epoch = 0;
  private polling = false;
  private readonly privilege = new PrivilegeGuard();
  private readonly runner: ScheduleRunner;

  constructor(private readonly pi: ExtensionAPI, private readonly client: AuthorityClient, private readonly pollMs = 1000) {
    this.runner = new ScheduleRunner({ pi, store: new ScheduleStore(), privilege: this.privilege });
  }

  attach(): void {
    this.privilege.attach(this.pi);
    this.pi.on("session_start", async (_event, ctx) => {
      await this.stop();
      const epoch = this.epoch;
      this.timer = setInterval(() => { if (epoch === this.epoch) void this.poll(ctx); }, this.pollMs);
      this.timer.unref();
    });
    this.pi.on("session_shutdown", () => this.stop());
  }

  async stop(): Promise<void> {
    this.epoch++;
    clearInterval(this.timer);
    this.privilege.clear();
    const owner = this.owner;
    this.owner = undefined;
    if (owner) {
      try { await this.client.request({ op: "unregister_owner", owner }); }
      catch { /* A closed generation cannot start or acknowledge work. */ }
    }
  }

  async poll(ctx: ExtensionContext): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const epoch = this.epoch;
    const sessionId = ctx.sessionManager?.getSessionId();
    const current = () => epoch === this.epoch && sessionId === ctx.sessionManager?.getSessionId();
    const idle = () => current() && ctx.isIdle() && !ctx.hasPendingMessages?.();
    try {
      if (!sessionId) throw new Error("Session identity unavailable; no owner inference or fallback");
      if (!this.owner) {
        const owner = await this.client.request({ op: "register_owner", sessionId, cwd: ctx.cwd }) as OwnerConnection;
        if (!current()) {
          await this.client.request({ op: "unregister_owner", owner });
          return;
        }
        this.owner = owner;
      }
      const owner = this.owner;
      const delivery = await this.client.request({ op: "receive", owner, idle: idle() }) as Delivery | null;
      if (!delivery) return;
      const matches = (job: AuthorityJob) => job.target === "session" && job.ownerSessionId === sessionId && job.executionCwd === ctx.cwd && delivery.fence.ownerId === owner.generation;
      if (!current() || !matches(delivery.job)) throw new Error("Delivery owner changed; not executed");
      if (!idle()) {
        await this.client.request({ op: "defer_delivery", owner, fence: delivery.fence });
        return;
      }
      await this.client.request({ op: "begin_delivery", owner, fence: delivery.fence });
      if (!idle()) {
        // We positively know no external effect was attempted in this receiver.
        await this.client.request({ op: "defer_delivery", owner, fence: delivery.fence });
        return;
      }
      let outcome: "completed" | "failed" = "completed";
      let result: { detail?: string; lastShell?: AuthorityJob["lastShell"] };
      try {
        result = await this.runner.executeClaimed(ctx, delivery.job, delivery.fence.runId,
          delivery.forced ? "run_now" : "tick", delivery.forced, () => {
            if (!idle() || !matches(delivery.job)) throw new Error("Owner became busy or changed during delivery; inspect execution history before retry");
          });
      } catch (error) { outcome = "failed"; result = { detail: String(error) }; }
      if (!current()) return; // Never acknowledge a replacement session's execution.
      await this.client.request({ op: "finish_delivery", owner, fence: delivery.fence, outcome, detail: result.detail ?? "", lastShell: result.lastShell });
      ctx.ui.setStatus("pi-schedule", "dispatcher connected");
    } catch (error) {
      if (!current()) return;
      this.owner = undefined; // Re-register on next poll; never retry ambiguous execution.
      ctx.ui.setStatus("pi-schedule", `dispatcher unavailable: ${String(error)}; start/check service and reload`);
    } finally { this.polling = false; }
  }
}
