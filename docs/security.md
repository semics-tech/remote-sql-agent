# Security guide

This document states what the product currently enforces, and — just as importantly — what it does
not yet enforce. Read the "Current status" table before deploying anything.

## Current status

The build in this repository implements milestones M0–M3 of the architecture spec.

| Control | Spec | Status |
|---|---|---|
| Outbound-only worker connections | §3.2.1 | **Implemented.** No worker component opens a listening socket. |
| Read-only by default | §6.1.1 | **Implemented.** No write command is applied by the worker in this build. |
| Worker-local capability ceiling | §6.3 | **Implemented and tested**, including end to end: an enrolment granting `job.toggle` still resolves to `observe` for a worker pinned `readOnly`. |
| Closed command vocabulary | §6.1.5 | **Implemented** as a protobuf enum. No "run arbitrary T-SQL" command exists. |
| Command signing + replay window | §6.4 | **Implemented in the contracts package**, not yet exercised (no write path). |
| Append-only audit log | §6.1.4 | **Implemented** for authentication, administration and worker session events. No update or delete path exists. |
| Audit export to a SIEM | backlog | **Implemented** via OTLP, queued with retry. See `authentication.md` §3. |
| Parameterised SQL everywhere | §5.2 | **Implemented**, enforced by an eslint rule. |
| Worker authentication | §6.2 | **Implemented**: enrolment tokens plus API key, mTLS, or Entra workload identity. |
| Embedded CA, cert issuance/revocation | §6.2 | **Implemented** for mTLS mode. Revocation checked per connection. |
| TLS on the worker hub | §6.2 | **Implemented**; the control plane refuses to start without it unless explicitly overridden. |
| Dashboard authentication | §6.5 | **Implemented**: local argon2id accounts and/or Entra OIDC with app-role mapping. |
| Server-side RBAC on every route | §6.5 | **Implemented.** Every route declares a permission; there is no unguarded data route. |
| CSRF protection | §6.5 | **Implemented** (double-submit token bound to the session). |
| Automatic certificate rotation at 2/3 lifetime | §6.2 | **Not implemented.** Rotation is manual. |
| Approval workflow | §6.4 | **Not implemented.** M4, along with the write path. |

> **Still not production-ready.** The write path (M4) and packaging (M5) do not exist, and
> certificate auto-rotation is manual. But the control plane is no longer open: it requires
> authentication for every data route, and workers must present an enrolled credential.

### Deployment checklist

- [ ] `RSAGENT_PUBLIC_URL` set to the real https origin (this also makes session cookies `Secure`)
- [ ] `RSAGENT_GRPC_TLS_CERT` / `RSAGENT_GRPC_TLS_KEY` set — never run the hub without TLS
- [ ] Bootstrap admin password changed, or Entra configured
- [ ] Each worker's `maxCapability` set to the minimum that site needs (default `readOnly`)
- [ ] Postgres on an encrypted volume, and backups encrypted
- [ ] Audit export configured to a system outside this host

## What a worker can and cannot do

A worker's effective capability is the **intersection** of two independently controlled sets:

1. the server-side grant on the `workers` row, editable by a control-plane admin, and
2. the `maxCapability` tier in the worker's own `worker.yaml`, on the SQL Server host.

The intersection is computed by the worker itself, from its own config, on every session. The
control plane's arithmetic is advisory and is never trusted. A site that pins `maxCapability:
readOnly` has a worker that cannot be made to write **even if the control plane is fully
compromised**, short of an attacker who can also edit files on the SQL Server host — at which point
they did not need the worker.

Unknown capability strings sent by the server are dropped rather than passed through, so a newer
control plane cannot smuggle a capability past an older worker that does not understand it.

## SQL Server privileges

The worker's login needs far less than DBAs often expect. Grant the minimum:

```sql
USE [msdb];
CREATE USER [rsagent_worker] FOR LOGIN [rsagent_worker];
ALTER ROLE [SQLAgentReaderRole] ADD MEMBER [rsagent_worker];
```

That covers the whole read path: job definitions, steps, schedules, operators, alerts, run history
and activity.

**The Agent error log is the exception.** `xp_readerrorlog` requires `securityadmin` or `sysadmin`,
which a least-privileged worker will not have. Rather than demand those rights, the worker detects
the permission error, logs a warning, and permanently disables log streaming for that instance. The
dashboard explains the absence in the Error Log tab. This is a deliberate trade: an optional feature
is dropped instead of escalating the blast radius of a compromised worker login.

Never grant the worker `sysadmin`. A future build will warn loudly if it detects that it has it.

## Handling of sensitive job content

Job step bodies routinely contain connection strings, credentials and other secrets.

**Implemented:** step bodies and canonical definitions are excluded from all structured logs, on
both the worker and the control plane, by explicit pino redaction paths. They are never written to
disk by the worker other than as SHA-256 hashes in the outbox.

**Resolved deviation from §6.6 — definitions are deliberately not encrypted at rest.** The spec
originally called for app-level AES-GCM encryption of job definitions. That conflicts directly with
§9.5, which wants cross-estate search over step-body text and calls it a killer feature: encrypted
blobs cannot be searched by the database, and decrypting every definition in the application on
every search neither scales nor keeps the plaintext out of memory.

**Decision: keep definitions as searchable `jsonb`.** Cross-estate search is load-bearing for the
product and encryption at rest is delegated to the platform. Deploy accordingly:

- enable Postgres transparent disk encryption, or run the data directory on an encrypted volume;
- restrict direct database access to the control-plane service account;
- treat a Postgres backup as containing credentials, and encrypt backups.

Redaction rules in the UI (regex masking of `Password=…` and similar) remain worth adding and are
tracked separately — they protect against shoulder-surfing and over-broad dashboard access, which is
a different threat from at-rest compromise.

## SQL injection

No SQL statement anywhere in the worker or control plane is built by string concatenation or
template interpolation. Every value is bound as a parameter. This is enforced two ways:

- an eslint rule (`no-restricted-syntax` in `eslint.config.js`) that fails the build on
  interpolated or concatenated arguments to `.query()`, `.batch()` and `.execute()`, and
- code review.

The one place that legitimately builds a statement dynamically — creating the test database, where
`CREATE DATABASE` cannot take a parameter — is in test-only code and quotes the identifier.

## Trusting worker-reported data

The control plane recomputes the SHA-256 of every definition it receives rather than trusting the
hash the worker sent. A worker that has been taken over therefore cannot make two different
definitions share a hash in order to hide a change from drift detection. A mismatch is logged and
the locally computed hash wins.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
