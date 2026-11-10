import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { AuthorityClient } from "./authority-protocol.js";
import { applyMigration, inspectMigration, receiptPath, rollbackMigration, type MigrationPlan } from "./migration.js";

export async function migrationCommand(args: string[]): Promise<unknown> {
  const [action, ...rest] = args;
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--home", "--plan", "--attestation"].includes(rest[i]!) || !rest[i + 1] || options.has(rest[i]!)) throw new Error("Usage: migration dry-run|apply|pause|resume|rollback [--home /absolute/home] [--plan manifest.json] [--attestation 'non-secret drain/reconciliation evidence']");
    options.set(rest[i]!, rest[i + 1]!);
  }
  const home = options.get("--home") ?? homedir();
  const attestation = options.get("--attestation") ?? "";
  if (action === "resume") {
    return new AuthorityClient(home, "migration-v1").request({ op: "resume_admission" });
  }
  if (action === "pause") {
    if (!attestation.trim()) throw new Error("Supply a non-secret maintenance reason with --attestation");
    return new AuthorityClient(home, "migration-v1").request({ op: "pause_admission", reason: attestation });
  }
  if (action === "rollback") {
    const result = rollbackMigration(home, attestation);
    return { phase: result.phase, receipt: receiptPath(home), jobs: result.rollback?.authority.jobs.map(({ job }) => job.id), newDispatcherAdmission: "paused; legacy explicit-target v1 only" };
  }
  if (action !== "dry-run" && action !== "apply") throw new Error("Expected dry-run, apply, pause, resume or rollback");
  const path = options.get("--plan");
  if (!path) throw new Error("Supply --plan manifest.json; ownership is never inferred");
  const plan = JSON.parse(readFileSync(path, "utf8")) as MigrationPlan;
  if (action === "dry-run") {
    const result = inspectMigration(home, plan);
    return { dryRun: true, jobs: result.jobs.map(({ id, target, ownerSessionId, executionCwd, nextRunAt }) => ({ id, target, ownerSessionId, executionCwd, nextRunAt })),
      sources: result.sources.map(({ path, sha256 }) => ({ path, sha256 })), historySha256: result.history.sha256, planHash: result.planHash };
  }
  const result = applyMigration(home, plan, attestation);
  return { phase: result.phase, receipt: receiptPath(home), jobs: result.jobs.map((job) => job.id), note: "Start the supervised dispatcher and verify doctor; this is not live reliability proof" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrationCommand(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2)), (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
