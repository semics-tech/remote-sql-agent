# FAQ

## Does this replace SQL Server Agent?

No. SQL Agent remains the execution engine, and nothing here schedules or runs a
job.

The worker reads `msdb` and, when permitted, calls the documented Agent stored
procedures — `sp_update_job`, `sp_add_jobstep`, `sp_start_job` and so on. It is
doing exactly what you would do in SSMS, from a different window.

Stop the worker and every job keeps running on schedule. Uninstall it and
nothing changes except that you lose the central view.

## What happens if the control plane goes down?

Nothing on your SQL Servers. Jobs keep running; Agent neither knows nor cares.

Workers keep polling and queue history and log deltas to a local SQLite outbox,
draining it when the control plane comes back. You lose the dashboard, not the
estate.

## What happens if a worker goes down?

You lose visibility of that instance. Its jobs keep running.

Commands are never queued worker-side: an offline worker cannot receive them, so
the control plane holds them and expires them after 15 minutes. A change that
has been waiting that long should be re-issued against current state rather than
applied to an estate that has moved on.

## Do I need to open firewall ports to my SQL Servers?

No, and this is the whole point. Workers dial **outbound** to the control plane
on one port. No inbound rule on any SQL host, and no listening socket in the
worker at all.

The control plane never initiates a connection to a worker. If a feature ever
seems to require that, it is the wrong feature.

## Why does the Agent error log tab say nothing is readable?

Reading the Agent error log needs `xp_readerrorlog`, which requires
`securityadmin` or `sysadmin` — rights a correctly least-privileged worker login
does not have.

Rather than ask for them, the worker detects the permission error and disables
log streaming for that instance. Job definitions, history, activity and drift
detection all still work; only the Agent's own log is unavailable.

If you want it, grant `EXECUTE` on `xp_readerrorlog` to the worker login and
restart the service. Weigh that against widening what a compromised worker
login could do.

## Someone edited a job in SSMS. What happens?

It shows up as a new version marked **on-premise edit**, the job gets a drift
badge, and the Versions tab diffs it against what was there before.

Drift is normal and expected — DBAs will keep using SSMS, and they should be
able to. It is surfaced, never silently overwritten.

## What if two people edit the same job at once?

The second one is refused with a `Conflict`, and the job is left untouched.

Every edit carries the hash of the definition it was made against. Before
applying, the worker re-reads live state and compares. If it has moved, the
command fails and the dashboard offers a choice: reload and redo the edit on top
of the current version, or explicitly overwrite. Overwriting is itself recorded
and audited.

Never last-write-wins.

## Can I trust that what I see is what is on the server?

The definition you see is what the worker last read from `msdb`, at most one
poll interval old (30 seconds by default).

Two things make it trustworthy rather than merely plausible:

- The control plane recomputes the SHA-256 of every definition it receives
  rather than trusting the hash the worker sent. A worker that has been taken
  over cannot make two different definitions share a hash to hide a change.
- Round-trip fidelity is tested on every CI run: a definition sent from the
  dashboard is byte-for-byte identical when read back from `msdb`.

## Why is run history sometimes behind?

Because SQL Server only writes a `sysjobhistory` row when a **step completes**.
That is a SQL Server limitation, not a sync delay: a job that has been running
for an hour has written nothing yet, and SSMS shows the same gap.

The Activity view fills in from `sysjobactivity`, which is why a running job
shows as running even with no history rows yet.

## Why did my new worker not import years of history?

Deliberately. A new worker seeds its high-water mark near the current maximum
rather than replaying the whole of `sysjobhistory`, which on a busy instance can
be millions of rows.

Everything from the moment the worker was installed is captured. If you need the
back-catalogue, it is still in `msdb` where it always was.

## Can one worker manage several instances?

Yes — one worker per **host**, handling every named instance on it. Pass them
all at install:

```powershell
.\install.ps1 ... -SqlInstances MSSQLSERVER,INST2,INST3
```

Managing an instance on a *different* host from the worker is deliberately not
supported: it would mean the worker holding credentials for machines it does not
live on, which widens the blast radius of a compromised worker considerably.

## How do I stop a worker being able to change anything?

Set `maxCapability: readOnly` in its `worker.yaml` and restart the service. That
ceiling cannot be raised by the control plane, so it holds even if the control
plane is compromised. See [capabilities.md](capabilities.md).

## Is the audit log complete?

Every sign-in, administrative change, worker session event and command — issued,
approved, rejected, applied or refused — is recorded. The audit module has no
update or delete path, and none should be added.

An administrator with direct database access could still edit the table. Genuine
protection against that means shipping the log off-box; export over OTLP is
built in, and [authentication.md](authentication.md) §3 covers the common
destinations.

## Are job definitions encrypted in the database?

No, deliberately. They are stored as searchable `jsonb` because cross-estate
search over step-body text — "which servers still reference `LEGACYFIN01`?" — is
one of the main reasons to run this at all, and encrypted blobs cannot be
searched.

Job step bodies routinely contain connection strings, so treat the Postgres
volume and its backups as sensitive: encrypted volume, encrypted backups,
restricted access. [security.md](security.md) has the full reasoning and a
checklist.

## Can I run more than one control plane for high availability?

Not yet. The worker registry is in-memory, so a worker is only reachable from
the node holding its socket. Running two would give you an estate where half the
commands silently never arrive.

Postgres can be made highly available independently; the control plane process
cannot, for now.

## Why TypeScript for something that talks to SQL Server?

One language across worker, control plane and dashboard means one shared
contracts package — the canonical `JobDefinition.v1` schema and its hashing are
used identically by the worker reading `msdb` and the server storing and diffing
it. Two implementations of that would drift, and the drift would look exactly
like a product bug.

For a project whose core risk is a security-critical write path, a codebase one
maintainer can fully review matters more than picking the theoretically ideal
language per component.
