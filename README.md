# Remote SQL Agent

Centrally view, monitor and manage **SQL Server Agent** jobs across an estate of on-premise
instances sitting behind multiple corporate firewalls — without opening a single inbound port.

A lightweight worker runs next to each SQL Server instance and dials **outbound** to a central
control plane. It mirrors the local Agent — jobs, steps, schedules, operators, alerts, history and
logs — into a web dashboard that gives you an SSMS-like Agent experience across every server at
once.

**SQL Agent remains the execution engine.** The worker never runs a job itself. It observes, and
(when explicitly permitted) administers the local Agent through documented `msdb` stored procedures.
Remove the worker and everything still runs exactly as before.

Apache 2.0. CLI/binary name: `rsagent`.

---

## Status

This repository implements **milestones M0–M3** of `docs/remote-sql-agent-architecture.md`: the
contract, the read-only vertical slice, versioning/drift/search, and security hardening.

**Working today**

- Worker mirrors job definitions, run history, live activity and the Agent error log from every
  configured instance on its host
- Canonical `JobDefinition.v1` schema with stable hashing shared by worker and server
- Full version history per job, with `initial` / `local` / `remote` origin attribution
- Drift detection: edit a job in SSMS and it appears as a new version, flagged, with a diff
- Cross-estate search over job names **and step body text**
- Offline outbox with replay on reconnect; jittered exponential backoff
- Dashboard: estate overview, instance view, job detail with History, Versions and diffs
- **Sign-in with Microsoft Entra ID** (app-role mapping) and/or local accounts, with server-side
  RBAC on every route
- **Worker enrolment** with a choice of API key, mTLS client certificate, or Azure managed identity
- **Audit log** of every sign-in, administrative change and worker session, exportable to any
  OpenTelemetry-compatible backend

**Not built yet**

- **M4 — the write path.** No command is applied by the worker. The vocabulary exists on the wire
  and is signed; nothing acts on it. No approval workflow, no job editor.
- **M5 — packaging.** No MSI, no WinSW service wrapper, no production Compose deployment.
- Certificate auto-rotation at 2/3 lifetime — rotation is currently manual.

> Not production-ready: the write path and packaging do not exist. But the control plane is no
> longer open — read `docs/security.md` and `docs/authentication.md` before deploying anywhere.

---

## Quick start (development)

Requires Node.js 22+, pnpm 10+ and Docker.

```bash
pnpm install

# Postgres + SQL Server 2022 with Agent enabled.
# The SQL Server image is amd64; on Apple Silicon it runs under emulation and
# takes ~60-90s to become healthy.
pnpm dev:up

# ~10 varied fixture jobs: multi-step branching, T-SQL/PowerShell/CmdExec,
# every schedule type, a deliberate failure, a disabled job.
pnpm dev:seed

# Control plane: REST API on :8080, worker hub on :8443.
# TLS is required by default; disable it for local development only.
RSAGENT_GRPC_REQUIRE_TLS=false pnpm --filter @rsagent/server dev
```

On first boot the control plane creates an administrator and prints its generated password **once**.
Copy it from the log — it is not recoverable.

The worker must be enrolled before it can connect. Sign in at http://localhost:8080, go to
**Administration → Workers**, generate an enrolment token for host `DEV-SQLHOST01`, then:

```bash
# One-time: exchange the token for a worker key
pnpm --filter @rsagent/worker start enrol --token rsen_... ../../deploy/worker.dev.yaml

# Run the worker
pnpm --filter @rsagent/worker start ../../deploy/worker.dev.yaml

# Dashboard with hot reload, in a third terminal
pnpm --filter @rsagent/dashboard dev    # http://localhost:5173
```

Within one poll interval the estate view shows the seeded instance and its jobs.

### See drift detection work

Edit a job the way a DBA would, directly in SQL:

```bash
docker exec rsagent-dev-sqlserver-1 /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'RsAgent_Dev_Pass123' -C -Q "
EXEC msdb.dbo.sp_update_jobstep
    @job_name = N'RSAgent Fixture - Heartbeat Log', @step_id = 1,
    @command = N'EXEC dbo.usp_LogMaintenance @Source = N''Heartbeat'', @Message = N''Edited in SSMS'';';"
```

Within the definition poll interval the job shows a **drift** badge, and its Versions tab has a new
`on-premise edit` version with a side-by-side diff of the changed step body.

---

## Layout

```
packages/protocol    .proto contracts + generated types; JobDefinition.v1 zod schema,
                     canonical serialiser and hashing; schedule freq_* codec;
                     capability and RBAC model; command signing
packages/worker      Node daemon: msdb readers, canonical hashing, incremental
                     history/activity/log shipping, SQLite outbox, gRPC session
packages/server      Control plane: gRPC worker hub, Drizzle/Postgres persistence,
                     versioning and drift, Fastify read API, Prometheus metrics
packages/dashboard   React SPA (Vite, TanStack Query, Monaco for diffs)
deploy/              Docker Compose dev stack, SQL fixture seed, dev worker.yaml
docs/                architecture spec, security guide, threat model,
                     authentication and audit guide
```

The `.proto` files are the single source of truth for the wire contract. Generated output is checked
in so no contributor needs a protoc toolchain, and CI fails if it drifts:

```bash
pnpm proto:gen      # regenerate after editing a .proto
pnpm proto:check    # what CI runs
```

## Tests

```bash
pnpm test:unit        # protocol, worker, server (server tests need the dev Postgres)
pnpm lint
pnpm typecheck
```

The server tests run against a real Postgres, created as `rsagent_test` on first run. Version
allocation under concurrency, `ON CONFLICT` idempotency and high-water-mark monotonicity are not
meaningfully testable against a mock.

## Configuration

The control plane is entirely environment-driven — see `packages/server/src/config.ts`, and
`docs/authentication.md` for the identity and audit settings in full. The essentials:

```bash
RSAGENT_DATABASE_URL=postgres://...
RSAGENT_PUBLIC_URL=https://rsagent.example.com   # also makes session cookies Secure
RSAGENT_AUTH_MODE=both                           # local | entra | both
RSAGENT_GRPC_TLS_CERT=/etc/rsagent/server.crt    # required unless explicitly overridden
RSAGENT_GRPC_TLS_KEY=/etc/rsagent/server.key
RSAGENT_WORKER_AUTH_MODES=token                  # token | mtls | entra
RSAGENT_AUDIT_OTLP_ENDPOINT=http://collector:4318/v1/logs   # optional
```

The worker reads a YAML file (`deploy/worker.dev.yaml` is a commented example). The security-critical
setting is:

```yaml
maxCapability: readOnly   # readOnly | operate | schedule | full
```

This is a ceiling the control plane **cannot raise**. A worker pinned to `readOnly` cannot be made
to write even if the control plane is fully compromised. Leave it at `readOnly` unless you have a
concrete reason not to.

## SQL Server privileges

Read-only mirroring needs only `SQLAgentReaderRole` in `msdb`:

```sql
USE [msdb];
CREATE USER [rsagent_worker] FOR LOGIN [rsagent_worker];
ALTER ROLE [SQLAgentReaderRole] ADD MEMBER [rsagent_worker];
```

Never grant the worker `sysadmin`. Reading the Agent *error log* does need elevated rights; rather
than ask for them, the worker detects the permission error and disables log streaming for that
instance. See `docs/security.md`.
