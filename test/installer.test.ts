import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
function fixture() { const home = mkdtempSync(join(tmpdir(), "pi-install-%-$-")); roots.push(home); return { home, env: { ...process.env, HOME: home, PI_SCHEDULE_PI: process.execPath } }; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
describe("dispatcher installer (generation only)", () => {
  it("dry-runs a restartable absolute-path service, not a worker timer, without touching systemd", () => {
    const { home, env } = fixture();
    const result = JSON.parse(execFileSync(process.execPath, ["docs/install-worker.mjs", "--dry-run"], { env, encoding: "utf8" }));
    expect(result.node).toBe(process.execPath);
    expect(result.pi).toBe(process.execPath);
    expect(result.loader).toContain("/node_modules/tsx/");
    expect(result.service).toContain("Type=simple");
    expect(result.service).toContain(`WorkingDirectory=${result.root.replaceAll("%", "%%")}\n`);
    expect(result.service).not.toContain('WorkingDirectory="');
    expect(result.service).toContain("Restart=on-failure");
    expect(result.service).toContain("src/dispatcher.ts");
    expect(result.service).toContain("ExecStart=:");
    expect(result.service).toContain("UMask=0077");
    expect(result.service).toContain("TimeoutStopSec=11min");
    expect(result.service).toContain(home.replaceAll("%", "%%"));
    expect(result.service).not.toContain("worker.ts");
    expect(existsSync(join(home, ".config"))).toBe(false);
  });
  it("writes only the private dispatcher unit and prints explicit activation/logout instructions", () => {
    const { home, env } = fixture();
    const output = execFileSync(process.execPath, ["docs/install-worker.mjs"], { env, encoding: "utf8" });
    const path = join(home, ".config/systemd/user/pi-schedule-dispatcher.service");
    expect(readFileSync(path, "utf8")).toContain("WantedBy=default.target");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, ".config/systemd/user/pi-schedule-worker.timer"))).toBe(false);
    expect(output).toContain("no service was started/stopped");
    expect(output).toContain("Do not enable both");
    expect(output).toContain("logout");
    expect(output).toContain("npm run doctor");
  });
  it("diagnoses missing executables and retired project-discovery arguments", () => {
    const { home, env } = fixture();
    for (const [args, changes] of [[[], { PI_SCHEDULE_PI: home }], [[], { PI_SCHEDULE_PI: "/missing/pi" }], [["--project", "/workspace"], {}]] as const) {
      expect(() => execFileSync(process.execPath, ["docs/install-worker.mjs", ...args], { env: { ...env, ...changes }, stdio: "pipe" })).toThrow();
    }
  });
});
