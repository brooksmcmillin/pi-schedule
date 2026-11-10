import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AuthorityClient } from "./authority-protocol.js";
import { AuthorityStore, authorityPaths } from "./authority-store.js";
import { validateState } from "./authority-types.js";
import { BUILD_ID, runtimeIdentity } from "./build.js";
import { receiptPath } from "./migration.js";
import { healthPath } from "./watchdog-health.js";

type Runtime = ReturnType<typeof runtimeIdentity>;
interface ClientRegistration { sessionId: string; cwd: string; generation: string; buildId: string; protocolVersion: number; registeredAt: string; lastSeenAt: string }
interface ServiceDiagnostics { id: string; error?: string; maintenance?: { id: string; phase: string }; runtime: Runtime; clients: ClientRegistration[] }

/** Read-only diagnostic. Registrations and source fingerprints are evidence, not proof of live process/module identity. */
export async function doctor(home = homedir(), now = new Date()) {
  const local = runtimeIdentity();
  const paths = authorityPaths(home);
  let state;
  let service: ServiceDiagnostics | undefined;
  let connection = "online";
  try {
    const { dispatcher, ...snapshot } = await new AuthorityClient(home, BUILD_ID).request({ op: "snapshot" }) as { dispatcher?: ServiceDiagnostics };
    validateState(snapshot);
    if (!dispatcher?.runtime?.buildId || !Array.isArray(dispatcher.clients)) throw new Error("Dispatcher does not expose runtime/client diagnostics; upgrade it before relying on inventory");
    service = dispatcher;
    state = snapshot;
  } catch (error) {
    connection = `unavailable/incompatible: ${error instanceof Error ? error.message : String(error)}`;
    try {
      const store = new AuthorityStore(home, true);
      try { state = store.snapshot(); } finally { store.close(); }
    } catch { /* Report unreadable/missing state without creating or repairing anything. */ }
  }
  let heartbeat: { checkedAt: string } | undefined;
  try { heartbeat = JSON.parse(readFileSync(healthPath(paths.directory), "utf8")); } catch { /* Missing/invalid is reported, not repaired. */ }
  const healthTime = Date.parse(heartbeat?.checkedAt ?? "");
  const heartbeatFresh = Number.isFinite(healthTime) && healthTime <= now.getTime() && now.getTime() - healthTime <= 120000;
  const paused = Boolean(service?.maintenance && service.maintenance.phase !== "active");
  const clients = (service?.clients ?? []).map((client) => ({ ...client, matchesDispatcherBuild: client.buildId === service?.runtime.buildId }));
  let migration: { phase?: string } | undefined;
  try { migration = JSON.parse(readFileSync(receiptPath(home), "utf8")); } catch { /* No private backup contents in diagnostics. */ }
  return {
    ready: Boolean(service && service.runtime.piExecutable && !service.error && !paused && heartbeatFresh), connection,
    local, dispatcher: service ? { id: service.id, runtime: service.runtime, matchesLocalBuild: service.runtime.buildId === local.buildId,
      error: service.error, maintenance: service.maintenance } : null,
    heartbeat: { checkedAt: heartbeat?.checkedAt ?? null, fresh: heartbeatFresh }, clients,
    clientInventoryLimit: "Known owner registrations only; lastSeenAt is an observation, not proof the process is still alive. Unregistered/legacy processes and their loaded versions are UNKNOWN; no exhaustive process scan or module-byte attestation was performed.",
    authority: { path: paths.database, readable: Boolean(state), jobs: state?.jobs.length ?? null,
      activeRuns: state?.runs.filter((run) => run.state === "claimed" || run.state === "started").map(({ runId, jobId, state, uncertainty, ownerId }) => ({ runId, jobId, state, uncertainty, ownerId })) ?? [] },
    migration: { receipt: receiptPath(home), phase: migration?.phase ?? "not recorded" },
    advice: [
      "If dispatcher runtime.piExecutable is null, set PI_SCHEDULE_PI to an executable file, regenerate the service unit and gracefully restart after draining; background prompts cannot launch without it.",
      "Check systemctl --user status pi-schedule-dispatcher.service and its journal. Generate the unit with node docs/install-worker.mjs; follow docs/MIGRATION.md before activation. No legacy scheduling fallback.",
      "For identified stale registrations, ask that exact session/workspace owner to wait for idle and /reload. A build difference is diagnostic, not authorization to interrupt a session or proof of incompatibility.",
      "For cutover: pause admission, drain only affected schedulers, reconcile active/ambiguous executor effects, then stop only the dispatcher/legacy timer. Never kill all Pi processes; unregistered legacy inventory requires operator confirmation.",
      "Do not share credentials, prompts or private migration/authority/result contents. Doctor does not read environment secrets, scan processes, change state or launch work.",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--home" || !args[1])) {
    console.error("Usage: doctor [--home /absolute/home]"); process.exitCode = 1;
  } else {
    const result = await doctor(args[1]);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  }
}
