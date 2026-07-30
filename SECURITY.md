# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub Security Advisories:

**[Report a vulnerability](https://github.com/semics-tech/remote-sql-agent/security/advisories/new)**

Please include:

- what the issue is, and which component (worker, control plane, dashboard)
- how to reproduce it
- what an attacker gains
- the version or commit you tested

You will get an acknowledgement within 3 working days and an assessment within
10. If a fix is warranted we will agree a disclosure timeline with you, and
credit you in the advisory unless you would rather we did not.

## Scope

This product administers production database servers. A worker with write
capability is effectively remote code execution on a SQL Server, so the
following are taken particularly seriously:

- anything that lets a worker exceed its **local** capability ceiling
- anything that lets the control plane issue a command a worker should refuse
- authentication or authorisation bypass on the dashboard or the worker hub
- SQL injection anywhere (every statement should already be parameterised)
- forging or replaying a command
- extracting job definitions — they routinely contain connection strings
- tampering with the audit trail

### Known and accepted

These are documented design decisions rather than vulnerabilities. Reports about
them are welcome as *discussion*, but will not be treated as advisories.

- **Job definitions are stored unencrypted** in Postgres, so that cross-estate
  step-body search works. Encryption at rest is delegated to the platform. See
  [docs/security.md](docs/security.md).
- **An administrator with direct database access can edit the audit log.**
  Protecting against that requires shipping the log off-box; OTLP export is
  built in.
- **A worker at `maxCapability: full` can be used to run arbitrary code** on its
  SQL Server, by an operator with the rights to author and approve a job. That
  is what the capability is; the control is choosing a lower ceiling.
- **Compromising a SQL Server host** compromises that host. The worker does not
  widen the blast radius to other hosts: it holds credentials only for its own
  instances.

[docs/threat-model.md](docs/threat-model.md) has the full analysis, including
residual risk for each scenario.

## Supported versions

| Version | Supported |
|---|---|
| 0.x | Latest minor only |

While at `0.x`, fixes land on the latest minor. There are no backports.

## Deploying securely

[docs/security.md](docs/security.md) has a deployment checklist. The four that
account for most of the risk:

1. **Give the hub a TLS certificate.** In `token` mode it is the only thing
   keeping worker API keys off the wire. The control plane refuses to start
   without one unless explicitly overridden.
2. **Leave workers at `maxCapability: readOnly`** unless a host genuinely needs
   to accept changes. It is the only control that survives a compromised control
   plane.
3. **Put Postgres on an encrypted volume and encrypt the backups.** A backup
   contains every job definition in the estate.
4. **Export the audit log off-box.** Its value in an investigation depends on
   not being editable by whoever you are investigating.

## Security-relevant dependencies

Kept deliberately small. `argon2` (control plane) is the only native module
compiled anywhere in the tree — the worker's outbox uses the runtime's own
`node:sqlite`, so nothing on a customer's database server is built from C++ at
install time. `pnpm audit --audit-level high` runs in CI, the lockfile is
committed, and CI installs with `--frozen-lockfile`.
