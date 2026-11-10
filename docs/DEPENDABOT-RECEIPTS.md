# Dependabot report adapter (package-owned integration)

`src/dependabot-receipt.ts` projects the existing private report shape
(`runId`, `scannedAt`, `completedAt`, `totalCandidates`, `decisions`, `escalations`,
`deferredCount`, `errors`, `delivery.success`) into the scheduler's bounded
[application receipt](OUTCOMES.md). It does not change merge eligibility,
certify judgments, send Slack messages, or replay a review. Live prompt/policy
installation belongs to the separately admitted runtime cutover.

The report must use the **current scheduler run ID**, not its own unrelated ID.
For a background report producer, take that from `PI_SCHEDULE_RUN_ID`. The worker
also supplies `PI_SCHEDULE_JOB_ID` and `PI_SCHEDULE_RECEIPT_PATH`.

After persisting the final private report, an existing authorized report producer
can import `writeDependabotReceipt(reportPath)` or use the package-owned CLI:

```sh
node --import tsx /absolute/pi-schedule/src/dependabot-receipt.ts /private/report.json
```

This atomically writes only the receipt to the worker's assigned receipt path
(mode 0600) and prints that same bounded projection. It requires the current
worker environment and rejects a stale report without overwriting a receipt.
It never reads scheduler policy or credentials and never sends notifications.
A read-only agent need not invoke a shell: it can directly call
`schedule_outcome` with the classifications from its report. Owner-session
integrations can use `dependabotReceipt(report, currentRunId, currentJobId)` and
pass its result to `schedule_outcome` instead of writing a background file.

## Mapping

| Report observation | Application | Notification |
| --- | --- | --- |
| Completed scan, zero candidates | `no_candidates` | Final delivery classification |
| Completed scan with escalations | `escalated` | Final delivery classification |
| `scanStatus: "not_started"` or `status: "blocked_before_scan"` | `blocked_before_scan` | Final delivery classification |
| Started scan without completion, errors, deferred candidates, or `scanStatus: "partial"` | `partial` | Final delivery classification |
| Completed scan with decisions and no preceding partial/escalation condition | `succeeded` | Final delivery classification |
| Insufficient scan/completion facts | `unverified` | Still retained separately |

Successful completion classifications require chronological scan/completion
timestamps, a nonnegative integer candidate total, an explicit errors array, and
matching decision coverage with nonempty decision strings. Optional deferred and
escalation fields may be absent; when present they must have their ordinary
count/array shape. Fewer decisions than candidates is partial; malformed or
contradictory completion facts stay unverified without discarding notification
observations. Extra private report fields remain accepted but never copied.
This is structural best-effort interpretation, not semantic review certification.

`delivery.success: true` means `sent`; false means `failed`. A legacy failed-message
artifact with `status: "not_sent"` records notification failure. It does **not**
prove whether a scan ran: supply `scanStatus: "not_started"` when the report
producer actually knows it stopped before scanning. Do not infer scan state from
free-form error text. `delivery.status: "not_required"` is explicit no-notification;
otherwise notification remains `unverified`.

Example blocked report (private explanations may remain in the input):

```json
{"runId":"<current UUID>","scanStatus":"not_started","status":"not_sent","reason":"Private diagnostic retained only in this report"}
```

Example completed scan whose Slack delivery failed:

```json
{"runId":"<current UUID>","scannedAt":"2026-11-09T00:00:00Z","completedAt":"2026-11-09T00:01:00Z","totalCandidates":0,"decisions":[],"errors":[],"delivery":{"success":false}}
```

Neither reasons, repository names, PR URLs, Slack channels/timestamps, reports,
stdout, nor tokens enter the projection/general history. The adapter tests use
synthetic private markers, a real CLI subprocess, and the composed background
executor → adapter → authority → history path. These establish receipt binding
and privacy-safe projection, not a live review or notification delivery.
