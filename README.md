<div align="center">

# Remote SQL Agent

**Manage SQL Server Agent jobs across every server you own — without opening a single inbound port.**

[![CI](https://github.com/semics-tech/remote-sql-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/semics-tech/remote-sql-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@remote-sql-agent/worker.svg)](https://www.npmjs.com/package/@remote-sql-agent/worker)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)

[Quick start](docs/quick-start.md) ·
[Capabilities](docs/capabilities.md) ·
[Security](docs/security.md) ·
[FAQ](docs/faq.md) ·
[Roadmap](docs/migration.md)

</div>

---

## The problem

You have 50 SQL Servers across half a dozen firewalled network segments. To see
why a job failed last night you RDP into a box and open SSMS. To check whether
anyone still runs that decommissioned feed, you open 50 boxes.

Everything that claims to fix this needs the management plane to *reach* the
instances — MSX/TSX, Central Management Servers, most commercial tools. Across
segmented corporate networks, that is the one thing you cannot have.

## The approach

A small worker runs next to each SQL Server and dials **outbound** to a central
control plane. It mirrors the local Agent — jobs, steps, schedules, operators,
alerts, history and logs — into a dashboard that gives you an SSMS-shaped view
of every server at once. Authorised changes sync back down.

```
  Segment A                Segment B                 Segment C
 ┌──────────┐             ┌──────────┐              ┌──────────┐
 │ SQLPROD1 │             │ SQLPROD2 │              │ SQLPROD3 │
 │ ┌──────┐ │             │ ┌──────┐ │              │ ┌──────┐ │
 │ │Worker│ │             │ │Worker│ │              │ │Worker│ │
 │ └──┬───┘ │             │ └──┬───┘ │              │ └──┬───┘ │
 └────┼─────┘             └────┼─────┘              └────┼─────┘
      │  outbound only, mTLS or API key over TLS         │
      └──────────────────┬─────┴──────────────────────────┘
                         ▼
                 ┌───────────────┐        ┌──────────┐
                 │ Control plane │───────▶│ Postgres │
                 └───────┬───────┘        └──────────┘
                         │ HTTPS
                    ┌────▼────┐
                    │Dashboard│
                    └─────────┘
```

**No inbound firewall rules. No listening socket on any SQL host.**

### SQL Agent still runs your jobs

The worker never executes a job. It reads `msdb` and, when permitted, calls the
documented Agent stored procedures — the same ones SSMS calls. Stop the worker
and every job keeps running on schedule. Uninstall it and nothing changes except
that you lose the central view.

Zero migration, zero lock-in.

---

## What you get

**See the estate.** Every instance, its jobs, run history with step-level detail
and messages, and live activity — in one grid.

**Catch drift.** Someone edits a job in SSMS at 2am? It appears as a new version,
flagged, with a diff. Drift is expected and surfaced, never silently overwritten.

**Search across every server.** *"Which servers still reference `LEGACYFIN01` in
a job step?"* — full-text across every step body on every instance. SSMS cannot
answer this at any price.

**Change things safely.** Enable, disable, start, stop, and edit jobs with a
Monaco T-SQL editor. Every change is signed, capability-checked, conflict-checked
and audited, with a second-approver rule on job edits.

**Prove what happened.** Every sign-in, change and worker session is recorded and
exportable to any OpenTelemetry backend.

**Least privilege throughout.** Read-only by default. Write capability is opt-in
per worker *and* per capability, and the worker enforces its own ceiling from
local config — so a compromised control plane still cannot make a read-only
worker write.

---

## Install

Full walkthrough: **[docs/quick-start.md](docs/quick-start.md)** — about 30
minutes, most of it waiting for containers.

### Control plane

```bash
git clone https://github.com/semics-tech/remote-sql-agent
cd remote-sql-agent/deploy
cp .env.example .env      # set RSAGENT_PUBLIC_URL and POSTGRES_PASSWORD
docker compose up -d
```

Put a TLS certificate for the hub in `deploy/tls/`. The control plane refuses to
start without one, because worker API keys are bearer secrets.

On first boot it creates an administrator and prints a generated password
**once** — copy it from the log.

### Worker

Generate a single-use enrolment token in the dashboard
(**Administration → Workers**), then on the SQL Server host:

```powershell
.\install.ps1 -ControlPlane rsagent.corp.example.com:8443 `
              -EnrolmentToken rsen_xxxxxxxxxxxx `
              -CaCertPath C:\certs\corp-ca.pem
```

SQL Server on Linux, or you prefer npm:

```bash
npm install -g @remote-sql-agent/worker
rsagent enrol --token rsen_xxxxxxxxxxxx /etc/rsagent/worker.yaml
rsagent /etc/rsagent/worker.yaml
```

### SQL Server permissions

Read-only mirroring needs one role:

```sql
USE [msdb];
CREATE USER [CORP\SQLAGENT-SVC] FOR LOGIN [CORP\SQLAGENT-SVC];
ALTER ROLE [SQLAgentReaderRole] ADD MEMBER [CORP\SQLAGENT-SVC];
```

Add `SQLAgentOperatorRole` only when you want the worker to make changes. **Never
grant `sysadmin`.**

---

## Capabilities

A worker's effective capability is the **intersection** of two independently
controlled sets:

```
   server-side grant  ∩  worker-side ceiling  =  what it will do
   (dashboard)           (worker.yaml)
```

The worker computes this itself, from its own config, on every session. A site
that pins `maxCapability: readOnly` has a worker that cannot be made to write
**even if the control plane is fully compromised**.

| Tier | Adds | Typical use |
|---|---|---|
| `readOnly` | observe | **Default.** Visibility, history, drift, search |
| `operate` | toggle, start/stop | On-call restarts a failed job without an RDP session |
| `schedule` | schedule edits | Schedules managed centrally |
| `full` | job and operator edits | Jobs authored from the dashboard |

`job.write` is effectively remote code execution on a database server — a job
step runs T-SQL, PowerShell or CmdExec. Choose deliberately;
[docs/capabilities.md](docs/capabilities.md) walks through it.

---

## Sign-in

Microsoft Entra ID (app-role mapping), local accounts, or both. Keeping both
leaves a break-glass administrator when the IdP is unreachable.

| Entra app role | Dashboard role | Can |
|---|---|---|
| `rsagent.viewer` | Viewer | Read everything |
| `rsagent.operator` | Operator | + enable/disable, start/stop |
| `rsagent.editor` | Editor | + edit schedules and jobs (subject to approval) |
| `rsagent.admin` | Admin | + workers, users, approvals, audit |

Setup: [docs/authentication.md](docs/authentication.md).

---

## Documentation

| | |
|---|---|
| [quick-start.md](docs/quick-start.md) | Nothing to a working estate view |
| [capabilities.md](docs/capabilities.md) | What a worker may do, and how to choose |
| [notifications.md](docs/notifications.md) | Alerting to email, Slack, Teams or a webhook |
| [authentication.md](docs/authentication.md) | Entra sign-in, worker auth, audit export |
| [security.md](docs/security.md) | What is enforced, and a deployment checklist |
| [threat-model.md](docs/threat-model.md) | Scenarios, mitigations, residual risk |
| [faq.md](docs/faq.md) | Including "does this replace SQL Agent?" (no) |
| [migration.md](docs/migration.md) | Roadmap, known gaps, upgrade path |
| [remote-sql-agent-architecture.md](docs/remote-sql-agent-architecture.md) | The original design spec |

---

## Status

All six milestones of the architecture spec are implemented. **204 tests**,
including an integration suite that drives a real worker against a real SQL
Server: starting jobs and waiting for their step-level history, editing a job the
way SSMS would and asserting drift attribution, and proving round-trip
fidelity — a definition sent from the dashboard is byte-for-byte identical when
read back from `msdb`.

Version `0.x`: breaking changes may land in minor versions until `1.0`.

Known gaps — no control-plane HA, manual certificate rotation, no MSI — are
tracked with impact and effort in [docs/migration.md](docs/migration.md).

---

## Development

Requires Node.js 22+, pnpm 10+ and Docker.

```bash
pnpm install
pnpm dev:up          # Postgres + SQL Server 2022 with Agent enabled
pnpm dev:seed        # ~10 varied fixture jobs
```

> The SQL Server image is amd64 and runs under emulation on Apple Silicon.
> Allow 60–90s for it to become healthy, and give Docker at least 6 GB. Below
> that it is the container the kernel picks first: `docker ps -a` shows
> `Exited (137)`, and everything downstream looks like a connection bug instead.

**Three long-running processes**, one terminal each. All three are needed: the
control plane serves the API, the worker is what actually talks to SQL Server,
and without it the dashboard is an empty estate.

```bash
# 1. Control plane — API on :8080, worker hub on :8443
pnpm dev:server

# 2. Dashboard — http://localhost:5173, proxies /api to :8080
pnpm dev:dashboard

# 3. Worker — listens on nothing; dials out to the hub
pnpm dev:worker
```

### Signing in

The dashboard asks for credentials in development too. There is deliberately no
local bypass: an authentication switch that can be turned off is one that
eventually ships turned off, and every RBAC path in the product hangs off having
a real signed-in user with a real role.

`pnpm dev:server` instead fixes the bootstrap password to something you already
know, by setting `RSAGENT_BOOTSTRAP_ADMIN_PASSWORD`:

```
username: admin
password: rsagent-dev
```

That only applies on first boot, when the database has no users yet. If you have
an older dev database — or you changed the password and forgot it:

```bash
pnpm dev:reset-admin
```

It refuses to touch anything but a database on `localhost`.

In a real deployment neither exists: the control plane generates a password on
first boot and prints it **once**.

### Enrolling the dev worker

The worker needs enrolling before step 3 works. Sign in, then **Estate → Add a
worker** for a token:

```bash
pnpm dev:enrol --token rsen_xxxxxxxxxxxx
```

That writes `packages/worker/run/worker.key` (the credential) and
`credential.key` (the key SQL credentials are encrypted to). Delete either and
the worker cannot reconnect — rotate a new one from **Administration → Workers**.

### Letting the dev worker make changes

Two gates, and **both** must allow it — see [capabilities.md](docs/capabilities.md):

1. **Administration → Workers → Manage** — tick the capabilities to grant.
2. `deploy/worker.dev.yaml` — raise `maxCapability` from `readOnly`.

`maxCapability` is read **once at startup**, so restart the worker afterwards;
reconnecting re-sends the old value. Confirm it took by looking for
`capabilities` in the worker's `Worker ready` log line, or the "Can actually do"
column in Administration.

> Two worker processes sharing one credential supersede each other in a loop —
> each connect kicks the other off. If capability changes appear to be ignored,
> or the estate flickers, check for a stray worker before anything else.

```bash
pnpm test              # unit + integration
pnpm test:unit         # no containers needed beyond Postgres
pnpm lint
pnpm typecheck
pnpm proto:check       # fails if generated protobuf has drifted
```

### See drift detection work

Edit a job the way a DBA would, directly in SQL:

```bash
docker exec rsagent-dev-sqlserver-1 /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'RsAgent_Dev_Pass123' -C -Q "
EXEC msdb.dbo.sp_update_jobstep
    @job_name = N'RSAgent Fixture - Heartbeat Log', @step_id = 1,
    @command = N'EXEC dbo.usp_LogMaintenance @Source = N''Heartbeat'', @Message = N''Edited in SSMS'';';"
```

Within the poll interval the job shows a **drift** badge, and its Versions tab
has a new `on-premise edit` version with a diff of the changed step body.

### Layout

```
packages/protocol     .proto contracts, JobDefinition.v1 schema, canonical
                      hashing, schedule codec, capability model  [published]
packages/worker       Node daemon: msdb reader/writer, outbox, gRPC   [published]
packages/server       Control plane: gRPC hub, Postgres, REST API      [container]
packages/dashboard    React SPA                          [built into container]
deploy/               Dockerfile, Compose, installers, dev stack
docs/                 everything above
```

The `.proto` files are the single source of truth for the wire contract.
Generated output is checked in so no contributor needs a protoc toolchain, and
CI fails if it drifts.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues:
[SECURITY.md](SECURITY.md), please do not open a public issue.

---

## Licence

[Apache 2.0](LICENSE). Fully open source, no open-core split.
