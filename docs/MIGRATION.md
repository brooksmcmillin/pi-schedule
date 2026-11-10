# Installation, migration and compatible rollback

These commands are operator actions, not automatic package-install hooks. Test
in a disposable home first. The repository rehearsal is **not live trebby
cutover or natural-cadence proof**. Never stop unrelated Pi work.

Read the section for the current operation:
- [Runtime and supervision](#runtime-and-supervision): installation/platform and login behavior.
- [Inventory and dry-run](#inventory-and-dry-run): explicit owners and source inspection.
- [Cutover and interrupted-stage recovery](#cutover-and-interrupted-stage-recovery): pause/drain, import and activation.
- [Compatible rollback](#compatible-rollback): reconcile new history and restore compatible state.

## Runtime and supervision

Use Node >=22.13 with `node:sqlite`, the installed `tsx` dependency and the same
stable per-user HOME for service and clients. `node docs/install-worker.mjs`
generates **only** `~/.config/systemd/user/pi-schedule-dispatcher.service` using
absolute Node/tsx/checkout/Pi paths; `--dry-run` prints it without writing. It
never starts/stops a service. The historical filename is retained, but it no
longer creates worker timers. `PI_SCHEDULE_PI=/absolute/path/to/pi` selects the
headless executable. Regenerate the unit when executable/checkout paths change;
keep that checkout and its dependencies available for the service's lifetime.
No shell-profile loading or credential copying is required.

Automatic unit generation supports **Linux/systemd user services only**. Other
Unix platforms may run `npm run dispatcher` under their own supervisor with a
stable HOME, absolute executable paths, restrictive umask and process-group
cleanup. Windows is unsupported (Unix sockets and process groups). Systemd user
services normally start at login and stop at logout, not at boot. If unattended
boot/logout execution is desired, configure the user's lingering manager using
the host's normal administration policy (`loginctl enable-linger USER`); the
installer does not change host policy. Sleep/offline time follows missed-window
policy on restart, not a promise of execution while the machine is off.

The dispatcher restarts on failure. Graceful stop allows up to 11 minutes for
its bounded children to finish, then systemd cleans its service cgroup. A stop or
crash may still leave started work ambiguous; inspect and reconcile effects
before retry. Never use a blanket `pkill pi` or stop other users' services.

## Inventory and dry-run

1. Run `npm run doctor`. Record the effective paths/build/protocol, registered
   owners, in-flight work and any service incompatibility. Registration reports
   are **not** a complete inventory of legacy Pi processes: an unregistered
   process cannot report its loaded module bytes. PID start time is only a hint.
2. Identify the specific old scheduler timer and Pi sessions using this HOME
   and the explicitly listed project stores. Ask their owners to let scheduled
   work settle, then `/reload` in those sessions. Preserve session ownership;
   restarting an unrelated session is not required. Inspect legacy locks and
   GitHub/Slack/application receipts before deciding an executor is gone. The
   tool never guesses this from lock age, removes an unknown lock, infers a
   missing owner, or kills a process.
3. Create a private manifest (mode 600) with **every** legacy project store and
   one explicit reviewed binding for every job, including disabled jobs:

```json
{
  "version": 1,
  "projects": ["/absolute/workspace"],
  "bindings": [
    {"id": "background-id", "target": "background", "executionCwd": "/absolute/workspace"},
    {"id": "session-id", "target": "session", "executionCwd": "/absolute/workspace", "ownerSessionId": "creating-session-uuid"}
  ]
}
```

Existing target/owner/workspace bindings cannot be reassigned by migration.
Ownerless jobs require an actual owner decision, not a guessed current session.
Only known version-1 JSON stores are accepted; unknown fields/schema or unreadable
history are diagnosed in place, **without quarantine or deletion**. Supported
legacy defaults for missing action/prompt/missed-window/tier fields are retained;
no cadence or next slot is recomputed. Initial import requires an empty authority
store; independent existing authorities must be reconciled separately, not merged
blindly. The project list is explicit: no recursive workspace or credential scan.

```sh
npm run migration -- dry-run --plan /private/manifest.json
```

For a disposable rehearsal add `--home /absolute/disposable-home`. Dry-run writes
nothing. It prints IDs/owners/next slots and hashes, not prompts, credentials or
application-history contents. All commands use the selected HOME; do not point a
rehearsal at the live user or live project paths.

## Cutover and interrupted-stage recovery

1. If the new dispatcher is already running, pause admission first:
   `npm run migration -- pause --attestation 'cutover maintenance'`. New claims,
   offers, starts and job mutations stop durably, including after a restart.
   Existing completion and explicit reconciliation remain available. Configure
   the existing watchdog's bounded `maintenanceUntil` window in
   `~/.pi-schedule-watchdog/config.json` for this maintenance interval (see
   [watchdog operation](WATCHDOG.md)); scheduler pause does not silently disable
   independent monitoring. Stop the
   legacy **timer** to prevent new worker starts:
   `systemctl --user disable --now pi-schedule-worker.timer`.
   Let an already-running worker and affected session turns finish; do not kill
   unrelated processes. An old service that does not support pause must be
   drained and stopped before using this build.
2. Resolve active/ambiguous authority runs through the existing
   `reconcile_execution` protocol, confirming executor stoppage and effects.
   Preserve outcomes; don't replay a mutating run merely because its process
   disconnected. Remove only individually inspected, confirmed obsolete legacy
   lock files after their executors/effects are reconciled. The migration refuses
   any remaining legacy delivery/mutation lock, even if old.
3. Stop only the drained dispatcher:
   `systemctl --user stop pi-schedule-dispatcher.service`. Its lifetime SQLite
   lock excludes concurrent migration and dispatcher processes.
4. Apply with a non-secret record of the actual drain/reconciliation evidence:

```sh
npm run migration -- apply --plan /private/manifest.json --attestation 'affected schedulers drained/reloaded; executors stopped; receipts/effects reconciled: operator record reference'
```

   A mode-600 `~/.pi-schedule-authority/v1/migration.json` contains the durable
   original definitions/history bytes, checksums, explicit bindings and stage
   receipt. Treat this file as private data, not something to paste into chat or
   attach to a public PR. Preserve it and the full authority directory, including
   result artifacts. An off-host/private backup is prudent before live use.

   Stages are prepared → fenced → imported → active. Admission stays paused until
   import commits. The migration empties legacy stores and installs a permanent
   **delivery-lock-parent file tombstone**. Historical JobLockManager code cannot
   acquire any delivery lock through this path, even after its stale-lock age;
   it never reads the new authority namespace. Mutation-lock directory markers
   initially block old edits, but legacy code may rename those after 30 seconds
   and repopulate obsolete JSON. Such writes cannot execute through the delivery
   fence or alter authoritative jobs. They are preserved/diagnosed, and rollback
   refuses to overwrite divergent definitions/history. Do not remove the
   delivery-parent tombstone while the new dispatcher is active. These fences
   protect against stale cooperating software, **not malicious same-UID code**.
   Already-started effects require the prior drain check; fences cannot undo them.

   After interruption, rerun the **same manifest and command**. Backups and
   import identity are reused; IDs, owners, next slots and pending work are not
   recreated or advanced. A changed source after backup blocks activation and
   preserves both versions for reconciliation. Do not delete the receipt/fences
   or overwrite unknown state to make a retry pass.
5. Generate the unit, then activate after verifying counts/IDs/owners/cadence:

```sh
node docs/install-worker.mjs
systemctl --user daemon-reload
systemctl --user enable --now pi-schedule-dispatcher.service
npm run doctor
```

   Legacy worker timers must remain disabled. Reload identified clients when
   idle; the owner registers again with a new connection generation. Busy/closed
   session jobs remain pending for their exact owner. An unavailable dispatcher
   means pending work and read-only list/history, never a legacy fallback.
   Service diagnostics: `systemctl --user status pi-schedule-dispatcher.service`
   and `journalctl --user -u pi-schedule-dispatcher.service`. Logs/results may
   contain private application data; share only sanitized diagnostics.

Original legacy history remains verbatim in the receipt, with no invented
application-success interpretation. New fenced history remains in the authority
store and results directory. Compare these independently when auditing work.

## Compatible rollback

Rollback is an explicit operator action, not automatic error recovery. It supports
only the known **explicit-target legacy v1** format and a routing-compatible
legacy build (for example the reviewed `5adcd9e` lineage), never an ownerless
pre-routing scheduler. Verify the chosen build and gracefully reload affected
clients before releasing legacy admission. No generic version string proves
that an unregistered process has reloaded.

1. Pause new admission, drain, reconcile ambiguous effects and stop/disable
   `pi-schedule-dispatcher.service` (not unrelated Pi sessions). Leave the old
   timer disabled while restoring. Inspect `doctor` before stopping.
2. Run:

```sh
npm run migration -- rollback --attestation 'dispatcher stopped; new executors/effects reconciled; affected clients drained/reloaded to checked explicit-target legacy build: record reference'
```

Rollback records the **current** authority snapshot with all new runs/receipts,
restores compatible definitions with their advanced next slots/run counts/owners,
and appends post-cutover executions to the legacy history with full original
`authorityRun` receipts. Cancelled jobs restore disabled. Application success is
not inferred from delivery. Pending manual requests and new project scopes with
no reviewed destination block rollback instead of disappearing. Such a refusal
leaves admission paused. To abandon a refused rollback **before restoration**,
start the paused dispatcher and run `npm run migration -- resume`; this preserves
pending requests so they can complete or be cancelled through the normal owner
workflow. It refuses unfinished cutover/restoration or a completed rollback.
Then pause/drain/reconcile and stop the dispatcher again before retrying rollback.
Do not erase a pending request to satisfy the tool. Divergent obsolete legacy
edits/history must be preserved and reconciled explicitly; they are never silently
replaced, including if they appear during interrupted restoration.

Before releasing any legacy fence, rollback durably parks the new authority in
`rolled-back` maintenance; even accidentally restarting this dispatcher cannot
claim jobs. Legacy store mutation/delivery fences are released only after all
stores/history are restored. A repeated/interrupted rollback reuses its checkpoint
and never overwrites later legacy edits/history. Keep the retained authority and
receipt for forensic recovery. Do not manually enable new authority admission or
rerun forward import on a rolled-back receipt. A later forward cutover requires
reconciling the now-diverged legacy and authority states, not deleting a fence.

Only after restoration and compatibility checks should the chosen legacy service
be re-enabled. Never enable old and new dispatch together. A rollback does not
prove live reliability or exactly-once external effects.
