import type { ScheduledJob } from "./types.js";

export function routingError(
  job: ScheduledJob,
  sessionId: string | undefined,
  cwd: string,
  background = false,
): string | undefined {
  if (!job.target) return "Legacy job has no execution target. Recreate it explicitly; ownership cannot be inferred from prompt text.";
  if (job.target !== "session" && job.target !== "background") return "Invalid execution target";
  if (!job.executionCwd || job.executionCwd !== cwd) return "Job workspace does not match this runner";
  if (background) {
    return job.target === "background" ? undefined : "Session-owned jobs cannot execute in the background worker";
  }
  if (job.target === "background") return "Background jobs execute only in the background worker, never in an interactive session";
  if (!sessionId || !job.ownerSessionId || job.ownerSessionId !== sessionId) return "Job belongs to a different session (or session identity is unavailable)";
  return undefined;
}
