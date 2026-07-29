# Notifications

Estate-wide alerting to email, Slack, Teams or a generic webhook.

This is separate from SQL Agent's own operator notifications, and deliberately so. SQL Agent can
already email an operator when a job fails — but it does it per instance, using Database Mail
configured per instance, and it knows nothing about the other forty-nine servers. It cannot tell you
"this job has failed on every server since Tuesday", or "this run is at three times its usual
duration", because it has no estate-wide view. That is what this does.

## Channels and rules

Two objects, kept separate:

- a **channel** is *where* — a Slack webhook, an SMTP relay, a URL to POST to;
- a **rule** is *what, for which part of the estate, and how often*.

Collapsing them into one would mean re-entering a webhook URL for every rule that used it, and
re-entering secrets is how they end up pasted in a wiki.

Configure both under **Administration → Notifications**.

## Events

| Event | Fires when | Typical use |
| --- | --- | --- |
| `job.failed` | A run finishes with a failure | The one everyone wants |
| `job.long_running` | A run passes both **2× its own average** and **+60s** over it | Catches a hung job that has not failed and never will |
| `job.recovered` | First success after one or more failures | Closes the loop without a message per successful run |
| `worker.offline` | A worker stops reporting for four heartbeats | Your view has gone stale — the jobs are still running |
| `command.failed` | A change from the dashboard was refused or failed to apply | Someone's edit did not land |
| `job.succeeded` | Every successful run | Noisy. You almost always want `job.recovered` instead. |

**`job.long_running` is measured per job, not against a global threshold.** A nightly index rebuild
that takes forty minutes is not a problem; a heartbeat job that has taken forty minutes very much
is. The baseline is the mean of successful runs over the last 30 days, and needs at least three of
them — below that, only a run over an hour is flagged. Failed and cancelled runs are excluded from
the baseline, because a job that fails in two seconds would otherwise drag it down until every
healthy run looked like an overrun.

## Throttling

Each rule has a throttle window, defaulting to 60 minutes. Within it, one alert per job per event
kind reaches a given channel. A job failing every five minutes should page once, not 288 times a
day.

Throttled alerts are **recorded as suppressed**, not dropped silently, and appear in
**Recent alerts**. That matters: someone who sees nothing arriving needs to tell "the throttle is
working" from "the pipeline is broken", and only the record can tell them which.

Set the window to `0` to send everything.

## Setting up each channel

### Slack

1. Create a Slack app for your workspace, enable **Incoming Webhooks**, and add one to the channel
   you want.
2. In **Administration → Notifications → Channels**, add a channel of type **Slack** and paste the
   webhook URL.
3. **Send test.**

The webhook URL is a bearer credential: anyone holding it can post to that channel. It is stored on
the control plane and never returned by the API — the dashboard shows only a hint like
`hooks.slack.com/…/T0A9`.

### Microsoft Teams

Channel → **Connectors** → **Incoming Webhook** → copy the URL. Messages are sent as MessageCard,
which is what Teams incoming webhooks ingest.

### Email

| Field | Notes |
| --- | --- |
| SMTP host / port | 587 negotiates STARTTLS; 465 needs **Implicit TLS** ticked |
| From | Must be an address your relay will accept |
| To | Comma-separated |
| Username / password | Leave blank for an unauthenticated internal relay — common and fine |

### Webhook

Receives the event as JSON:

```json
{
  "kind": "job.failed",
  "severity": "critical",
  "title": "Job failed: Nightly Backup",
  "summary": "Nightly Backup on sqlprod01\\MSSQLSERVER has now failed 3 runs in a row.",
  "occurredAt": "2026-07-29T02:00:11.000Z",
  "url": "https://rsagent.corp.example.com/instances/…/jobs/…",
  "detail": "DBCC CHECKDB found 2 consistency errors.",
  "payload": { "jobName": "Nightly Backup", "consecutiveFailures": 3, "…": "…" }
}
```

## Delivery

Delivery is queued, never inline. A dead SMTP server or a rate-limited Slack workspace delays a
notification; it must never fail the ingestion that produced it, because that would mean a broken
Slack integration stopped the estate being mirrored.

- Retries back off exponentially, capped at ten minutes, up to eight attempts.
- **Permanent failures stop early.** A revoked webhook returns 404, and retrying it for an hour just
  delays someone noticing. Authentication and configuration faults are not retried; 5xx, timeouts
  and 429 are.
- A channel that is failing is marked as such in the channel list with the error text.

## Deduplication

Every event carries a stable dedupe key, and the events table has a unique index on it. This is
load-bearing rather than defensive: the worker's outbox replays on every reconnect, so the same
failed run arrives more than once as a matter of course. Without the key, a worker restarting would
re-alert on every failure in its backlog.

| Event | Keyed on |
| --- | --- |
| `job.failed` / `job.succeeded` / `job.recovered` | The msdb history row id |
| `job.long_running` | The run's start time |
| `worker.offline` | The worker's last-seen time |
| `command.failed` | The command id |

## A sensible starting configuration

One channel pointed at your on-call Slack channel, and two rules:

1. **Production failures** — `job.failed` and `job.recovered`, scoped to your production instances,
   60-minute throttle.
2. **Estate health** — `worker.offline` and `job.long_running`, every instance, 60-minute throttle.

Leave `job.succeeded` off. Resist the urge to add it.
