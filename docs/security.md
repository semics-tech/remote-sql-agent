# Security guide

This document states what the product currently enforces, and — just as importantly — what it does
not yet enforce. Read the "Current status" table before deploying anything.

## Current status

The build in this repository implements milestones M0–M2 of the architecture spec. The security
model is **partially implemented**.

| Control | Spec | Status |
|---|---|---|
| Outbound-only worker connections | §3.2.1 | **Implemented.** No worker component opens a listening socket. |
| Read-only by default | §6.1.1 | **Implemented.** No write command is applied by the worker in this build. |
| Worker-local capability ceiling | §6.3 | **Implemented and tested.** |
| Closed command vocabulary | §6.1.5 | **Implemented** as a protobuf enum. No "run arbitrary T-SQL" command exists. |
| Command signing + replay window | §6.4 | **Implemented in the contracts package**, not yet exercised (no write path). |
| Append-only audit log | §6.1.4 | **Implemented** for worker session events. User actions land with authentication. |
| Parameterised SQL everywhere | §5.2 | **Implemented**, enforced by an eslint rule. |
| mTLS between worker and control plane | §6.2 | **Not implemented.** M3. The channel is currently plaintext gRPC. |
| Embedded CA, enrolment tokens, cert rotation/revocation | §6.2 | **Not implemented.** M3. |
| Dashboard authentication and RBAC | §6.5 | **Not implemented.** M3. Every API route is currently unauthenticated. |
| Approval workflow | §6.4 | **Not implemented.** M4. |

> **Do not expose this build to an untrusted network.** With no transport security and no
> authentication, anyone who can reach the control plane can read every mirrored job definition —
> which routinely contain connection strings — and anyone who can reach the gRPC port can register
> as a worker. It is safe to run against a lab instance on a trusted network, and nothing more.

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

**Deliberate deviation from §6.6 — read this before deploying.** The spec calls for job definitions
to be encrypted at rest in Postgres with app-level AES-GCM. This build stores them as plaintext
`jsonb` instead. The reason is a genuine, unresolvable conflict inside the spec:

- §6.6 wants definitions encrypted at rest.
- §9.5 wants cross-estate search over step-body text — "which servers still reference server X in a
  step?" — and calls it a killer feature to prioritise.

Encrypted blobs cannot be searched by the database. Satisfying both would require either a
searchable-encryption scheme (which leaks enough to be of questionable value here) or decrypting
every definition in the application on every search (which does not scale past a few hundred jobs
and puts the plaintext in application memory anyway).

I built the searchable version, because §9.5 is load-bearing for the product's differentiation.
**This is a decision that should be made deliberately rather than inherited from me.** The practical
mitigations available today are Postgres transparent disk encryption, filesystem encryption on the
control-plane host, and restricting direct database access. If encryption-at-rest of definitions
matters more than cross-estate search for your environment, the change is contained: encrypt
`job_versions.definition` on write and drop or reimplement `searchJobs` in
`packages/server/src/domain/queries.ts`.

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
