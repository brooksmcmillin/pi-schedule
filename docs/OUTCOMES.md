# Execution and application receipts

Dispatch is not execution completion, and execution completion is not application
success. `schedule history` renders these independently, including notification
status. Run rows retain store/job/slot/run/generation/owner identity, protocol and
build identity, claim/start/handoff/terminal timestamps when observed. Missing
historical fields remain unknown; old `delivered`/`ok` values are never promoted.

## Receipt contract

A scheduled agent's final action can call `schedule_outcome`:

```json
{"version":1,"runId":"<current run UUID>","jobId":"<current job ID>","application":"no_candidates","notification":"sent"}
```

Application classifications are `succeeded`, `no_candidates`, `escalated`,
`blocked_before_scan`, `partial`, `failed`, and `unverified`. Notification classifications are
`sent`, `not_required`, `failed`, and `unverified`. Escalation is a completed
application workflow, not proof that a candidate was merged. Notification failure
never erases the application result. These are reported outcomes, not independent
certification of model judgments or external effects.

The strict receipt contains only identity and enumerated classifications. Private
reports, repository contents, credentials, URLs and notification payloads do not
belong in it. Retain detailed evidence in the job's private report artifacts.
The [Dependabot adapter](DEPENDABOT-RECEIPTS.md) projects an existing report into
this contract without copying its contents.

For background agents the worker guard registers `schedule_outcome` and atomically
writes mode-0600 `results/<runId>/application.json` inside the private authority
directory. `PI_SCHEDULE_RUN_ID`, `PI_SCHEDULE_JOB_ID`, and
`PI_SCHEDULE_RECEIPT_PATH` identify the current attempt. The executor reads this
separately from process `result.json`. Exit0 without a valid bound receipt is
**execution-completed / outcome-unverified**. Invalid, malformed and stale receipts
remain unverified and get an invalid-receipt marker; they do not change a successful
process exit into a claim of failed application work.

For owner-session agents the receiver holds the fence until `agent_settled`, not
`agent_end` or `sendUserMessage`. `schedule_outcome` accepts only its pending run
and exact current session/workspace. Aborts/errors mark execution failed even if
an application receipt was recorded earlier. Session replacement/reload loses
that executor association and leaves execution unknown, not completed. This path
requires a host supporting `agent_settled`; no early-handoff fallback exists.

### Visible owner-session closeout

`schedule_outcome` terminates the turn: do not plan a reply after calling it.
For owner-session work, include a bounded, sanitized `handoff` alongside the receipt:

```json
{"version":1,"runId":"<current run UUID>","jobId":"<current job ID>","application":"partial","notification":"sent","handoff":{"summary":"Two fixture checks passed; one remains.","blocker":"Required fixture input is missing.","nextAction":"Supply the input, then finish the remaining check."}}
```

The tool renders the reported application outcome, work summary, blocker and next
action in its normal visible result before terminating. `notification=sent`
means an external notification, **not a chat reply**. A successful application
with a failed notification remains `application=succeeded, notification=failed`;
name the notification failure and the actual next action in the handoff. For
successful work with nothing pending, use `blocker="none"` and
`nextAction="No further action"`. An omitted handoff is visibly reported as
not provided, never inferred as success or absence of a blocker.

Only the strict receipt enters general scheduler history. Handoff text stays in
the owner session's tool-result transcript; it is not an independent certification
or proof of later dispatcher acknowledgement. Background tools keep their bounded
receipt-only output and discard any supplied handoff rather than copying private
report contents into output/history. Keep detailed reports in private artifacts.

## Cadence and last success

`nextRunAt` advances from terminal attempt time using the existing interval/daily
math. `catch_up_one` makes one attempt then reschedules from now; `skip` advances
an expired slot without execution. Failed attempts advance too, preventing a
failure on every dispatcher tick. `once` terminates after one terminal attempt;
`maxRuns` counts completed and failed attempts, not successes. While execution is
active/unknown, the job stays single-flight even if the due timestamp is past.

`lastSuccessfulCompletionAt` changes only for completed execution with a bound
`succeeded`, `no_candidates`, or `escalated` receipt. Later failures, partial or
blocked work, and skipped slots do not erase it. Notification success is separate:
application success with notification failure still updates application completion.
List shows this timestamp even when next due advanced; it does not infer a desired
success frequency or hide a late/missing successful outcome.

## Crash recovery (no automatic external-effect retries)

A restarted dispatcher safely interrupts **claimed/pre-begin** offers: its old
connection cannot begin them. Started work becomes `executor_or_effect_unknown`
and stays active, blocking replacement regardless of age. A dispatcher can die
while a detached child remains alive; acquiring its singleton lock is not proof
that the child or an external effect stopped.

Inspect executor/process liveness, private result/report files, and external
receipts first. Only when the executor has actually stopped **and** possible
external effects have been reconciled may an operator issue the local protocol
operation `reconcile_execution` with the original full fence,
`executorStopped:true`, `effectsReconciled:true`, terminal `outcome`, and an optional
bound `receipt`. This records terminal completion/failure and advances cadence;
it does not rerun the ambiguous slot. These confirmations are attestations, not
liveness probes or a same-UID security boundary. Never supply them from elapsed
time or a missing acknowledgment. Old generations still cannot alter current work.

Protocol v2 rejects v1 clients before mutation, because a v1 receiver acknowledges
handoff as completion. Reload clients and restart dispatcher together. Schema v1
continues reading old run rows (with protocol v1 provenance) without inventing new
evidence. No live migration, installation or policy change is performed here.

## Focused verification and limits

`outcome-visibility.test.ts` composes the real owner receiver/socket/store, Pi SDK
session, terminating tool, persisted transcript and default collapsed tool renderer
(at narrow and normal widths). A scripted model covers partial, blocked, successful
and notification-failure handoffs without another model request. It also exercises
the background worker guard's private receipt path. These unpaid fixtures prove
local message/rendering behavior, not live owner delivery or model compliance on
every run.

`run-outcomes.test.ts` covers receipt binding, invalid/missing receipts, independent
outcomes and cadence. `client-receiver.test.ts` composes sockets, store and owner
hooks through settle, abort and replacement. `interrupted-runs.test.ts` SIGKILLs a
real fixture dispatcher before claim, after claim/start, and after a synthetic
file effect, then restarts it and verifies fencing/reconciliation. These controlled
local tests do not prove model judgments, live Slack/GitHub effects, a real merge,
or installed runtime supervision. CI includes all these tests without path filters.
