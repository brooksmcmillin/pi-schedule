# Authoritative storage and claim contract

This foundation is **not activated** by the current extension or worker. Dispatcher
integration, migration, supervision and runtime cutover are separate work. Do not
copy active jobs into both stores or point the legacy runner at authority files.
Merging this code is not live scheduler verification.

## Namespace and compatibility

`authorityPaths(home)` selects `~/.pi-schedule-authority/v1/authority.sqlite` and
`control.sock`. All global/project definitions live in this namespace; project
scope remains definition metadata, not another authority file. Legacy
`~/.pi-schedule/schedules.json`, `.pi/schedule.json`, run ledger and lock paths
are unchanged and never read by `AuthorityStore`. This isolates accidental old
software, **not malicious processes with the same UID**.

The directory is mode 0700 and database mode 0600. SQLite is built into Node
>=22.13 (experimental in Node 22). Transactions use `BEGIN IMMEDIATE` and a bounded
5-second busy timeout, not timestamp-based lock stealing. SQLite releases its
write lock when a process exits. Unsupported database/document versions and invalid
state fail without quarantine, deletion or substitution of empty jobs. Back up
using SQLite's supported backup facilities or while the authority is closed;
do not copy a live database without its journal.

Definitions require explicit target, absolute execution workspace and, only for
session targets, owner session ID. Existing schedule/action/policy/payload fields
are retained. `addJob` only inserts: it cannot overwrite a job around a run fence.
Job editing/removal and scheduling policy belong to dispatcher integration.

## Atomic claims

A claim persists store ID, job ID, slot ID, unique run ID, monotonic per-job
generation, executor owner ID, protocol/build identity and timestamps before any
external effect. Slot IDs are opaque stable identifiers supplied by the dispatcher
(for example a due timestamp, or a unique manual-request ID); use the same slot ID
when retrying a request. A completed/failed slot cannot be claimed again.

Only one active (`claimed` or `started`) run is allowed per job, across all slots.
No time-based automatic reclaim exists. `start`, `interrupt` and `acknowledge`
require the entire fence. Acknowledgment changes execution state, next due time
and run count atomically; once/maxRuns termination is preserved. Execution
completion does **not** assert application success, and legacy `lastStatus` is not
promoted to an application receipt.

`interrupt` requires a reconciliation explanation and the current fence. Its
caller must first stop/reconcile the prior executor and uncertain external effects;
only then may it authorize a replacement attempt for that slot. Replacement
increments generation and gets a new run ID. Prior starts/interrupts/acknowledgments
cannot mutate that run or advance the job. This is a local cooperating-software
contract, not proof that the caller actually stopped a process.

Leases alone cannot establish executor death. Generation fencing protects store
transitions, not external systems: it cannot guarantee exactly-once Slack posts,
GitHub merges or other effects. Crash recovery must reconcile external receipts
before replay. Do not treat an elapsed timeout as authorization to duplicate work.

## Unix-socket protocol v1

`listenAuthority(store, home)` binds only the private `control.sock`; it does not
scan due jobs, execute work or start a daemon. `AuthorityClient(home, buildId)`
uses one newline-delimited JSON request/response per connection, with a 1 MiB
frame limit and 5-second I/O timeout. Envelopes carry `requestId`,
`protocolVersion: 1`, `schemaVersion: 1`, `buildId`, and `request`. Request IDs bind
responses, not replay authorization. Client versions are checked before dispatch;
incompatible clients get actionable upgrade/reload errors without mutations.

Operations are `snapshot`, `add_job`, `claim`, `start`, `interrupt` and
`acknowledge` (see exported `AuthorityRequest`). Every transition carries a full
fence; claim build identity comes from the validated envelope. Responses carry
matching version/request identity and either `{ok:true,result}` or
`{ok:false,error:{code,message}}`. This is a cooperating same-user interface,
not an authorization boundary between local clients.

An existing listener is never unlinked/taken over. An absent/broken authority
returns startup/reload guidance, not legacy execution. Transport failure can
mean the mutation outcome is unknown: inspect persisted state before retrying.
An oversized snapshot returns `FRAME_TOO_LARGE`; inspect state locally instead
of interpreting it as an empty store. Shutdown closes only this listener's
connections; it does not stop any executor or alter claims.

## Verification limits

`test/authority-store.test.ts` exercises actual competing OS processes, retained
fences, malformed/unknown versions, and legacy `ScheduleStore` reads/writes in a
temporary home. `test/fixtures/authority-process.ts` reopens persisted state in a
fresh process. These tests prove local namespace isolation and transactional
behavior, not live migration, malicious same-UID containment or external exactly-once
execution. They never load production jobs or run merge-capable work.
