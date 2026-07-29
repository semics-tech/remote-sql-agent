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

This repository implements **all six milestones** of
`docs/remote-sql-agent-architecture.md`: contract, read-only slice,
versioning/drift/search, security hardening, the write path, and packaging.

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
- **Make changes and have them applied**: enable/disable, start/stop, and full job
  editing with a Monaco step editor — every change signed, capability-checked,
  conflict-checked and audited, with a second-approver rule on job edits
- **Deploy it**: production Dockerfile and Compose for the control plane, WinSW
  service wrapper and `install.ps1` for Windows workers, systemd unit for
  SQL-on-Linux

**Known gaps**

- Worker certificate auto-rotation at 2/3 lifetime is not implemented — rotation
  is manual (token-mode keys rotate from the dashboard)
- No MSI; the worker ships as a zip plus `install.ps1`. The WinSW binary and a
  pinned Node runtime are fetched at packaging time rather than vendored
- Deleting an *operator* is explicitly refused: the command carries an
  instance-local id, which is not a safe thing to delete by
- No control-plane HA — the worker registry is in-memory

> Read `docs/security.md` and `docs/quick-start.md` before deploying anywhere.

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

## Documentation

| | |
|---|---|
| [quick-start.md](docs/quick-start.md) | Nothing to a working estate view in 30 minutes |
| [capabilities.md](docs/capabilities.md) | What a worker may do, and how to choose |
| [authentication.md](docs/authentication.md) | Entra sign-in, worker auth modes, audit export |
| [security.md](docs/security.md) | What is enforced, and the deployment checklist |
| [threat-model.md](docs/threat-model.md) | Scenarios, mitigations and residual risk |
| [faq.md](docs/faq.md) | Including "does this replace SQL Agent?" (no) |

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
deploy/              production Dockerfile + Compose, dev stack, SQL fixture seed,
                     worker service wrapper (WinSW / systemd) and install.ps1
docs/                architecture spec, quick start, capabilities guide,
                     authentication and audit guide, security guide,
                     threat model, FAQ
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

The server tests each provision their own Postgres database on first run. Version allocation under
concurrency, `ON CONFLICT` idempotency and high-water-mark monotonicity are not meaningfully
testable against a mock.

```bash
pnpm test:integration   # needs the dev stack: pnpm dev:up && pnpm dev:seed
```

The integration suite drives a real worker against a real SQL Server: it starts jobs and waits for
their step-level history, edits a job the way SSMS would and asserts drift attribution, and proves
round-trip fidelity — a definition sent from the dashboard is byte-for-byte identical when read back
from `msdb`.

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
