# Remote SQL Agent — Architecture & Implementation Specification

**Project name:** Remote SQL Agent
**Slugs:** repo/npm scope `remote-sql-agent`; CLI/binary name `rsagent` (avoid abbreviating to "RSA", which collides with the cryptosystem and will pollute every search result)
**Status:** Draft v0.2 — source-of-truth spec for implementation by a Claude Code agent
**License:** Apache 2.0 (fully open source; no open-core split in v1)

---

## 1. Problem Statement

Organisations running many on-premise SQL Server instances (50+ in the reference environment) behind multiple corporate firewalls have no good way to centrally view, monitor, and manage SQL Server Agent jobs. Today this requires logging into each server individually via SSMS/RDP to view logs, check job status, edit schedules, and deploy changes.

Existing options all fail for this environment:

- **MSX/TSX multiserver administration** and **Central Management Servers** require direct inbound network connectivity between instances — impossible across firewalled network segments.
- **Commercial tools** (IDERA SQL Enterprise Job Manager, etc.) are expensive, closed, and still generally assume the management plane can reach the instances.
- **Monitoring tools** (Redgate SQL Monitor, SQL Sentry) are read-only and don't manage jobs.
- **Enterprise schedulers** (Control-M, ActiveBatch) replace SQL Agent rather than managing it.

## 2. Product Vision

A lightweight **worker** is deployed next to each SQL Server instance. The worker makes **outbound-only** connections to a central **control plane**. It mirrors the local SQL Server Agent — jobs, steps, schedules, operators, alerts, history, and logs — into the control plane, where a web **dashboard** presents an SSMS-like Agent experience across the whole estate. Authorised changes made in the dashboard sync back down to the on-premise Agent.

**Core philosophy: SQL Agent remains the execution engine.** The worker never runs jobs itself. It observes and (when permitted) administers the local Agent via T-SQL/`msdb` stored procedures. The product is a drop-on-top for any existing SQL Agent installation — zero migration, zero lock-in, remove the worker and everything still runs.

### Non-goals (v1)

- Not a scheduler/execution engine (no job execution outside SQL Agent)
- No support for non-SQL-Server schedulers (cron, Task Scheduler, Oracle)
- No replacement of monitoring tools (no perf counters, wait stats, query tuning)
- No multi-tenant SaaS hosting concerns (self-hosted single-org deployment only)
- No high availability of the control plane itself (document a single-node deployment; HA later)

---

## 3. High-Level Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Corporate network segment A          Segment B    ...     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ SQL Server 1 │  │ SQL Server 2 │  │ SQL Server N │      │
│  │  ┌────────┐  │  │  ┌────────┐  │  │  ┌────────┐  │      │
│  │  │SQLAgent│  │  │  │SQLAgent│  │  │  │SQLAgent│  │      │
│  │  └───▲────┘  │  │  └───▲────┘  │  │  └───▲────┘  │      │
│  │ ┌────┴─────┐ │  │ ┌────┴─────┐ │  │ ┌────┴─────┐ │      │
│  │ │  Worker  │ │  │ │  Worker  │ │  │ │  Worker  │ │      │
│  │ └────┬─────┘ │  │ └────┬─────┘ │  │ └────┬─────┘ │      │
│  └──────┼───────┘  └──────┼───────┘  └──────┼───────┘      │
│         │ outbound mTLS   │                 │              │
└─────────┼─────────────────┼─────────────────┼──────────────┘
          ▼                 ▼                 ▼
   ┌─────────────────────────────────────────────────┐
   │              Control Plane (API + hub)          │
   │   gRPC/WebSocket gateway · REST API · AuthN/Z   │
   │   Postgres (state, versions, audit)             │
   └───────────────────────┬─────────────────────────┘
                           │ HTTPS
                    ┌──────▼──────┐
                    │  Dashboard  │
                    │ (React SPA) │
                    └─────────────┘
