# Session-owned and background schedules

## Choose execution separately from storage

| Goal | Target | Where it runs |
| --- | --- | --- |
| Continue current task, renew a session-owned claim, remind this conversation | `session` (default) | Creating session ID and workspace only |
| Independent recurring scan, report, or check | `background` (explicit) | Fresh headless Pi process per prompt run |

`scope=global/project` selects the JSON storage file, not delivery. The tool
captures the current session ID and absolute workspace automatically. It does
not accept an owner ID supplied by the model. A session UUID in prompt text is
not routing metadata. Session jobs cannot run through the background worker,
and `run_now` in another session cannot override ownership.

Session delivery retains the owning conversation. If that session is closed,
its jobs stay pending; on resume the existing missed-window policy applies.
Switching, forking or reloading the runtime cancels in-flight deliveries rather
than sending results into a replacement chat. A shell already executed before
such a switch is recorded as an error and is not immediately retried.

Background jobs default to global storage, but retain their creating workspace.
They use normal Pi credentials, settings, workspace instructions and extensions;
**fresh context is not an OS sandbox or a transfer of session-owned authority**.
The worker explicitly loads the tier guard and suppresses its own scheduler in
children. As with the original package, tiers cover named built-in tools and
schedule mutations, not every custom/MCP tool. Use narrow, authorized prompts.

## Install and run the worker

From the installed fork's directory, with Node 22+ and Pi on PATH:

```sh
npm install --omit=dev --ignore-scripts --legacy-peer-deps
node docs/install-worker.mjs
systemctl --user daemon-reload
systemctl --user enable --now pi-schedule-worker.timer
systemctl --user status pi-schedule-worker.timer
journalctl --user -u pi-schedule-worker.service -n 30
```

The installer records absolute Node, loader, package and Pi paths. Regenerate
units if those paths change. The timer scans global background jobs every 30
seconds independently of interactive Pi sessions. The user manager must be
running; persistent execution after logout requires administrator-approved user
lingering (`loginctl show-user "$USER" -p Linger`). No root service is installed.

Project job files are not automatically executable just because a global job
uses that workspace. Admit each inspected project explicitly:

```sh
node docs/install-worker.mjs --project /absolute/trusted/workspace
systemctl --user daemon-reload
```

An alternative to systemd is cron calling the worker with absolute paths. Use
only one mechanism; existing per-job locks prevent overlapping deliveries.

```sh
/path/to/node --import /path/to/package/node_modules/tsx/dist/loader.mjs /path/to/package/src/worker.ts
```

Manual run of an independent background job (not a session-owned job):

```sh
npm run worker -- --job JOB_ID
# For an explicitly trusted project job:
npm run worker -- --project /absolute/workspace --job JOB_ID
```

The interactive `schedule run_now` action is owner-session-only and refuses
background jobs rather than injecting them into the current chat.

## Results and failure semantics

Prompt runs save private files under `~/.pi-schedule/results/<runId>/`:

- `sessions/`: fresh persisted Pi transcript, no resumed controller session
- `stdout.log`, `stderr.log`: headless process output
- `result.json`: run/job/workspace identity, status and timestamps

`schedule history` links the result directory. No result is injected into an
interactive session. Notify/message background jobs write to the service log;
shell output and exit status are stored on the job as before. Results are not
automatically deleted; prune them explicitly when no longer needed.

The child timeout is 10 minutes, below the 30-minute stale lock threshold.
Timeout, shutdown and successful parent exit clean up the run's process group.
A stopped worker starts no further jobs. Scan failures and failed headless
processes produce nonzero CLI exits. An OS crash can still interrupt a run after
side effects but before durable accounting; this is not exactly-once execution.
A successful Pi process means the run finished, not that its task was correct.

## Migration

1. Replace the upstream package entry with this fork, rather than loading both.
2. Reload or restart **every open Pi process**. Existing processes still hold
   their old extension code and can continue consuming legacy global schedules.
3. List jobs. Rows without a target are marked legacy and cannot execute in
   the new runner; they are neither deleted nor automatically assigned an owner.
4. Recreate each needed job with the correct target after checking its live
   authorization and task state. Recreate session-owned continuations from the
   original owning session, never from the worker or another conversation.
5. Verify the returned target, owner and workspace, then disable/remove only
   the superseded original job. Do not blindly replay expired authorization.

The separate `pi-schedule-prompt` package also provides session-bound reminders.
Its default can be configured to workdir-wide, so check the returned `session`
field. Adding `model` changes it to a separate in-process session: that is not an
owner-session continuation or a replacement for this external worker.
