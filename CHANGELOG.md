# Changelog

Notable changes to Remote SQL Agent. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While at `0.x`, breaking changes may land in minor versions.

## [Unreleased]

### Added

- **Operations overview** as the landing page: what is running, what is running
  longer than its own average, what failed in the last 24 hours, and worker
  health — estate-wide, in one screen
- **Cross-estate job grouping** by name, category, owner, schedule or instance,
  with health rolled up per group. Answers "is this job healthy on all thirty
  servers?", which the per-instance estate grid cannot
- **Live step graph** on a running job: which step it is on, how long that step
  has been going, and what it usually takes. Per-step baselines, so a step at
  four minutes against a usual forty seconds is visible at a glance
- **Job statistics**: success rate, typical and p95 duration, a duration trend
  comparing recent runs against older ones, and a per-run chart
- **Notifications** to email, Slack, Teams or a webhook, with rules scoped by
  instance and job name, per-job throttling, queued delivery with backoff, and a
  test-send. New event `job.long_running` compares each run against that job's
  own history rather than a global threshold
- **Worker onboarding from the dashboard**: an "Add a worker" wizard produces a
  one-line install command for Windows or Linux carrying a single-use enrolment
  token. The control plane serves the installer and package itself, so it works
  on a network with no route to the internet
- **SQL credentials configured from the dashboard**, encrypted in the operator's
  browser to a public key the target worker generated on its own host. The
  control plane stores ciphertext it has no key for — see
  [docs/security.md](docs/security.md). Integrated authentication remains the
  default, and stores nothing
- **Worker capability editing** in Administration, showing the grant, the host's
  own ceiling, and the effective intersection, with anything the host blocks
  marked as such
- Step **add, remove and reorder** in the job editor, with `Go to step N`
  references repaired across renumbering and any repairs reported to the operator

### Changed

- **The job page opens straight into the editable definition**, the way SSMS
  does. No separate edit screen; read-only is a state of the same page
- **A started job shows as running immediately.** The worker polls activity as
  soon as it applies the command instead of waiting for the next tick, and the
  dashboard shows an optimistic state and polls faster while a run is live
- **Drift is presented as history, not an alarm.** Version attribution is
  unchanged and conflict detection is untouched; the badges and estate column
  are gone. Badges are reserved for running, failing and conflicted
- **The second-approver rule for job edits is off by default**, and exempts
  configurable roles (`Admin`) when on. Set
  `RSAGENT_REQUIRE_APPROVAL_JOB_WRITE=true` to restore the previous behaviour

### Fixed

- The container build referenced the old `@rsagent/*` package scope and would
  have failed on the first release build
- `tests/integration` had no `typecheck` script, so type errors there surfaced
  as test timeouts rather than compile failures

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