```

### 3.1 Components

| Component | Runs on | Purpose |
|---|---|---|
| **Worker** | Each SQL Server host (one worker per host; manages all named instances on that host) | Connects to local SQL instance(s), mirrors Agent state up, applies approved changes down, streams logs/history |
| **Control plane** | Central server (customer-hosted, container or VM) | Persistent connection hub for workers, REST API for dashboard, state store, version history, audit log, RBAC |
| **Dashboard** | Browser (served by control plane) | Estate overview, per-instance Agent view, job editor, log viewer, diff/version UI, approvals |

### 3.2 Key architectural decisions

1. **Outbound-only workers.** Workers dial out to the control plane on a single configurable port (default 443) using mTLS. No inbound firewall rules on any SQL host. This is the primary differentiator and must never be compromised by a feature that requires inbound connectivity.
2. **Control plane is the source of record for *history*, not for *truth*.** The on-premise `msdb` is always the runtime truth. The control plane holds a mirrored snapshot plus full version history. Reconciliation is explicit, never silent.
3. **Read-only by default.** A freshly enrolled worker can only observe. Write capability is a scoped, per-worker, per-capability grant enabled deliberately by an admin (see §6).
4. **Every change is versioned and diffable**, whether it originated in the dashboard ("remote") or was detected on-premise ("local drift"). See §7.
5. **One worker per host, multiple instances per worker.** A host frequently runs several named instances; one worker connection multiplexes all of them (each instance is a distinct identity in the control plane). Managing *remote* instances from a worker (worker on host A, SQL on host B) is deferred.

---

## 4. Technology Stack

**TypeScript end-to-end.** One language across worker, control plane, and dashboard means a single shared contracts package (protocol + canonical job schema) consumed by all three components, one toolchain, and a codebase the maintainer can fully review — which matters more than anything else in a project whose core risk is a security-critical write path.

| Component | Stack | Rationale |
|---|---|---|
| Runtime | **Node.js 24 LTS** + **TypeScript** (strict mode) everywhere | Maintainer fluency; mature ecosystem for every required capability |
| Worker | Node service bundled with **esbuild**; runs as a Windows Service via **WinSW** wrapper (battle-tested; used by Jenkins); systemd unit for SQL-on-Linux hosts | Long-running daemon with clean service lifecycle on both platforms |
| SQL Server driver | **`mssql`** (tedious under the hood — Microsoft-stewarded) | Mature, parameterised queries, connection pooling per instance |
| Worker ↔ control plane protocol | **gRPC over HTTP/2 with mTLS** via **`@grpc/grpc-js`**, bidirectional streaming; contracts defined in protobuf, types generated with **`ts-proto`** (buf toolchain) | Streaming for live logs, strongly typed both ends from one `.proto` source, handles reconnects; runs on 443 through most corporate egress |
| Control plane API | **Fastify** (REST + serves the SPA static assets) alongside the `@grpc/grpc-js` worker hub in the same process | The most popular high-performance Node API framework with first-class TypeScript, schema validation (TypeBox/zod), and a huge plugin ecosystem (auth, cookies, CORS, rate-limit) |
| ORM / DB access | **Drizzle ORM** + **postgres.js**, SQL-first migrations | Fully typed, stays close to SQL (needed for jsonb queries, partitioning, high-water-mark upserts); Prisma is the acceptable alternative if contributors prefer it |
| Validation / canonical schema | **zod** — `JobDefinition.v1` is a zod schema in the shared package; canonical serialisation + SHA-256 hashing helpers live beside it | Runtime validation at every trust boundary, static types for free |
| Dashboard | **React + TypeScript + Vite**; TanStack Query; **Monaco** editor for T-SQL step editing and diffs | Familiar, huge ecosystem; Monaco gives SSMS-grade editing |
| Local worker store (outbox) | **`node:sqlite`** (built into the runtime) | Synchronous, zero-config embedded store for offline queueing + idempotency records. Chosen over better-sqlite3 because being part of Node is what lets the worker ship as a single executable and install without a C++ toolchain; the cost is an API still marked experimental, mitigated by pinning the runtime and confining the surface to `outbox.ts` |
| Secrets on worker host | **DPAPI** via a native binding (e.g. `win-dpapi`) on Windows; `0600` file permissions on Linux | Protects the worker's SQL credentials at rest without a key-management dependency |
| Password hashing | **argon2** (npm) | Current best practice |
| Control plane DB | **PostgreSQL 16** — the only supported database | Versioning/audit needs a real relational store; jsonb for job definition snapshots; no SQLite evaluation mode (Docker Compose makes Postgres trivial to run) |
| Monorepo tooling | **pnpm workspaces** (+ turborepo for task caching if the build slows) | Standard, fast, strict dependency isolation |
| Packaging | Worker: MSI containing esbuild bundle + pinned Node runtime + WinSW config, plus a plain zip; Control plane: Docker Compose (app + Postgres) | Frictionless trial; no "install Node first" step for DBAs |
| Testing | **vitest** (unit), **testcontainers** (integration: real SQL Server + Postgres containers), **playwright** (dashboard E2E, minimal) | One test runner across all packages |

### Repository layout (monorepo)

```
/remote-sql-agent
  /packages
    /protocol            # .proto files, buf config, ts-proto generated types,
                         # JobDefinition.v1 zod schema, canonical serializer + hash
    /worker              # worker service (Node daemon)
    /server              # control plane: Fastify REST + gRPC hub + Drizzle schema/migrations
    /dashboard           # React SPA
  /tests
    /integration         # testcontainers E2E: SQL Server + worker + server + Postgres
  /deploy
    docker-compose.yml   # server + postgres
    /worker-msi          # WiX config, WinSW xml, install.ps1
  /docs
    architecture.md      # this document
    security.md
    threat-model.md
  pnpm-workspace.yaml
  turbo.json
