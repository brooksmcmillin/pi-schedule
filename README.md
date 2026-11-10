# pi-schedule

Recurring scheduled tasks for [pi](https://pi.dev) agents.

Give the agent a way to schedule work like:

- security reviews
- package / artifact version checks
- status polls
- any other recurring prompt-driven task

Published as a pi package (`pi install`).

## Install

Requires Node >=22.13 and a running per-user [dispatcher](docs/DISPATCHER.md).
Interactive clients never run a local scheduler. The [authority store](docs/AUTHORITY.md)
uses built-in SQLite. `node docs/install-worker.mjs` generates a supervised dispatcher
unit, and `npm run doctor` reports readiness and known client versions. Generation
and package installation do not migrate data or activate services: follow the
[explicit migration/rollback procedure](docs/MIGRATION.md) before live cutover.

```bash
pi install npm:pi-schedule
# or local
pi install ./pi-schedule
# or one-shot
pi -e ./src/extension.ts
```

## Execution targets (fork)

This fork defaults new jobs to `target=session`: the creator's session ID and
workspace are captured automatically, including for globally stored jobs.
They never fire in a different session. Use explicit `target=background` for
independent work: the dispatcher starts fresh headless Pi sessions, with
results saved outside existing conversations.

**Legacy ownership is never inferred.** Inspect each job's intended target and
authorization, then use the [restartable migration](docs/MIGRATION.md) to preserve
IDs, definitions, owners, cadence and history. Identify only affected schedulers
and their owners, let scheduled work settle, and reload those sessions when idle;
do not restart unrelated Pi work or blindly recreate job identities.

See [dispatcher operation](docs/DISPATCHER.md), [background semantics](docs/BACKGROUND.md),
and the [independent receipt watchdog](docs/WATCHDOG.md) for missed-start/completion alerts.
Install this fork with `pi install git:github.com/brooksmcmillin/pi-schedule@<ref>`,
replacing—not supplementing—the upstream package entry.

## How it works

| Piece | Behavior |
|-------|----------|
| **Tool** | `schedule` — create / list / cancel / enable / disable / run_now / history |
| **Kinds** | `prompt` (default) · `shell` · `notify` · `message` — what fires when due |
| **Storage** | Private `~/.pi-schedule-authority/v1/authority.sqlite`; global/project scope is metadata |
| **Syntax** | Intervals (`30m`, `2h`, `1d`) and daily wall-clock (`09:00`) |
| **Fire** | One dispatcher scans background slots every 30s; exact-owner inboxes are polled while idle |
| **Pending** | Busy/closed owners stay due; reconnect obeys missed-window policy, never substitutes another session |
| **Reliability** | Run ledger, single-flight locks, missed-window policy, privilege tiers, fire caps — see [docs/RELIABILITY.md](docs/RELIABILITY.md) |

Only the dispatcher changes definitions, timing, claims and acknowledgments.
The execution target, not storage scope, determines where work runs. With the
dispatcher offline, list/history read persisted state and mutations fail visibly.

**Compatibility:** owner execution completion requires Pi's `agent_settled` hook;
there is no handoff-as-completion fallback. Reload clients and restart the
dispatcher together for protocol v2. See [execution/application receipts](docs/OUTCOMES.md). On pi ≥ 0.84.1, privilege blocks also
*terminate* the scheduled turn early — a read-only/suggest job that attempts a
mutating tool ends without a wasted follow-up model call (mixed read+mutate
batches still report findings in text). On older pi the extra field is ignored
and blocks behave as before.

## Agent skill

The package ships a **`schedule` skill** (`skills/schedule/SKILL.md`) that
loads on-demand and teaches the agent *how to schedule well*: when to use
`kind` (prompt / shell / notify / message), `every` vs `dailyAt`, privilege
tier, shell `wakeOn`, the missed-window tradeoff, and self-contained prompts.
The tool is self-describing for mechanics; the skill owns the patterns.

## Agent tool

```text
schedule
  action: create | list | cancel | enable | disable | run_now | history
  name?:          short label (create)
  kind?:          prompt | shell | notify | message   (default prompt)
  prompt?:        task / reminder text; shell follow-up instruction
  command?:       shell only — run via bash -lc
  wakeOn?:        shell only — always | failure | success | never
  successPrompt?: shell only — agent text on exit 0
  failurePrompt?: shell only — agent text on non-zero / killed
  timeoutMs?:     shell only — default 60000, max 600000
  once?:          one-shot relative delay ("10m" / "30s"), then terminate (xor every/dailyAt)
  maxRuns?:       max deliveries (ok+error) before auto-disable
  every?:         "30m" | "2h" | "1d"   (xor dailyAt/once)
  dailyAt?:       "09:00"               (xor every/once)
  target?:        "session" | "background" (default: session; owner captured)
  scope?:         "global" | "project"  (storage only; background defaults global)
  missedWindow?:  "catch_up_one" | "skip"   (default catch_up_one)
  tier?:          "read_only" | "suggest" | "mutate"  (default read_only; shell→mutate)
  id?:            job id
  limit?:         history row count
```

### Job kinds

| kind | What happens | Agent turn? |
|------|----------------|-------------|
| **prompt** (default) | Inject isolated task contract | yes |
| **shell** | `pi.exec("bash", ["-lc", command])`; optional wake via `wakeOn` | only if wake fires |
| **notify** | UI/console reminder | no |
| **message** | Session custom message (display only) | no |

Shell jobs always store `tier=mutate` (command runs outside the agent tool path). Prefer `wakeOn=failure` for CI polls so success is silent.

### Lifecycle: `once` and `maxRuns`

- **`once`** — fire one time after a relative delay (`once="10m"`, `once="30s"`), then auto-disable. Ideal for reminders and delayed follow-ups. `run_now` won't re-fire a terminated one-shot — recreate it.
- **`maxRuns`** — cap a recurring job to N deliveries (counts ok + error; skips/locks don't count). After the cap, the job auto-disables with `terminated: maxRuns`. Re-enabling clears the flag and resumes counting.

A terminated job is disabled and excluded from due scans. `list` shows `[off/terminated:once]` or `[…:maxRuns]`.

### Examples

```text
# Daily STATIC security review at 09:00, project-scoped, read-only.
# (Static = read/search only. A git-driven "recent changes" review would need
#  bash, which read_only blocks — use tier="mutate" for that.)
schedule action=create name="security-review"
  prompt="Review the code under src/ for security issues (injection, auth bypass, exposed secrets). Summarize findings with file:line. If none, say 'No findings'."
  dailyAt="09:00" target="background" tier="read_only"

# Direct shell poll — no agent turn on green; wake only on failure.
schedule action=create name="ci-poll" kind="shell"
  command="gh run list --limit 1 --json conclusion -q '.[0].conclusion'"
  wakeOn="failure"
  failurePrompt="Latest CI run failed. Inspect logs and propose or apply fixes."
  every="5m" target="background" missedWindow="skip"

# Human reminder (no model tokens).
schedule action=create name="stretch" kind="notify"
  prompt="Stand up and stretch." every="1h"

# One-shot reminder in 5 minutes, then done.
schedule action=create name="break" kind="notify"
  prompt="Eye break — look 20ft away for 20s." once="5m"

# Bounded CI poll — stop after 10 checks even if still failing.
schedule action=create name="deploy-watch" kind="shell"
  command="gh run list --limit 1 --json conclusion -q '.[0].conclusion'"
  wakeOn="failure" failurePrompt="Deploy failed — investigate."
  every="5m" target="background" maxRuns=10 missedWindow="skip"

# Check package versions every day via an agent prompt that must use the shell.
schedule action=create name="pkg-versions"
  prompt="Run `npm outdated` for prod dependencies. Report only meaningful updates as current→latest with a one-line rationale. If nothing meaningful, reply 'No findings'."
  every="1d" target="background" tier="mutate" missedWindow="skip"

# List / history / force / cancel
schedule action=list
schedule action=history id=abc123def456
schedule action=run_now id=abc123def456
schedule action=cancel id=abc123def456
```

## Delivery rules

1. **Dispatcher**: one per-user service scans background jobs every 30s and owns all timing/claim changes.
2. **Session inbox**: clients register an exact session/workspace/connection generation and receive work only while idle; no local due-job scanner runs.
3. **Missed window**: `catch_up_one` fires one overdue slot; `skip` advances misses beyond grace. Busy/closed owners stay pending until their own reconnect.
4. **`run_now`**: requests dispatcher arbitration and reports pending/superseded, never invented completion. Session jobs require the requesting owner; background work never enters the requesting chat.
5. **Fences + history**: SQLite persists slot/run/generation identity before effects. History separates dispatch, execution, application and notification outcomes. Handoff or exit0 alone never proves successful work; `schedule_outcome` records a run-bound application receipt.
6. **Failure**: missing/incompatible service gives actionable status and read-only persisted list/history. Started runs surviving restart remain ambiguous until reconciled, never automatically replayed.

Fired jobs use a labeled prompt contract. Session delivery retains the owner's
conversation; only background delivery creates a fresh conversation:

```text
[scheduled-task]
runId: …
jobId: …
…

## Task
…

## Contract
- isolated run; do not invent findings; say "No findings" if empty
- PRIVILEGE: read_only | suggest | mutate
```

## File layout

```
~/.pi-schedule-authority/v1/
  authority.sqlite       # Global/project scope is metadata in one authority.
  dispatcher.sqlite      # Process-lifetime singleton lock.
  control.sock
  results/<runId>/       # Fresh background transcript/output/result metadata.

# Legacy ~/.pi-schedule/ and <project>/.pi/schedule.json are not scanned.
```

## Reliability

Deep dive: **[docs/RELIABILITY.md](docs/RELIABILITY.md)**.

Summary of MVP mitigations:

- External clock (`nextRunAt`), not LLM timing
- Missed-window policy + fire caps
- Transactional single-flight claims + slot/generation fences
- Durable run state (`history`); ambiguous started effects are not replayed
- Privilege tiers in the fire prompt
- Create rate limit + max jobs per scope

## MVP scope

- tool + skill (a `schedule` skill ships in `skills/`, teaching kind/tier/scope/missed-window choices and self-contained prompt writing); no dedicated `/schedule` slash command yet
- action kinds: prompt / shell / notify / message (shell via `bash -lc`, optional `wakeOn`)
- lifecycle: `once` one-shots + `maxRuns` bounded polling
- no cron expressions yet
- one supervised dispatcher unit generator and fresh headless background sessions; explicit restartable migration/compatible rollback tooling; live installation and cutover remain operator actions
- `delivered` = action executed (prompt injected / shell finished / notify shown), not “agent finished correctly”

## Dev

```bash
npm install
npm test
npm run typecheck
```

## Publishing

Releases are CI-driven: push a `v*.*.*` tag and GitHub Actions publishes to
npm with provenance. One-time setup (npm token + `NPM_TOKEN` secret) and the
per-release flow are documented in **[docs/PUBLISHING.md](docs/PUBLISHING.md)**.

```bash
npm version patch -m "release: %s"   # bumps package.json + tags
git push origin master --follow-tags   # triggers release.yml
```

## License

MIT
