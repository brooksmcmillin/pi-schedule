import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORITY_PROTOCOL_VERSION, AUTHORITY_SCHEMA_VERSION } from "./authority-types.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = fileURLToPath(new URL(".", import.meta.url));
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const digest = createHash("sha256");
for (const name of readdirSync(source).filter((name) => name.endsWith(".ts")).sort()) digest.update(name).update(readFileSync(join(source, name)));
/** Captured when the module loads; source identity is diagnostic, not execution authorization. */
export const BUILD_ID = `pi-schedule-${version}-${digest.digest("hex")}`;

export function runtimeIdentity() {
  const command = process.env.PI_SCHEDULE_PI ?? "pi";
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(delimiter).map((path) => resolve(path, command));
  const piExecutable = candidates.find((path) => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
  return { buildId: BUILD_ID, packageVersion: version, protocolVersion: AUTHORITY_PROTOCOL_VERSION, schemaVersion: AUTHORITY_SCHEMA_VERSION,
    nodeExecutable: process.execPath, nodeVersion: process.version, piExecutable: piExecutable ?? null, root };
}
