import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Intercept only this disposable process, never ship failpoints in production code.
const [home, action, fault] = process.argv.slice(2) as [string, string, string];
const globalFile = join(home, ".pi-schedule", "schedules.json");
const runsFile = join(home, ".pi-schedule", "runs.jsonl");
const lockDir = join(home, ".pi-schedule", "locks");
const exit = () => process.exit(73);
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  rename(source, destination);
  const path = String(destination);
  if (path === globalFile && ((action === "apply" && fault === "retire-write") || (action === "rollback" && fault === "restore-write"))) exit();
  if (path === runsFile && fault === "restore-history") exit();
  if (path.includes(".lock.retired-") && fault === "release-mutation") exit();
};
const unlink = fs.unlinkSync;
fs.unlinkSync = (path) => { unlink(path); if (String(path) === lockDir && fault === "release-delivery") exit(); };
syncBuiltinESMExports();

const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql: string) {
  const statement = prepare.call(this, sql);
  if (sql.startsWith("INSERT OR REPLACE INTO maintenance")) {
    const run = statement.run;
    Object.defineProperty(statement, "run", { value: (...args: unknown[]) => {
      const result = Reflect.apply(run, statement, args);
      const phase = JSON.parse(String(args[0])).phase;
      if ((phase === "active" && fault === "activate-commit") || (phase === "rolled-back" && fault === "rollback-park")) exit();
      return result;
    } });
  }
  return statement;
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql: string) {
  exec.call(this, sql);
  if (sql === "COMMIT" && fault === "import-commit" && this.prepare("SELECT name FROM sqlite_master WHERE name='maintenance'").get()) {
    const row = this.prepare("SELECT document FROM maintenance WHERE id=1").get();
    if (row && JSON.parse(String(row.document)).phase === "imported") exit();
  }
};

const { applyMigration, rollbackMigration } = await import("../../src/migration.js");
if (action === "apply") applyMigration(home, JSON.parse(fs.readFileSync(join(home, "plan.json"), "utf8")), "Disposable fixture confirms drain/effects reconciliation");
else rollbackMigration(home, "Disposable fixture confirms stopped executors, effects reconciliation and compatible legacy build");
throw new Error("Requested fault was not reached");
