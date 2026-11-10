# Dispatcher operation

One long-lived dispatcher per user owns scheduling and all authority mutations.
Start the entry point with Node >=22.13 from an installed checkout:

```sh
npm run dispatcher
```

For continuous operation, a user supervisor must run the equivalent absolute
command (`node --import <absolute tsx loader> <absolute src/dispatcher.ts>`) with
Pi on PATH, a stable HOME, `Restart=on-failure` and process-group shutdown. This
change supplies the restartable service entry point, not an installed service,
legacy migration or a live cutover. Those are separate deployment work. Do not
run the historical worker installer as a replacement for dispatcher supervision.

The service holds a separate SQLite writer lock for its lifetime. A second
instance fails without stealing the live socket. After a crash, SQLite releases
the lock; its next holder may remove an unresponsive old socket. A responsive
foundation authority listener must be stopped first, never unlinked while live.
State lives only in `~/.pi-schedule-authority/v1/`; old scheduler JSON is untouched.
This is cooperating same-user software, not containment against malicious code
running with the same UID. Unix sockets are required; Windows service support is
not supplied by this dispatcher transport.

## Clients, ownership and failures

- The extension registers only a schedule client and an owner receiver, not a
  local due-job ticker. The compatibility worker CLI requests dispatcher scans.
- Create sends definition fields only. Dispatcher time sets initial timing and
  IDs; create/edit/cancel/manual-run requests are centrally arbitrated. Scope
  limits and the create rate limit are enforced in the dispatcher.
- Global/project scope controls listing/edit visibility. Delivery additionally
  requires the explicit target, absolute execution workspace and, for session
  work, exact session ID plus current registration generation.
- Each idle receiver pulls one offer. The dispatcher claims it before offering;
  receiver checks current identity/idle state, requests a fenced begin, executes,
  then sends a fenced acknowledgment only after execution. Prompt handoff is
  recorded separately; the receiver waits for `agent_settled` before completion.
  Application and notification receipts remain separate from both. Becoming busy before any effect safely
  defers the offer. Busy/closed owners are never substituted or sent follow-ups.
- Reconnection revokes unstarted offers. Restart may reconcile claimed/pre-effect
  offers, but **started** runs remain active/ambiguous: inspect history, child
  processes/results and external effects before explicit recovery. Age is not
  permission to replay a mutation. There is deliberately no automatic replay API;
  [explicit reconciliation](OUTCOMES.md) closes an unknown attempt without replaying it.
- `run_now` returns pending/superseded, not invented completion. It preserves
  manual override of disabled/nonterminal jobs and missed-window skip; automatic
  scans still ignore disabled jobs. Re-enabling clears a once/maxRuns terminal
  flag as before. Cancel retains a hidden definition for historical run fences.
- Missing/incompatible dispatcher gives actionable status. List/history use a
  read-only persisted authority view; no local JSON or scheduling fallback exists.
  A transport error can mean an unknown mutation result: inspect list/history
  before retrying. Execution acknowledgment is not application outcome certification.

## Lifecycle/consumer map and verification

| Transition | Producer → consumer / authority | Focused check |
| --- | --- | --- |
| Startup | `Dispatcher.start` → singleton lock/socket → background scan | Concurrent-start and restart tests |
| Wait | `SchedulerClient.listForCwd` / `OwnerReceiver.poll` → pending due definitions; no substitute owner | Busy/closed and offline tests |
| Dispatch | `Dispatcher.prepare` → persisted fence → background executor or exact receiver begin/finish | Six-process duplicate-slot benchmark and composed action tests |
| Restart | Authority runs → new dispatcher; claimed pre-effect recoverable, started ambiguous blocked | Restart/pre-effect/ambiguous-mutation tests |
| Replay | Same captured slot → transactional claim; generation on every start/ack | Concurrent manual/timer and stale-connection tests |

`authority-protocol.ts` owns runtime TypeBox request schemas; `AuthorityRequest`
is derived from them, with no generated-client refresh. `tool.ts`, `client.ts`,
`receiver.ts`, `worker.ts` and the dispatcher are direct consumers. CI's build job
has no PR path filters and runs typecheck plus all `test/*.test.ts` through Vitest;
new dispatcher/client/receiver/worker tests are included. Local benchmarks use
real Unix sockets, SQLite and competing OS clients, with synthetic owner UI/model
and background executor seams. They do not prove deployed service supervision,
model behavior, application success, cross-host routing or a successful live cutover.
