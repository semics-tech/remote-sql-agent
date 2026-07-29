# Roadmap, known gaps and outstanding decisions

What is not built, what was decided and why, and what has to happen before a
release. Kept separate from the README so the README can stay about *using* the
product.

Status is honest rather than aspirational. If something here says "not
implemented", it is not implemented.

---

## 1. Decisions taken

Recorded so they are not silently relitigated. Each was a genuine fork.

### Job definitions are stored unencrypted

**Decided: keep them as searchable `jsonb`.**

The architecture spec asked for app-level AES-GCM encryption at rest (§6.6) and
also for cross-estate search over step-body text (§9.5). These cannot both hold:
encrypted blobs are not searchable by the database, and decrypting every
definition in the application on each search neither scales past a few hundred
jobs nor keeps the plaintext out of memory.

Cross-estate search — *"which servers still reference `LEGACYFIN01` in a step?"* —
is one of the main reasons to run this product at all, so it won. Encryption at
rest is delegated to the platform: encrypted volume, encrypted backups,
restricted database access. See [security.md](security.md).

**Consequence:** a Postgres backup contains every job definition in the estate,
and job steps routinely contain connection strings. Treat backups accordingly.

### Audit export is OTLP, not a vendor SDK

**Decided: OpenTelemetry logs, database as the source of truth.**

An earlier draft targeted Azure Monitor directly. OTLP keeps the destination the
operator's choice — Azure Monitor, Splunk, Datadog, Elastic and Loki all ingest
it directly or via a collector.

Worth restating because it surprises people: **Entra's own audit log cannot hold
these events.** It has no ingestion path for third-party application events, so
"user X edited job Y on SQLPROD03" will never appear there. Entra sign-in logs
cover authentication and need no configuration from us; everything else lives in
this product's audit log.

### Worker authentication defaults to an API key, not mTLS

**Decided: `token` mode is the default; mTLS and Entra workload identity are
available.**

mTLS is the stronger control, but CA custody, rotation and revocation are real
operational load, and making PKI the price of entry would keep this out of the
estates that need it most. An argon2id-hashed API key over TLS, revocable and
rotatable from the dashboard, is a defensible default.

**Consequence:** the key is a bearer secret, so the hub refuses to start without
TLS unless explicitly overridden. Sites that already run PKI should choose
`mtls`; sites on Azure should prefer `entra`, which stores no secret on the SQL
host at all.

### Steps are replaced wholesale on a job save

`sp_delete_jobstep` renumbers the steps after the one it removes. An incremental
reconcile would have to track shifting ids through a sequence of mutations and
would be wrong in exactly the case that matters — a step removed from the middle
of a branching job. Deleting all and re-adding in order is what makes the round
trip faithful.

**Consequence:** saving a job rewrites all of its steps, inside one transaction.
Run history is unaffected (it references step ids, not step rows).

### TypeScript everywhere

One shared contracts package means the canonical `JobDefinition.v1` schema and
its hashing are used *identically* by the worker reading `msdb` and the server
storing and diffing it. Two implementations would drift, and the drift would
present as a product bug — every job permanently flagged as changed.

---

## 2. Known gaps

Ordered by how likely they are to matter.

| Gap | Impact | Effort |
|---|---|---|
| No control-plane HA | A control-plane outage costs visibility, not job execution. Jobs keep running; workers queue to their local outbox and drain on reconnect. | Large |
| Worker certificate auto-rotation | `mtls` mode issues 90-day certificates but does not rotate them at 2/3 lifetime. Rotation is manual today. Token-mode keys rotate from the dashboard. | Medium |
| No MSI | The worker ships as a zip plus `install.ps1`. Fine for hand or script installation; awkward for SCCM/Intune, which want an MSI. | Medium |
| Deleting an operator | Explicitly refused. The command carries an instance-local operator id, which is not a safe identifier to delete by — the same id means different operators on different instances. Needs a protocol change to carry the name. | Small |
| Non-TSQL subsystem fidelity | Steps using a subsystem this version does not model are mirrored as `CmdExec` with a warning. Reading is safe; writing such a job back would change it. | Small |
| Approval notifications | Commands awaiting approval are shown in the dashboard but no one is emailed. An approver has to be looking. | Small |
| Retention partitioning | History and log tables are pruned by a scheduled delete, not partitioned. Fine to ~10M rows; large estates with long retention will want monthly partitions. | Medium |

