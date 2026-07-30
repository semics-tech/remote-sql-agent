# Changelog

Notable changes to Remote SQL Agent. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While at `0.x`, breaking changes may land in minor versions.

## [Unreleased]

_Nothing yet._

## [0.1.0] — 2026-07-30

First release, and the first build published to npm, Docker Hub and
GitHub Releases. Implements all six milestones of the architecture
specification.

Everything here is new — there is no earlier release for it to have changed
from. Where an approach taken during development was later reversed, it is
recorded under [Decisions worth knowing](#decisions-worth-knowing), because the
reasoning outlives the change.

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
- Cross-estate search over job names and the full text of every step body

### Operations and monitoring

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
- A started job shows as running immediately: the worker polls activity as soon
  as it applies the command instead of waiting for the next tick, and the
  dashboard polls faster while a run is live

### Job editing and the write path

- The job page opens straight into the editable definition, the way SSMS does.
  No separate edit screen; read-only is a state of the same page
- Enable/disable, start/stop, and full job editing with a Monaco T-SQL editor
- Step **add, remove and reorder**, with `Go to step N` references repaired
  across renumbering and any repairs reported to the operator
- Every command signed, replay-windowed, capability-checked, idempotent and
  conflict-checked before it reaches `msdb`
- Conflicts flag and ask — an edit against a stale version is refused and the
  operator chooses to rebase or explicitly overwrite
- Optional second-approver rule on job edits, where the approver cannot be the
  issuer. Off by default, and exempts configurable roles (`Admin`) when on; set
  `RSAGENT_REQUIRE_APPROVAL_JOB_WRITE=true` to require it
- Round-trip fidelity: a definition sent from the dashboard is byte-for-byte
  identical when read back from `msdb`

### Versioning and drift

- Canonical `JobDefinition.v1` schema with stable hashing, shared by worker and
  control plane so both derive identical bytes from the same job
- Every observed definition becomes an immutable version, attributed `initial`,
  `local` (on-premise edit) or `remote` (dashboard change)
- Drift is presented as history rather than an alarm, and is never silently
  reconciled. Badges are reserved for running, failing and conflicted

### Security

- Microsoft Entra ID sign-in (authorisation code + PKCE, app-role mapping) and
  local argon2id accounts, individually or together
- Server-side RBAC on every route; CSRF protection on mutations
- Worker enrolment with a choice of API key, mTLS client certificate, or Azure
  managed identity
- Worker capability ceiling enforced from local config, so a compromised control
  plane cannot make a read-only worker write
- **SQL credentials configured from the dashboard**, encrypted in the operator's
  browser to a public key the target worker generated on its own host. The
  control plane stores ciphertext it has no key for — see
  [docs/security.md](docs/security.md). Integrated authentication remains the
  default, and stores nothing
- **Worker capability editing** in Administration, showing the grant, the host's
  own ceiling, and the effective intersection, with anything the host blocks
  marked as such
- Append-only audit log with optional OTLP export to any OpenTelemetry backend

### Worker onboarding

- An **"Add a worker" wizard** produces a one-line install command for Windows
  or Linux carrying a single-use enrolment token. The control plane serves the
  installer and package itself, so it works on a network with no route to the
  internet

### Distribution and install

- **Single-file executables** for Linux, Windows and macOS. One download, no
  Node, no dependencies, no installer — enough to enrol a database server that
  has nothing on it. Built by the OS they target, and each self-tested before
  upload
- **npm**: `@remote-sql-agent/worker` for hosts that already run Node 24, and
  `@remote-sql-agent/protocol` for anyone building against the wire contract.
  Published by CI with provenance, via trusted publishing — there is no npm
  token in the repository
- **Container image** on Docker Hub as `techsemics/remote-sql-agent` and on
  GHCR, multi-architecture, from one build so both registries hold the same
  digest
- Worker also ships as a Windows zip with `install.ps1` and a WinSW service
  wrapper, and as a Linux tarball with a hardened systemd unit
- **Release assets are verifiable**: `SHA256SUMS` plus a build attestation on
  every artefact, so a download traces back to the workflow run that made it.
  The Windows Node runtime is checked against nodejs.org's published
  `SHASUMS256.txt` rather than trusted because the download succeeded
- **`pnpm release:version <version>`** sets every manifest and `WORKER_VERSION`
  in lockstep, and the release job refuses to publish if any of them disagrees
  with the tag. Prereleases go to npm's `next` dist-tag and move `latest` on
  neither registry
- Minimum worker version gate, so a version with a known defect can be retired
  across an estate without visiting hosts
- **[docs/releasing.md](docs/releasing.md)** — what is published where, and what
  a maintainer has to set up first

### Decisions worth knowing

- **The worker's outbox uses the runtime's built-in `node:sqlite`** rather than
  better-sqlite3. This removes the last native module from the worker: nothing
  is compiled from C++ on a customer's database server, `npm i -g` needs no
  toolchain, and a single-file executable becomes possible at all. The cost is
  an API still marked experimental, which is why the runtime is pinned and the
  surface is confined to `outbox.ts`
- **The worker bundle marks nothing external.** It ships as a single `.mjs` with
  no `node_modules` beside it, which is what the tarball, the executables and
  `npm i -g` all rely on. An earlier build marked `better-sqlite3` and
  `@azure/identity` external, which made the tarball unable to start at all;
  `@azure/identity` was never optional, because tedious depends on it outright
  and requires it at the top of `connection.js`
- **The worker declares no runtime dependencies.** grpc, mssql, pino, yaml, zod
  and protocol are all inside the bundle, so declaring them as well made npm
  download the lot a second time to sit unused. `npm i -g` now installs exactly
  one package
- **The control-plane image builds with no toolchain.** `python3` and
  `build-essential` existed only so better-sqlite3 could compile on arm64

### Fixed

- The container build referenced the old `@rsagent/*` package scope and would
  have failed on the first release build
- `tests/integration` had no `typecheck` script, so type errors there surfaced
  as test timeouts rather than compile failures

### Known gaps

See [docs/migration.md](docs/migration.md). The significant ones: no
control-plane HA, manual certificate rotation in mTLS mode, no MSI.

[Unreleased]: https://github.com/semics-tech/remote-sql-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/semics-tech/remote-sql-agent/releases/tag/v0.1.0
