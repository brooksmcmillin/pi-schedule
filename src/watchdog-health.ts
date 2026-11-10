import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface DispatcherHealth { checkedAt: string }

/** Same-directory rename gives readers a complete observation, never a partial JSON file. */
export function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function healthPath(directory: string): string { return join(directory, "dispatcher-health.json"); }
