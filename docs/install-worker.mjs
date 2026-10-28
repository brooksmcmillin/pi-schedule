#!/usr/bin/env node
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Generate units from the actual checkout and runtime paths, not shell profiles.
const root = fileURLToPath(new URL("..", import.meta.url));
const loader = fileURLToPath(import.meta.resolve("tsx"));
const quote = (value) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n") + '"';
const command = process.env.PI_SCHEDULE_PI ?? "pi";
const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(":").map((path) => join(path, command));
const pi = candidates.find((path) => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});
if (!pi) throw new Error("Pi executable not found; set PI_SCHEDULE_PI to its absolute path");
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (args[i] !== "--project" || !args[i + 1] || !isAbsolute(args[i + 1])) {
    throw new Error("Usage: node docs/install-worker.mjs [--project /absolute/trusted/workspace]...");
  }
}
const directory = join(homedir(), ".config", "systemd", "user");
mkdirSync(directory, { recursive: true });
const service = `[Unit]
Description=Isolated Pi background schedules

[Service]
Type=oneshot
Environment=${quote("PI_SCHEDULE_PI=" + resolve(pi))}
ExecStart=${[process.execPath, "--import", loader, join(root, "src", "worker.ts"), ...args].map(quote).join(" ")}
TimeoutStartSec=20min
KillMode=control-group
UMask=0077
`;
const timer = `[Unit]
Description=Check Pi background schedules every 30 seconds

[Timer]
OnBootSec=30s
OnUnitInactiveSec=30s
AccuracySec=1s

[Install]
WantedBy=timers.target
`;
for (const [name, body] of [["pi-schedule-worker.service", service], ["pi-schedule-worker.timer", timer]]) {
  const path = join(directory, name);
  writeFileSync(path, body, { mode: 0o600 });
  console.log(path);
}
console.log("Run: systemctl --user daemon-reload && systemctl --user enable --now pi-schedule-worker.timer");