```

---

## 5. The Worker

### 5.1 Responsibilities

1. **Enrolment** — one-time registration with the control plane using a short-lived enrolment token; receives its client certificate (see §6.2).
2. **Discovery/snapshot** — on connect, read the full Agent object graph from `msdb` (for every configured instance on the host) and upload a snapshot.
3. **Change detection (local → up)** — poll `msdb` for changes to job definitions, schedules, operators, alerts; compute definition hashes; upload deltas.
4. **History & log streaming (up)** — incrementally ship `sysjobhistory`, `sysjobactivity`, and the SQL Agent error log; stream running-job status.
5. **Command application (down)** — receive signed, scoped commands (create/edit/delete job, enable/disable, start/stop, edit schedule) and apply them via the documented `msdb` stored procedures (`sp_add_job`, `sp_update_job`, `sp_add_jobstep`, `sp_update_schedule`, `sp_start_job`, `sp_stop_job`, etc.). Report per-command success/failure with server error detail.
6. **Health** — heartbeat with worker version, SQL Server version/edition per instance, Agent service status, clock skew.

### 5.2 SQL access model

- Connects to each local instance via a dedicated login (Windows or SQL auth, configured at install; one login per instance).
- **Read-only mode requires only:** `SQLAgentReaderRole` in `msdb` (plus `VIEW SERVER STATE` if streaming `sysjobactivity` extended detail).
- **Write mode requires:** `SQLAgentOperatorRole` (start/stop/enable/disable) and, for full job CRUD, ownership semantics — document clearly that jobs created via the worker are owned by the worker login, and provide a configurable "run-as owner" mapping. Never require `sysadmin`; explicitly warn if the configured login has it.
- All SQL access via parameterised `mssql` requests; no SQL string concatenation anywhere in the codebase (enforced by an eslint rule banning template-literal query construction + code review checklist).

### 5.3 Change detection strategy

- **Definitions:** poll every N seconds (default 30, configurable). Serialise each job (job + steps + schedules + notifications) to the canonical `JobDefinition.v1` JSON form, compute SHA-256, compare with last-known hash. On mismatch, upload the new canonical JSON. `msdb..sysjobs.date_modified` used as a cheap pre-filter.
- **History:** incremental poll of `sysjobhistory` keyed on `instance_id` high-water mark (default every 10s). Note: rows only appear on **step completion** — this is a SQL Server limitation. Surface running-step elapsed time from `sysjobactivity` + `sp_help_job @execution_status`.
- **Agent error log:** tail via `sp_readerrorlog`/`xp_readerrorlog` against the Agent log, incremental by timestamp.
- Document the "almost live" caveat honestly in the UI: history granularity = step completion; activity granularity = poll interval.

### 5.4 Resilience

- Persistent gRPC stream with exponential backoff reconnect (jittered, cap 60s).
- Local outbox: history/log deltas queue to the worker's SQLite file (`node:sqlite`) when offline; drain on reconnect (bounded size with oldest-first eviction; eviction is logged and reported).
- Commands are **not** queued worker-side when offline — an offline worker simply can't receive them; the control plane holds pending commands with a TTL (default 15 min, then auto-expire to `Failed: worker offline`).
- Idempotency: every command carries a UUID; worker records applied command IDs in the same SQLite file and no-ops duplicates.
- Node-specifics: catch `unhandledRejection`/`uncaughtException` → structured log + clean exit; WinSW/systemd restarts the process. Health file heartbeat so the service wrapper can detect a wedged event loop.

---

## 6. Security Model

Security is the make-or-break of this product: a writable worker is remote code execution on the database server (job steps can run T-SQL, PowerShell, CmdExec). Design accordingly.

### 6.1 Principles

1. **Read-only by default.** Write capabilities are opt-in, per worker, per capability.
2. **Outbound-only, mTLS everywhere.** Workers authenticate with client certificates; the control plane authenticates with its server certificate. No shared static API keys.
3. **Least privilege at every layer:** worker's SQL login, worker's capability grant, dashboard user's role.
4. **Everything audited.** Every read of sensitive data and every mutation is written to an append-only audit log.
5. **The control plane can never push arbitrary SQL.** The command vocabulary is a closed, typed set (see §6.4). There is deliberately no "run this T-SQL" command in v1. (Job *step* bodies are T-SQL, but they are created as Agent job definitions subject to approval flow — not executed ad hoc by the worker.)

### 6.2 Identity & transport

- **PKI:** the control plane embeds a minimal CA (Node `crypto`/`node-forge` or shell-out to step-ca; keep it simple). Enrolment flow:
  1. Admin generates a single-use enrolment token (TTL 1 hour) in the dashboard, scoped to a host name.
  2. Installer passes the token; worker generates a keypair locally, submits a CSR over TLS with the token.
  3. Control plane issues a client certificate (default validity 90 days) bound to the worker identity.
  4. Automatic rotation at 2/3 lifetime; revocation list checked on every connection.
- Private key stored via DPAPI (Windows) / file with 0600 (Linux). Never leaves the host.
- gRPC channel requires TLS 1.2+ with client cert; reject anything else.

### 6.3 Capability scoping (worker-level)

Each worker has a server-side capability set, editable only by admins, evaluated on every command:

| Capability | Allows |
|---|---|
| `observe` (always on) | Snapshot, change detection, history/log streaming |
| `job.toggle` | Enable/disable jobs |
| `job.run` | Start/stop jobs on demand |
| `schedule.write` | Create/edit/delete schedules |
| `job.write` | Create/edit/delete jobs and steps |
| `operator.write` | Manage operators/alerts |

The worker also enforces its own ceiling from local config (`maxCapability: readOnly` in `worker.yaml` can never be overridden remotely) — so a site can hard-pin a worker to observe-only regardless of control-plane state. Defence in depth against control-plane compromise.

### 6.4 Command pipeline

```
Dashboard user action
  → Fastify REST API (user AuthN + RBAC check, zod-validated payload)
  → [optional] approval workflow (second user approves; required for job.write by default)
  → Command record persisted (audit) with full intended definition
  → Capability check against target worker
  → Signed command streamed to worker
  → Worker validates signature, capability ceiling, idempotency
  → Worker applies via msdb sprocs
  → Result streamed back, persisted, version history updated
