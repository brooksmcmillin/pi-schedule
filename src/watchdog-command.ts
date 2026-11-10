import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AuthorityStore, authorityPaths } from "./authority-store.js";
import { healthPath, writePrivateJson } from "./watchdog-health.js";
import { inspectWatchdog, readWatchdogState, reconcileAlerts, type AlertEvent, type Observation, type WatchdogConfig } from "./watchdog.js";

export const MAX_DELIVERY_ATTEMPTS = 3;
const MAX_DELIVERIES_PER_CHECK = 5;
export type Notify = (event: AlertEvent) => Promise<{ messageId?: string }>;
const configSchema = Type.Object({
  maintenanceUntil: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T" })),
  maintenanceJobIds: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });

function readJson(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function configAt(path: string): WatchdogConfig {
  let value: unknown;
  try { value = readJson(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("Invalid watchdog config.json; repair maintenance configuration"); }
  if (!Value.Check(configSchema, value) || (value.maintenanceUntil && !Number.isFinite(Date.parse(value.maintenanceUntil)))) throw new Error("Invalid watchdog config.json; repair maintenance configuration");
  return value;
}

/** Direct bot API, like infra/scripts/drive-sprint.sh: no Pi, model or MCP discovery. */
export function slackNotifier(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): Notify {
  return async (event) => {
    if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL) throw new Error("notification_not_configured");
    const response = await request("https://slack.com/api/chat.postMessage", {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: env.SLACK_CHANNEL, text: `[pi-schedule ${event.kind}] ${event.key}: ${event.status}\nEvent ${event.id}; observed ${event.at}. Inspect local watchdog status.json and scheduler receipts.`, unfurl_links: false, unfurl_media: false }),
    });
    if (!response.ok) throw new Error("notification_http_failure");
    const result = await response.json() as { ok?: boolean; ts?: string };
    if (result.ok !== true) throw new Error("notification_api_failure");
    return { messageId: typeof result.ts === "string" ? result.ts : undefined };
  };
}

export async function runWatchdog(options: { home?: string; now?: () => Date; notify?: Notify } = {}) {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const notify = options.notify ?? slackNotifier();
  const directory = join(home, ".pi-schedule-watchdog");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  // Kernel-released writer lock, separate from the scheduler's authority database.
  const lockPath = join(directory, "check.sqlite");
  const lock = new DatabaseSync(lockPath);
  chmodSync(lockPath, 0o600);
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    const statePath = join(directory, "alerts.json");
    const previous = readWatchdogState(statePath);
    const config = configAt(join(directory, "config.json"));
    const at = now();
    let observations: Observation[];
    try {
      const store = new AuthorityStore(home, true);
      try {
        let health;
        try { health = readJson(healthPath(authorityPaths(home).directory)) as { checkedAt: string }; } catch { /* Missing/invalid heartbeat is unhealthy. */ }
        observations = inspectWatchdog(store.snapshot(), health, at, config);
      } finally { store.close(); }
      observations.push({ key: "authority_read", status: "readable", incident: false });
    } catch {
      // An unreadable authority is not evidence that existing job incidents recovered.
      observations = Object.keys(previous.incidents).map((key) => ({ key, status: "unavailable", incident: true }));
      observations.push({ key: "authority_read", status: "authority_unreadable: inspect authority database/schema; watchdog did not change it", incident: true });
    }
    const state = reconcileAlerts(previous, observations, at);
    writePrivateJson(statePath, state);
    let attempted = 0;
    for (const event of state.outbox) {
      if (event.delivered || event.attempts >= MAX_DELIVERY_ATTEMPTS) continue;
      if (attempted++ >= MAX_DELIVERIES_PER_CHECK) break;
      // Count before sending: even repeated crashes cannot create an unbounded retry loop.
      event.attempts++;
      writePrivateJson(statePath, state);
      let receipt: { status: string; messageId?: string };
      try { receipt = { status: "sent", ...await notify(event) }; event.delivered = true; }
      catch { receipt = { status: "failed" }; }
      const receiptsPath = join(directory, "delivery-receipts.jsonl");
      appendFileSync(receiptsPath, `${JSON.stringify({ eventId: event.id, kind: event.kind, attempt: event.attempts, at: now().toISOString(), ...receipt })}\n`, { mode: 0o600 });
      chmodSync(receiptsPath, 0o600);
      writePrivateJson(statePath, state);
    }
    const undelivered = state.outbox.filter((event) => !event.delivered);
    const status = {
      checkedAt: at.toISOString(), observations, openIncidents: Object.keys(state.incidents).length,
      undelivered: undelivered.map(({ id, attempts }) => ({ id, attempts, exhausted: attempts >= MAX_DELIVERY_ATTEMPTS })),
      action: undelivered.length ? "Check SLACK_BOT_TOKEN/SLACK_CHANNEL references, network and Slack; exhausted events require operator reconciliation in alerts.json. Watchdog never retries workloads." : "Inspect observations and scheduler run/application receipts for any open incident. Watchdog never retries workloads.",
    };
    writePrivateJson(join(directory, "status.json"), status);
    return status;
  } finally { lock.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const status = await runWatchdog();
    console.log(JSON.stringify(status));
    if (status.openIncidents || status.undelivered.length) process.exitCode = 1;
  } catch {
    console.error("pi-schedule watchdog check failed; inspect ~/.pi-schedule-watchdog state/config/lock and directory permissions; no workload was launched");
    process.exitCode = 1;
  }
}
