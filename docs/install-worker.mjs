#!/usr/bin/env node
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Historical filename retained so existing installation instructions upgrade safely.
if (process.platform !== "linux") throw new Error("Automatic supervision supports Linux systemd user services only; see docs/MIGRATION.md for other platforms");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dry-run") || args.length > 1) throw new Error("Usage: node docs/install-worker.mjs [--dry-run]. --project discovery is retired; use a migration manifest");
const root = fileURLToPath(new URL("..", import.meta.url));
const loader = fileURLToPath(import.meta.resolve("tsx"));
const quote = (value) => {
  if (/[\n\r\0]/.test(value)) throw new Error("Service paths must not contain control characters");
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
};
const command = process.env.PI_SCHEDULE_PI ?? "pi";
const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(":").map((path) => resolve(path, command));
const pi = candidates.find((path) => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
if (!pi) throw new Error("Pi executable not found; set PI_SCHEDULE_PI to its absolute path");
const service = `[Unit]
Description=Single authoritative Pi schedule dispatcher
Documentation=file:${join(root, "docs", "MIGRATION.md")}

[Service]
Type=simple
WorkingDirectory=${root.replaceAll("%", "%%")}
Environment=${quote("HOME=" + homedir())}
Environment=${quote("PI_SCHEDULE_PI=" + resolve(pi))}
Environment=${quote("PATH=" + (process.env.PATH ?? "/usr/bin:/bin"))}
ExecStart=:${[process.execPath, "--import", loader, join(root, "src", "dispatcher.ts")].map(quote).join(" ")}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=11min
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
`;
const directory = join(homedir(), ".config", "systemd", "user");
const path = join(directory, "pi-schedule-dispatcher.service");
if (args.includes("--dry-run")) console.log(JSON.stringify({ path, service, node: process.execPath, pi, loader, root }, null, 2));
else {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, service, { mode: 0o600 });
  console.log(path);
  console.log("Generated only; no service was started/stopped. Follow docs/MIGRATION.md: pause, drain/reconcile, disable the legacy timer, migrate, then enable dispatcher. Do not enable both schedulers.");
  console.log("After cutover: systemctl --user daemon-reload && systemctl --user enable --now pi-schedule-dispatcher.service");
  console.log("Check: npm run doctor. User services normally stop at logout; boot/logout persistence needs an explicitly configured lingering user manager.");
}