```

Commands are a closed protobuf enum + typed payloads. Adding a new command type is a deliberate protocol change, reviewed as such. Per-command signatures are retained even though the channel is mTLS: they make every command independently auditable after the fact and defend against a compromised TLS-terminating layer in front of the control plane.

### 6.5 Dashboard AuthN/Z

- v1: local users (argon2id password hashing) + built-in roles: `Viewer`, `Operator` (toggle/run), `Editor` (schedule/job write, subject to approvals), `Admin` (workers, capabilities, users, approvals).
- Session: HTTP-only secure cookies (`@fastify/secure-session`), CSRF protection, short-lived JWT for the SPA's API calls.
- v1.x: OIDC (Entra ID first — this audience lives in Microsoft land).
- RBAC is enforced server-side on every endpoint (Fastify preHandler hooks); the SPA hides UI it can't use but is never the enforcement point.

### 6.6 Secrets & sensitive data

- Job step bodies may contain secrets (connection strings, etc.). Treat job definitions as sensitive: encrypted at rest in Postgres (app-level AES-GCM with a key from env/KMS), redaction rules configurable per instance (regex-based masking in the UI for e.g. `Password=...`).
- Worker's SQL credentials: stored only on the worker host (DPAPI-protected), never transmitted to the control plane.

### 6.7 Threat model (maintain `/docs/threat-model.md`)

Minimum scenarios to document with mitigations: control-plane compromise (→ worker-side ceilings, closed command set, cert revocation), stolen worker cert (→ short validity, revocation, IP anomaly alerting), malicious dashboard admin (→ approvals, immutable audit, export to SIEM), MITM (→ mTLS, pinned CA), replay (→ command UUIDs + timestamps), supply chain (→ pnpm lockfile, `pnpm audit` in CI, minimal native-module surface: argon2 and win-dpapi only, both control-plane side).

---

## 7. Sync, Versioning & Drift

### 7.1 Canonical job definition

A single canonical schema (`JobDefinition.v1`, zod) representing job + steps + schedules + notification config, with stable key ordering and normalised whitespace, used identically by worker (hashing/serialising from msdb) and server (storing/diffing). This schema lives in `packages/protocol` and is the contract everything hangs off.

### 7.2 Version history

Every observed state of every job is a **version** row:

```
job_versions(
  id, instance_id, job_uuid,
  version_no,                 -- monotonic per job
  definition jsonb,           -- canonical JSON
  definition_hash,
  origin,                     -- 'remote' (dashboard change) | 'local' (drift detected on-prem) | 'initial'
  command_id nullable,        -- links remote changes to the audited command
  detected_at, created_by nullable
)
```

- **Remote change:** command applied successfully → new version with `origin=remote`, linked to command + user.
- **Local change (drift):** worker's hash comparison detects an on-prem edit (someone used SSMS) → new version with `origin=local`, flagged as drift.
- Dashboard shows a per-job timeline with side-by-side and unified diffs (JSON-aware diff; T-SQL step bodies diffed as text with Monaco diff viewer).

### 7.3 Drift & conflict policy

- Drift is **normal and expected** (DBAs will keep using SSMS). It is surfaced, never silently overwritten.
- Conflict definition: a dashboard edit is submitted against version N, but the worker reports the live definition no longer matches N.
- Policy: **flag-and-ask, never last-write-wins.** The command fails with `Conflict`, the dashboard shows a 3-way view (base N / local live / proposed), and the user explicitly chooses: rebase their edit onto live, or overwrite live (which itself creates a version and is audited as an overwrite).
- Optional per-instance setting: "drift alerting" (notify a channel/webhook when `origin=local` versions appear on protected jobs).

---

## 8. Data Model (control plane, principal tables)

```
instances(id, host_id, name, environment_tag, sql_version, agent_status, last_seen, ...)
workers(id, host_id, cert_serial, cert_expires, version, capabilities jsonb, max_capability_reported, ...)
jobs(id, instance_id, job_uuid, name, enabled, current_version_no, category, owner, is_drifted, ...)
job_versions(...)                      -- §7.2
job_history(id, instance_id, job_uuid, step_id, run_status, run_datetime, duration, message, sql_instance_id_hwm, ...)
job_activity(instance_id, job_uuid, state, current_step, started_at, ...)   -- upserted live view
agent_log_entries(id, instance_id, logged_at, severity, message)
commands(id, type, payload jsonb, target_worker, issued_by, approved_by, state, result, timestamps...)
audit_log(id, at, actor, actor_type, action, target, detail jsonb)          -- append-only
users(id, username, pw_hash, role, ...), sessions(...), enrolment_tokens(...)
```

Retention: history/log tables partitioned by month with configurable retention (default 90 days).

---

## 9. Dashboard (v1 screens)

1. **Estate overview** — grid of instances: connection status, agent status, jobs failed in last 24h, running now, drift badges. Filter by environment tag.
2. **Instance view** — SSMS-like tree: Jobs / Schedules / Operators / Alerts / Error Log. Job list with last outcome, next run, enabled state, drift indicator.
3. **Job detail** — steps, schedules, notifications; **History tab** (per-run, per-step, expandable messages — visually equivalent to SSMS "View History"); **Versions tab** (timeline + diffs, §7.2); **Activity** (live-ish state, elapsed time).
4. **Job editor** — create/edit with Monaco for step bodies, schedule builder matching SSMS semantics (`sp_add_schedule` parameter model exactly — freq_type/freq_interval etc. abstracted behind a humane UI but stored faithfully).
5. **Cross-estate job search** — find jobs by name/step-body text across all instances (e.g. "which servers still reference server X in a step?"). This is a killer feature that SSMS cannot do; prioritise it.
6. **Commands & approvals** — pending/approved/failed command queue.
7. **Admin** — workers & capabilities, enrolment tokens, users/roles, audit log viewer (filter/export CSV/JSONL).

UX north star: a DBA who lives in SSMS should feel at home immediately. Match SSMS terminology exactly (job, step, schedule, operator, "View History").

---

## 10. Protocol Sketch (protobuf, indicative)

```proto
service WorkerHub {
  rpc Session (stream WorkerMessage) returns (stream ServerMessage);
}

