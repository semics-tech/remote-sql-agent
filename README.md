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

```bash
mkdir -p rsagent && cd rsagent
curl -fsSLO https://raw.githubusercontent.com/semics-tech/remote-sql-agent/main/deploy/setup.sh
chmod +x setup.sh && ./setup.sh          # asks for your domain, brings up the control plane
```

Then in the dashboard: **Administration → Workers → Add a worker**, and run the
one-line command it gives you on each SQL Server host. That's it — no PKI to
set up, no SQL credentials asked for at install.

**Full walkthrough:** [docs/quick-start.md](docs/quick-start.md) — about 15
minutes, most of it waiting for containers. Also covers a deployment with no
public DNS, Kubernetes, and Azure Container Apps. Where to run the control
plane and what it costs: [docs/deployment.md](docs/deployment.md).

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
| [releasing.md](docs/releasing.md) | Cutting a release to npm, Docker Hub and GitHub |
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

Known gaps — no control-plane HA, no MSI packaging, no alerting on a worker
that stops renewing its own certificate — are tracked with impact and effort in
[docs/migration.md](docs/migration.md).

---

## Contributing

Local dev setup (three processes: control plane, dashboard, worker), tests, and
the rules that matter for this codebase specifically: **[CONTRIBUTING.md](CONTRIBUTING.md)**.
Security issues: [SECURITY.md](SECURITY.md), please do not open a public issue.

---

## Licence

[Apache 2.0](LICENSE). Fully open source, no open-core split.
