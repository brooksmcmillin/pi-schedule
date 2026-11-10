# Session-owned and background schedules

See [dispatcher operation](DISPATCHER.md) before running this version. Legacy
worker timers are not dispatcher supervision. The installer now generates a
dispatcher service; [migration and rollback](MIGRATION.md) are explicit commands.

| Goal | Target | Where it runs |
| --- | --- | --- |
| Current-task continuation or conversation reminder | `session` (default) | Exact creating session/workspace, while idle |
| Independent recurring scan/report/check | `background` (explicit) | Fresh headless Pi process per prompt run |

`scope=global/project` selects visibility in the authority store, not execution.
The tool captures the session ID and absolute workspace. A UUID inside prompt
text is not routing metadata. `run_now` requests dispatcher arbitration: it never
injects a background or foreign-owner job into the calling chat. Session-target
manual requests require the matching requester session and workspace; missing or
foreign identity is rejected rather than inferred.

Busy or closed owners stay visibly pending. On reconnect, `catch_up_one` fires
one overdue slot and `skip` advances a missed slot without execution. Registered
connection generations fence delivery starts and acknowledgments; an old
connection cannot complete a replacement generation's run. A session switch after
an effect starts may leave an ambiguous run for reconciliation, not automatic replay.

Background jobs retain their creating workspace and use normal Pi credentials,
settings, instructions and extensions. **Fresh context is not an OS sandbox or a
transfer of session-owned authority.** The executor explicitly loads the tier
guard and suppresses the schedule client in children. Tiers cover named built-in
tools and schedule mutations, not every possible custom/MCP tool.

## Trigger and results

`npm run worker` is now only a dispatcher scan request. `npm run worker -- --job ID`
requests manual arbitration in the command's workspace. It cannot execute without
the dispatcher. `--project` discovery is retired: project jobs must be explicitly
registered with their workspace; legacy JSON files are never scanned.

Prompt runs save private files under
`~/.pi-schedule-authority/v1/results/<runId>/`:

- `sessions/`: fresh transcript, never a resumed controller session
- `stdout.log`, `stderr.log`: headless process output
- `result.json`: run/job/workspace identity, status and timestamps

History links execution details. No background result enters an interactive
session. Background notify/message actions write to the service log. Shell output
and exit status remain on the job. Retention/pruning is an explicit operator action.

The child timeout is 10 minutes. Timeout, service shutdown and parent completion
clean up the run's process group. A successful child means execution completed,
not application success. On unexpected dispatcher death, started executions stay
blocked until their processes and external effects are reconciled. This does not
guarantee exactly-once external side effects.

## Existing host compatibility and migration

The historical host footer fix is retained in
[codex-limit-headless.patch](codex-limit-headless.patch); nonzero headless exits
are still errors, never ignored. Use the [restartable migration/rollback
procedure](MIGRATION.md) for inspected jobs with explicit ownership and current
authorization. Drain/reload the identified affected schedulers when idle, not
every unrelated Pi process. The receipt preserves original definitions/history;
legacy paths are fenced before new admission activates. Live trebby cutover is a
separate operator action. Do not blindly replay old session continuations or run
both namespaces as if they were synchronized.
