# Independent receipt watchdog

`npm run watchdog` is a deterministic one-shot check. It imports no Pi agent,
model or MCP discovery code, never starts/retries/stops workloads, and opens the
[authority database](AUTHORITY.md) read-only. The dispatcher writes
`~/.pi-schedule-authority/v1/dispatcher-health.json` after each successful scan.
A healthy systemd timer alone is **not** proof that scheduling or work succeeded.

## Checks and interpretation

| Observation | Default |
| --- | --- |
| Missing/invalid dispatcher health or last successful scan older than 2 minutes | Incident |
| Background due slot or claimed slot without a start, more than 2 minutes overdue | Incident |
| Prompt still running more than 12 minutes after start (worker limit: 10 minutes) | Incident |
| No successful application completion by scheduled slot + 12 minutes | Incident |
| Failed execution, invalid application receipt, failed/partial/blocked application or failed notification receipt | Incident on next check |
| Unknown executor/effects after dispatcher restart | Reconciliation incident, never permission to replay |

Completion is based on **slot time**, not lastRunAt or the next cadence. An early
manual slot uses its claim time. Application success is `succeeded`,
`no_candidates` or `escalated`; a failed notification remains an incident.
Generic prompts without an application receipt remain unverified and eventually
alert, even if the process exited zero. See [outcome receipts](OUTCOMES.md).

Disabled/cancelled jobs and intentional maintenance appear distinctly. Automatic
once/maxRuns termination does not hide an unsuccessful final attempt. Session
work waiting for its exact idle owner is `owner_unavailable_or_busy`, not a
background start failure; the watchdog does not infer whether that owner is
closed or busy. An already-started session run still has completion deadlines.
A pre-effect interrupted offer is not failed work.

One incident per store/job (and one dispatcher incident) deduplicates changes of
reason, missed slots, restarts and sleep catch-up. A backwards clock jump or new
attempt is not recovery. Success, explicit disable/removal, or maintenance emits
one recovery; its status says which, rather than inventing application success.

## Slack and local fallback

The direct `https://slack.com/api/chat.postMessage` transport follows the existing
non-agent bot path in `infra/scripts/drive-sprint.sh` (`slack_notify`). It reads
`SLACK_BOT_TOKEN` and an explicit `SLACK_CHANNEL` from the service environment.
Use existing authorized credential references and the intended alert channel;
no new scopes, credentials in source/argv, MCP discovery, or agent tools are
required. This repository does not provision credentials or choose a live channel.

Private `~/.pi-schedule-watchdog/` files:

- `alerts.json`: atomic incident/outbox state, persisted **before** sending.
- `delivery-receipts.jsonl`: event ID, attempt, time, sent/failed and Slack message ID.
- `status.json`: observations, open incidents, undelivered/exhausted events and action.
- `check.sqlite`: process-lifetime single-check lock, separate from scheduler state.
- `config.json`: optional maintenance configuration (below).

One attempt per pending event per check, at most **three total attempts** per
event and **five sends per check**, with a **10-second** network timeout each.
No retry loop starts a workload. Failure writes local receipts/status and the
command exits nonzero for incidents or undelivered events. The journal receives
status output; a config/state/lock error exits nonzero with local repair guidance.
Corrupt/unsupported alert state is preserved, not reset silently.

Exhausted events remain visible, even after a recovery is delivered. After fixing
credential references/network/Slack and reconciling remote receipts, an operator
may reset that event's attempts to retry, or mark it delivered to acknowledge it
locally. Stop the watchdog timer while editing alerts.json. Do not delete all
state to retry one event: that loses deduplication history. Retention of receipt
history is operator-managed. A crash between Slack acceptance and local receipt
persistence can duplicate a post; event IDs aid reconciliation, not exactly-once
delivery. Counting attempts before sending bounds crash retries too.

## Maintenance

An optional `~/.pi-schedule-watchdog/config.json` may contain:

```json
{
  "maintenanceUntil": "2026-11-12T12:00:00Z",
  "maintenanceJobIds": ["example-job-id"]
}
```

`maintenanceUntil` suppresses dispatcher/job incidents until that timestamp;
`maintenanceJobIds` suppresses only listed jobs until removed. Neither changes
schedules, stops an executor, nor authorizes replay. This affects watchdog
reporting only. Remove expired/stale maintenance entries when work resumes.

## Unit templates (not installed by package import)

[Service template](pi-schedule-watchdog.service) and
[timer template](pi-schedule-watchdog.timer) run every minute, independently of
the dispatcher and reviewing agent. Use Node >=22.13 and the selected checkout's
installed `tsx` loader. Replace **all absolute placeholder paths** in the service
(including WorkingDirectory and ExecStart); quote paths containing spaces and
escape systemd specifiers when necessary. Copy the units to
`~/.config/systemd/user/` only during authorized installation. Bind an existing
private environment reference via `~/.config/pi-schedule/watchdog.env` (mode 0600)
or an equivalent service credential mechanism. Never paste secret values into
unit files, reports, repository files or command arguments.

After path/config review, validate with `systemd-analyze --user verify` and use
`systemctl --user daemon-reload` / `enable --now pi-schedule-watchdog.timer` at
the live installation boundary. This task supplies templates, not trebby cutover.
`Persistent=true` runs one catch-up after sleep, not one check per missed minute.
The 75-second service budget covers five bounded sends; systemd does not overlap
the same oneshot service, and the private lock also rejects manual concurrency.

Independence is from **the reviewing agent/model/MCP**, not from the host,
systemd, local disk, network or Slack. A powered-off host cannot alert from this
watchdog. Slack/network outage means actionable local fallback, not guaranteed
remote delivery. Off-host monitoring and live failure/recovery canaries are
separate operational work; local mocked tests do not prove deployed delivery.
