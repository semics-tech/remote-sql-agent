# Changelog

Notable changes to Remote SQL Agent. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While at `0.x`, breaking changes may land in minor versions.

## [Unreleased]

## [0.2.0] — 2026-07-31

Deployment and the write path. `0.1.1` could be installed but not really
*deployed* — there was no guidance on where the control plane should run, and
`job.write` worked only on jobs the worker itself created, which on a real
estate is almost none of them.

### Upgrading

Two things need a decision rather than just a pull.

- **`RSAGENT_TRUSTED_PROXY_HOPS` defaults to `0`**, which ignores
  `X-Forwarded-For` entirely. If you run a reverse proxy in front of the
  dashboard — the Caddy profile, an ingress controller, Container Apps — set it
  to the number of proxies you actually run, or every audit row and rate-limit
  bucket will record the proxy's address instead of the client's. Leaving it
  unset is safe, just less precise. See [docs/security.md](docs/security.md)
- **Database migration `0004`** runs automatically on first start. It adds one
  nullable column, so it is not a rewrite and does not need a maintenance window

### Added

- **A deployment guide, and three routes to follow.**
  [docs/deployment.md](docs/deployment.md) covers a VM with Compose (the lead,
  and the cheapest), Kubernetes, and Azure Container Apps, with the two
  constraints that decide all of them stated up front: the control plane is one
  process on two ports, and it runs as exactly one replica. Ships a Caddy TLS
  profile, a `cloud-init` file that takes a bare Ubuntu VM to a running control
  plane, and a single-file Kubernetes manifest
- **Deploying no longer needs a checkout.** `deploy/docker-compose.yml`
  references the published image rather than building from a repository clone,
  so the documented path is `curl` two files and `docker compose up`
- **`RSAGENT_HUB_ADVERTISED_ADDRESS`** overrides the `host:port` workers are
  told to dial. The derived default is right only when the hub is published on
  its own port of the same name; it is wrong wherever a platform maps ports or
  the hub has a hostname of its own. This string ends up in `worker.yaml` on
  every SQL host, so getting it wrong is not a broken page — it is fifty
  machines pointed somewhere that does not answer
- **An optional signed wrapper for editing jobs owned by another login.**
  `sp_update_job` refuses to touch a job owned by anyone else unless the caller
  is `sysadmin`, and on a typical estate most jobs are owned by `sa`.
  `deploy/sql/worker-write-wrapper.sql` installs procedures created
  `WITH EXECUTE AS OWNER` **and** signed by a certificate mapped to a
  `sysadmin` login — both halves are required, and the pair keeps working with
  `TRUSTWORTHY OFF`, which hardening guides turn off. The allowlist starts
  **empty**, so installing it grants nothing until a DBA names a job.
  Parameters are enumerated rather than forwarded: no `@owner_login_name`, no
  `@proxy_name`, and `@subsystem` pinned to `TSQL`, because a job step is a
  place to run commands as the Agent service account. Every call is logged with
  `ORIGINAL_LOGIN()`, which survives the context switch
- **`deploy/sql/worker-permissions.sql`** grants the `msdb` SELECT permissions
  the worker needs. `SQLAgentReaderRole` and `SQLAgentOperatorRole` grant
  EXECUTE on the `sp_help_*` procedures, not SELECT on the base tables the
  worker reads, so a correctly-roled login still failed on `sysjobhistory`
- **The dashboard says what it cannot edit, before you try.** The job editor
  reads the worker's reported SQL login and wrapper state and disables editing
  with the reason, rather than offering a save that `msdb` will refuse

### Fixed

- **A client could choose its own `request.ip`.** `trustProxy: true` trusts the
  whole `X-Forwarded-For` chain and resolves to its *leftmost* entry — the one
  the client wrote. That address is what `@fastify/rate-limit` counts against
  and what is recorded as `remoteAddress` on every session and 25+ audit sites,
  so it was both a rate-limit bypass and a forged audit trail in the component
  holding every job definition in the estate. Inert until now only because the
  shipped Compose file put nothing in front of 8080; every deployment route
  added in this release puts a proxy there. Replaced with a counted
  `RSAGENT_TRUSTED_PROXY_HOPS`, defaulting to 0. A fixed `trustProxy: 1` was
  the first instinct and is also wrong — with nothing in front, one declared
  hop still believes the client's header
- **A job save that SQL Server refused was reported as success.** The editor
  announced "Saved and sent to the worker" on the control plane's 200, which
  only means the command was written and dispatched; whether `msdb` accepted it
  is decided on the SQL host and arrives seconds later. The error was never
  lost — it reached Postgres, the audit log, a notification and the Commands
  page — but not the screen the operator was looking at. For a product whose
  premise is that the dashboard tells you the truth about the estate, a false
  "Saved" is the worst failure available. The editor now waits for a terminal
  state and distinguishes applied, still queued, and refused

### Changed

- **zod 4, vitest 4, react-router 8, ESLint 10 and `@fastify/rate-limit` 11.**
  Two were more than version numbers. zod 4 reads a lone `z.record()` argument
  as the *key* schema rather than the value schema, which silently inverted the
  Entra app-role map — the thing that decides what an authenticated user may
  do. And `react-router-dom` has no version 8: it was folded back into
  `react-router`, and every 7.x release sits inside a high-severity advisory,
  so the dashboard moved packages rather than sit on 6 indefinitely
- **`@types/node` is pinned to the 24 line** and dependabot is told not to
  offer 26. Everything here runs Node 24 — engines, both image stages, CI, and
  the runtime baked into the single-file executables — so types from a newer
  major describe APIs that are not there, and CI could not catch it

## [0.1.1] — 2026-07-30

### Fixed

- **The control plane downloaded a package from npmjs.org on every start.**
  `tsx` runs the TypeScript sources, but it was a devDependency, so
  `pnpm --prod deploy` excluded it from the image and `npx tsx` fetched it at
  boot. A control plane that cannot start without reaching the public internet
  contradicts the point of a product built for segmented networks, and it meant
  executing an unpinned package on the host that holds every job definition in
  the estate. It is a runtime dependency now, and the image runs
  `node --import tsx` rather than `npx`, so a packaging mistake fails loudly
  instead of quietly reaching for the network. Verified by booting the image
  with `--network none`

### Changed

- **`@remote-sql-agent/protocol` is no longer published to npm.** Nothing
  installed it: the worker inlines it into its bundle and the control-plane
  image carries it. Publishing it turned internal contracts into a public API
  with semver expectations attached, in exchange for a consumer nobody had
  asked for — and `JobDefinition.v1` being free to change whenever the worker
  and server change together is what keeps drift detection honest. `0.1.0`
  remains on npm, deprecated. The `.proto` files and zod schemas are still the
  source of truth for anyone building against the wire protocol

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
- **npm**: `@remote-sql-agent/worker`, for hosts that already run Node 24.
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

[Unreleased]: https://github.com/semics-tech/remote-sql-agent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/semics-tech/remote-sql-agent/releases/tag/v0.2.0
[0.1.1]: https://github.com/semics-tech/remote-sql-agent/releases/tag/v0.1.1
[0.1.0]: https://github.com/semics-tech/remote-sql-agent/releases/tag/v0.1.0
