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

### SQL credentials are relayed, not held

**Decided: the browser encrypts to the worker's public key; the control plane stores ciphertext it
cannot open.**

The requirement was to onboard a worker from the dashboard, including its SQL credentials, "in a
secure way — ideally the worker should not be able to see the credentials". That last part cannot
hold: a worker has to present a password to SQL Server, so it necessarily sees the plaintext. There
is no arrangement in which it does not.

The real risk was elsewhere. Storing credentials centrally in a form the control plane can decrypt
would put working logins for **every instance in the estate** inside the single component that every
network segment can reach by design — precisely the concentration this outbound-only architecture
exists to avoid. A control-plane breach would hand over fifty SQL Servers.

So the control plane became a courier. Each worker generates an RSA keypair on its own host at
enrolment and publishes only the public half. The dashboard encrypts a password in the operator's
browser (RSA-OAEP-SHA256, WebCrypto); Postgres holds a blob only that one host can open.

**Consequences:**

- The dashboard must be served over **HTTPS** for the credential field to work at all. `crypto.subtle`
  is undefined in an insecure context; the field is disabled with an explanation rather than falling
  back to plaintext.
- A host compromise still yields that host's own credential. Unavoidable, and why **integrated
  authentication is the default** — with a service account or gMSA there is no password anywhere.
- A reinstalled worker generates a new key, and stored ciphertext becomes unreadable. The control
  plane detects the fingerprint change on `Hello`, marks configs `awaiting_credentials`, and the
  dashboard asks for the password again rather than reporting a bad password.
- Notification channel secrets are the exception: the control plane is the party that *uses* them,
  so it holds them usably. They are never returned by the API.

### The second-approver rule is off by default

**Decided: default off, Admins exempt when on.**

It shipped on. In use that made it an approval that a single DBA looking after their own estate
could never obtain, because the approver may not be the issuer — the control was blocking the
product rather than protecting anything.

The mechanism is unchanged and the tests still cover it. Only the default moved, plus
`RSAGENT_APPROVAL_EXEMPT_ROLES` (default `Admin`), because an Admin can grant themselves any role
anyway, so countersigning their changes is procedure rather than control.

**Consequence:** a change-managed site must now opt in with
`RSAGENT_REQUIRE_APPROVAL_JOB_WRITE=true`. Called out in the upgrade notes below.

### Drift is history, not an alarm

**Decided: keep the versioning, drop the alarm.**

Every observed definition still becomes an immutable version attributed `initial` / `local` /
`remote`, and conflict detection on write is untouched — that is the part that prevents an edit
silently clobbering someone else's.

What went was the presentation. A "Drifted" badge on every job that had ever been edited in SSMS,
plus a count in the estate grid, told operators that normal administration was a fault condition.
Badges are now reserved for states that need a response: running, failing, conflicted. Where a
change came from is still recorded, and lives on the Versions tab where history belongs.

**Consequence:** `jobs.is_drifted` and the `rsagent_jobs_drifted` metric are still populated, so
external monitoring built on them keeps working. Only the UI changed.

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

### Worker authentication defaults to mTLS, not an API key

**Decided: `mtls` is the installers' default; `entra` is better where hosts have
a managed identity, and `token` remains available.**

This reverses the original decision, which was that mTLS cost too much to run:
"CA custody, rotation and revocation are real operational load, and making PKI
the price of entry would keep this out of the estates that need it most."

The premise turned out to be wrong for *this* product. There is no CA custody —
the control plane runs its own, created on demand, and a site never sees it.
There was no rotation either, which was not a saving but the actual defect: 90-day
certificates and no renewal path made expiry an outage timer. Only the operational
load was real, and it was load this codebase had imposed on itself.

With renewal automatic, the ranking inverts. `mtls` costs an operator nothing
beyond `--auth-mode mtls` at install and proves possession of a key that never
crosses the wire. `token` is a bearer secret: anything that reads it — including
a TLS-terminating proxy — can replay it from anywhere.

