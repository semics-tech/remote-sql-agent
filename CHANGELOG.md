# Changelog

Notable changes to Remote SQL Agent. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While at `0.x`, breaking changes may land in minor versions.

## [Unreleased]

Nothing yet.

## [0.1.0] — unreleased

First release. Implements all six milestones of the architecture specification.

### Estate visibility

- Worker mirrors job definitions, steps, schedules, operators, alerts, run
  history, live activity and the Agent error log from every SQL Server instance
  on its host
- One worker per host handles all named instances on it
- Outbound-only: no listening socket on any SQL host, no inbound firewall rule
- Offline outbox with replay on reconnect; jittered exponential backoff so an
  estate does not reconnect in lockstep after a control-plane restart
- Dashboard: estate overview, SSMS-shaped instance view, job detail with
  step-level run history

### Versioning and drift

- Canonical `JobDefinition.v1` schema with stable hashing, shared by worker and
  control plane so both derive identical bytes from the same job
- Every observed definition becomes an immutable version, attributed
  `initial`, `local` (on-premise edit) or `remote` (dashboard change)
- Drift surfaced with a badge and a diff, never silently reconciled
- Cross-estate search over job names and the full text of every step body

### Security

- Microsoft Entra ID sign-in (authorisation code + PKCE, app-role mapping) and
  local argon2id accounts, individually or together
- Server-side RBAC on every route; CSRF protection on mutations
- Worker enrolment with a choice of API key, mTLS client certificate, or Azure
  managed identity
- Worker capability ceiling enforced from local config, so a compromised control
  plane cannot make a read-only worker write
- Append-only audit log with optional OTLP export to any OpenTelemetry backend

### Write path

- Enable/disable, start/stop, and full job editing with a Monaco T-SQL editor
- Every command signed, replay-windowed, capability-checked, idempotent and
  conflict-checked before it reaches `msdb`
- Conflicts flag and ask — an edit against a stale version is refused and the
  operator chooses to rebase or explicitly overwrite
- Second-approver rule on job edits; the approver cannot be the issuer
- Round-trip fidelity: a definition sent from the dashboard is byte-for-byte
  identical when read back from `msdb`

### Packaging

- Control plane as a multi-architecture container image plus Docker Compose
- Worker as a zip with `install.ps1` and a WinSW service wrapper, an npm package
  for SQL-on-Linux, and a hardened systemd unit
- Minimum worker version gate, so a version with a known defect can be retired
  across an estate without visiting hosts

### Known gaps

See [docs/migration.md](docs/migration.md). The significant ones: no
control-plane HA, manual certificate rotation in mTLS mode, no MSI.

[Unreleased]: https://github.com/semics/remote-sql-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/semics/remote-sql-agent/releases/tag/v0.1.0