message WorkerMessage {
  oneof msg {
    Hello hello;                    // version, host + instance metadata, max_capability
    Snapshot snapshot;              // full object graph (chunked)
    DefinitionDelta definition;     // canonical JSON + hash
    HistoryBatch history;
    ActivityUpdate activity;
    AgentLogBatch agent_log;
    CommandResult command_result;
    Heartbeat heartbeat;
  }
}

message ServerMessage {
  oneof msg {
    HelloAck hello_ack;             // assigned config: poll intervals, capabilities
    Command command;                // typed, signed, idempotency UUID
    ConfigUpdate config;
  }
}

message Command {
  string id;
  google.protobuf.Timestamp issued_at;
  bytes signature;                  // server signs (id|type|payload_hash|issued_at)
  oneof payload {
    ToggleJob toggle_job;
    RunJob run_job; StopJob stop_job;
    UpsertJob upsert_job;           // full JobDefinition.v1 (create or update, with base_version for conflict check)
    DeleteJob delete_job;
    UpsertSchedule upsert_schedule; DeleteSchedule delete_schedule;
    UpsertOperator upsert_operator; ...
  }
}
```

Generated with `ts-proto` into `packages/protocol`; both worker and server import from there. The `.proto` files are the single source of truth; regeneration is a CI-checked step (fail if generated output is stale).

---

## 11. Implementation Plan (phased, for a Claude Code agent)

Each milestone ends with passing tests and a tagged, runnable state. Do not start a milestone until the previous one's acceptance criteria pass.

### M0 — Skeleton & contract (foundation)
- Monorepo scaffold per §4 (pnpm workspaces); CI (GitHub Actions): typecheck, lint, unit tests, dashboard build, generated-protobuf staleness check.
- `packages/protocol`: protobuf contracts + ts-proto generation, `JobDefinition.v1` zod schema + canonical serializer + SHA-256 hash, with golden-file tests (same msdb fixture → identical hash from worker and server code paths).
- Docker Compose dev environment: Postgres + SQL Server 2022 container seeded with fixture Agent jobs (seed script creates ~10 varied jobs: multi-step, T-SQL/PowerShell/CmdExec steps, assorted schedule types).
- **Accept:** `docker compose up` yields a seeded SQL instance; contract tests green.

### M1 — Read-only vertical slice
- Worker: connect to SQL via `mssql`, full snapshot, definition polling + hashing, history high-water-mark shipping, activity polling, agent log tailing; plain TLS to server (mTLS comes in M3), `node:sqlite` outbox.
- Server: WorkerHub gRPC session handling, persistence of snapshot/deltas/history via Drizzle, Fastify REST read API.
- Dashboard: estate overview, instance view, job detail with History tab.
- **Accept:** run a fixture job → within one poll interval the dashboard shows the run with step-level messages matching SSMS View History. Kill the network between worker and server mid-run → history arrives after reconnect (outbox test).

### M2 — Versioning & drift
- `job_versions` pipeline, `origin` attribution, drift flagging, Versions tab with JSON + Monaco text diffs, cross-estate search.
- **Accept:** edit a job in SSMS (integration test does it via T-SQL) → drift version with `origin=local` appears and job shows drift badge; diff renders the changed step body.

### M3 — Security hardening
- Embedded CA, enrolment token flow, client cert issuance/rotation/revocation; mTLS enforced on the gRPC hub.
- Users/roles/sessions (argon2, secure cookies, CSRF); server-side RBAC on all Fastify routes; append-only audit log + viewer.
- Worker `maxCapability` ceiling honoured; capabilities model in place (all writes still disabled — vocabulary exists, no write commands implemented yet).
- **Accept:** connection without valid client cert rejected; revoked cert rejected within 60s; every REST mutation and worker session event appears in audit log; pen-test checklist in `/docs/security.md` executed.

### M4 — Write path, minimal blast radius first
- Implement commands in strict order: `job.toggle` → `job.run`/`stop` → `schedule.write` → `job.write` (+ delete) — each with capability checks, signing, idempotency, conflict check (`base_version`), result handling, and versioning integration.
- Approval workflow (default-on for `job.write`), pending-command TTL/expiry.
- Job editor + schedule builder UI; 3-way conflict resolution UI.
- **Accept:** integration suite proves: command against stale `base_version` → Conflict, resolution flow works; worker pinned to `maxCapability: readOnly` rejects a server-approved write; every applied change visible in SSMS matches the canonical definition byte-for-byte on re-snapshot (round-trip fidelity test — this is the most important test in the project).

### M5 — Operability & release
- Worker MSI (WiX: esbuild bundle + pinned Node runtime + WinSW service config) + install.ps1 (service install, enrolment, SQL login setup guidance); compose-based server deployment; upgrade path (worker self-reports version, server-side min-version gate).
- Retention/partitioning jobs, `/metrics` Prometheus endpoint, structured logging (pino) across worker and server.
- Docs: quick start, security guide, threat model, capability guide, FAQ ("does this replace SQL Agent?" — no).
- **Accept:** clean-machine install of server + one worker following only the quick start, in under 30 minutes.

### Deferred (post-v1 backlog)
OIDC/Entra SSO · webhook/Teams/Slack drift+failure alerts · job "templates" deployed to many instances · proxy/credential management · remote-instance workers · SQL Managed Instance support · control-plane HA · SIEM export.

---

## 12. Testing Strategy

- **Unit (vitest):** canonical serialisation/hashing (golden files), schedule semantics (SQL Agent `freq_*` encoding is notoriously fiddly — exhaustive table-driven tests), diff engine, RBAC matrix, zod boundary validation.
- **Integration (testcontainers):** real SQL Server container; worker + server + Postgres; scenarios in §11 acceptance criteria; chaos cases (restart worker mid-snapshot, restart server mid-stream, clock skew).
- **Round-trip fidelity suite:** for every fixture job: snapshot → canonical JSON → `UpsertJob` onto a second clean instance → re-snapshot → definitions identical. Run in CI on every PR touching `packages/protocol` or the worker.
- **Security tests:** cert validation matrix, RBAC endpoint sweep (every Fastify route × every role), command signature tampering, replay.

---

## 13. Resolved Decisions (formerly open questions)

1. **Name:** **Remote SQL Agent**. Repo/npm scope `remote-sql-agent`, CLI `rsagent`. Do not abbreviate to "RSA" anywhere user-facing. Verify github/npm availability before M0.
2. **Worker placement:** one worker per host; a single worker manages all named instances on its host. Remote-instance support deferred to backlog.
3. **Control plane DB:** Postgres-only, via Docker Compose. No SQLite evaluation mode.
4. **Command signatures:** retained on top of mTLS — independently auditable commands, resilient to a compromised TLS-terminating layer.
5. **Licensing:** fully open (Apache 2.0) for v1; no open-core split. Revisit only with real traction.