**Consequence:** `token` still works and is still the right answer on a host that
can reach neither Azure nor a certificate of its own, but it is no longer the
path of least resistance. The hub refuses to start without TLS regardless. The
control plane warns at startup when a real deployment still has workers on API
keys, and `RSAGENT_WORKER_AUTH_MODES` should list only the modes actually in use
— the hub accepts any listed mode from any worker, so a migration is not finished
until the mode being migrated away from is removed.

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
| Worker certificate expiry alerting | Certificates now renew themselves at half lifetime, so expiry should not arrive — but nothing watches for a worker that has stopped renewing, and `certExpiresAt` is plumbed to the dashboard without being shown. Until it is, the signal is a `worker.certificate.renewed` audit row per worker per half-lifetime. | Small |
| Bring-your-own CA for worker certificates | `RSAGENT_GRPC_TLS_CLIENT_CA` makes the TLS layer accept an operator-issued client certificate, but authentication then rejects it: identity is a fingerprint row in `worker_credentials`, and only enrolment and renewal create one. Needs a way to register an externally-issued fingerprint. Cheap, because identity is the fingerprint rather than the chain — but until then the setting promises something it does not deliver, and should fail at startup rather than per connection. | Small |
| No MSI | The worker ships as a zip plus `install.ps1`. Fine for hand or script installation; awkward for SCCM/Intune, which want an MSI. | Medium |
| Deleting an operator | Explicitly refused. The command carries an instance-local operator id, which is not a safe identifier to delete by — the same id means different operators on different instances. Needs a protocol change to carry the name. | Small |
| Non-TSQL subsystem fidelity | Steps using a subsystem this version does not model are mirrored as `CmdExec` with a warning. Reading is safe; writing such a job back would change it. | Small |
| Approval notifications | Commands awaiting approval are shown in the dashboard but do not raise a notification. An approver has to be looking. The notification pipeline exists, so this is now wiring rather than design. | Small |
| Windows worker package not served | The control plane serves `rsagent-worker-linux.tar.gz`, so the Linux one-liner is self-contained. The Windows zip needs the Node runtime and WinSW, which the release workflow assembles — the container does not bundle it, so `Install-RsAgentWorker` needs `-PackageUrl` pointing at the release asset until it does. | Small |
| Schedule editing | Schedules can be enabled and disabled in the job editor, but their timing cannot be changed there. The schedule codec round-trips faithfully; only the editing UI is missing. | Medium |
| No credential key rotation on demand | A worker's credential key rotates only when the key file is removed and the worker restarts. There is no dashboard button for it. | Small |
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

- [x] **Verify the npm scope is available.** Packages are named
      `@remote-sql-agent/protocol` and `@remote-sql-agent/worker`. The scope
      was unclaimed and the `remote-sql-agent` organisation now holds it.
- [ ] **Verify the GitHub org/repo name.** `CODEOWNERS`, `SECURITY.md`, the
      package `repository` fields and the container image name all assume
      `semics-tech/remote-sql-agent`.
- [ ] **Bootstrap the two npm packages and configure trusted publishing** on
      each. OIDC cannot perform a package's first publish, so each name needs
      one manual `0.0.0` publish before its trusted publisher can be set up.
      Steps in [releasing.md](releasing.md).
- [ ] **Set repository secrets** for the release workflow:
      `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. npm needs no secret — it
      publishes via OIDC — and GHCR uses the built-in `GITHUB_TOKEN`.
- [ ] **Enable branch protection on `main`** — see §5.
- [ ] **Decide the support commitment** before people depend on it. `0.x`
      versions currently signal that breaking changes may land in minors.
- [ ] **Serve the dashboard over HTTPS in any deployment that will use SQL
      logins.** `crypto.subtle` is unavailable in an insecure context, so
      credential onboarding is disabled over plain HTTP by design. Integrated
      authentication is unaffected.

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

### Upgrading to 0.2.0 specifically

Two defaults changed. Both are deliberate; neither is silent.

- **`RSAGENT_REQUIRE_APPROVAL_JOB_WRITE` now defaults to `false`.** If you were
  relying on the four-eyes rule without setting it explicitly, set it to `true`
  before upgrading. Check `RSAGENT_APPROVAL_EXEMPT_ROLES` too — it defaults to
  `Admin`, so set it empty if Admins must also be countersigned.
- **Workers now enrol with no instances.** Existing `worker.yaml` files are
  unaffected: anything listed there is still monitored, and the control plane
  never removes it. The dashboard-configured set is managed separately.

New, and optional:

- `RSAGENT_WORKER_PACKAGE_DIR` — set in the container image already. Enables
  `/install.sh`, `/install.ps1` and `/downloads/`.
- Serve the dashboard over HTTPS if you intend to use SQL logins rather than
  integrated authentication. See §1.

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