### Control-plane HA, specifically

The worker registry is in-memory: a worker is only reachable from the node
holding its socket. Running two control planes today would give you an estate
where roughly half of all commands silently never arrive.

Making it work needs a shared dispatch path — the obvious shape is Postgres
`LISTEN`/`NOTIFY` on the commands table, with each node dispatching only to
workers it holds. Postgres itself can be made HA independently right now.

---

## 3. Before publishing

Must happen before the first tagged release.

- [ ] **Verify the npm scope is available.** Packages are named
      `@remote-sql-agent/protocol` and `@remote-sql-agent/worker`. The
      architecture spec called for this check before M0 and it was never done.
      If the scope is taken, renaming is mechanical but touches every import.
- [ ] **Verify the GitHub org/repo name.** `CODEOWNERS`, `SECURITY.md`, the
      package `repository` fields and the container image name all assume
      `semics/remote-sql-agent`.
- [ ] **Set repository secrets** for the release workflow: `NPM_TOKEN`.
      Container publishing uses the built-in `GITHUB_TOKEN`.
- [ ] **Enable branch protection on `main`** — see §5.
- [ ] **Decide the support commitment** before people depend on it. `0.x`
      versions currently signal that breaking changes may land in minors.

Not blocking, but worth doing early:

- [ ] Have someone who is not the author work through
      [quick-start.md](quick-start.md) on a clean machine. It is the only real
      test of whether the docs are right.
- [ ] Run the pen-test checklist in [security.md](security.md) against a
      deployed instance rather than a laptop.

---

## 4. Upgrading

### Database migrations

The control plane applies migrations automatically on boot. They are
forward-only; there are no down migrations, because a partially rolled-back
schema on a system holding an audit trail is worse than the problem it solves.

**Take a database backup before upgrading.** To roll back, restore the backup
and run the previous image.

### Worker and control-plane version skew

Workers and the control plane are versioned together but deployed separately, so
skew is normal — you cannot upgrade 50 hosts simultaneously.

- **Newer control plane, older workers:** supported. Unknown capability strings
  are dropped by older workers rather than passed through, and an unimplemented
  command is refused with `UnknownCommand` rather than guessed at.
- **Older control plane, newer workers:** works, but new worker features are
  inert. Upgrade the control plane first.

Retire a bad worker version across the estate without visiting hosts:

```bash
RSAGENT_MINIMUM_WORKER_VERSION=0.2.0
```

Older workers are refused at the hub, log exactly why, and keep retrying — so
upgrading the host is the entire fix.

### Suggested order

1. Back up Postgres.
2. Upgrade the control plane. Confirm existing workers reconnect.
3. Upgrade workers in waves, starting with a non-production host.
4. Once the estate is upgraded, set `RSAGENT_MINIMUM_WORKER_VERSION` to stop
   older ones reappearing.

---

## 5. Repository rules

Expected on `main`, and not enforceable from inside the repository — set them in
GitHub settings:

- Require a pull request before merging, with at least one approval.
- Require status checks to pass: `Typecheck, lint, unit tests`,
  `Integration (SQL Server + Postgres)`, `Dependency audit`, `CodeQL`.
- Require branches to be up to date before merging.
- Require conversation resolution.
- Dismiss stale approvals when new commits are pushed.
- Restrict force pushes and deletions.

Extra scrutiny is warranted on:

- `packages/worker/src/sql/agent-writer.ts` — the only code that mutates a
  customer's SQL Server
- `packages/worker/src/command-handler.ts` — the five gates before it
- `packages/protocol/src/canonical.ts` — a change here can flag the whole estate
  as drifted
- anything under `packages/server/src/auth/` or `worker-auth/`

`CODEOWNERS` already flags these for review.

---

## 6. Deferred backlog

From the architecture spec, not yet started and not currently planned:

- Job templates deployed to many instances at once
- Proxy and credential management
- Remote-instance workers (worker on host A, SQL on host B) — deliberately
  deferred: it means the worker holding credentials for machines it does not
  live on, widening the blast radius of a compromised worker
- SQL Managed Instance support
- Webhook/Teams/Slack alerting on drift and failure
- SIEM export beyond OTLP
