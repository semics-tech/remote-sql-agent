# Capabilities

What a worker is allowed to do, and how to decide.

## Two gates, and why

A worker's effective capability is the **intersection** of two independently
controlled sets:

```
  server-side grant              worker-side ceiling
  (dashboard, per worker)        (worker.yaml, on the SQL host)
           │                              │
           └────────── ∩ ─────────────────┘
                       │
              what the worker will do
```

The worker computes this itself, from its own config, on every session. The
control plane's arithmetic is advisory and is never trusted.

That is the point. A site that pins `maxCapability: readOnly` has a worker that
cannot be made to write **even if the control plane is fully compromised** —
short of an attacker who can also edit files on the SQL Server host, at which
point they did not need the worker.

Both gates must permit an action. Granting `job.write` in the dashboard to a
worker pinned at `readOnly` does nothing except make the dashboard show
"observe" as the effective set.

## The capabilities

| Capability | Permits | Requires in msdb |
|---|---|---|
| `observe` | Read jobs, steps, schedules, operators, alerts, run history, activity. Always on; cannot be revoked. | `SQLAgentReaderRole` **and** SELECT on the msdb tables — see below |
| `job.toggle` | Enable and disable jobs | `SQLAgentOperatorRole` |
| `job.run` | Start and stop jobs on demand | `SQLAgentOperatorRole` |
| `schedule.write` | Create, edit and delete schedules | `SQLAgentOperatorRole` + ownership |
| `job.write` | Create, edit and delete jobs and their steps | job ownership |
| `operator.write` | Manage operators and alerts | `SQLAgentOperatorRole` |

> **`observe` needs table grants as well as the role.** The SQL Agent roles
> grant EXECUTE on the `sp_help_*` procedures, not SELECT on the tables under
> them, and the worker reads those tables directly — it keeps a high-water mark
> over `sysjobhistory.instance_id` so history can be read incrementally, which
> no stored procedure exposes. Measured on SQL Server 2022, ten of the twelve
> tables it needs are denied to a member of `SQLAgentOperatorRole`.
>
> Run [`deploy/sql/worker-permissions.sql`](../deploy/sql/worker-permissions.sql)
> once per instance. The write capabilities above really are just the role,
> because writes go through the stored procedures.

## The ceilings

`maxCapability` in `worker.yaml` is one of four tiers. Each grants everything at
or below it:

| Tier | Includes | Use when |
|---|---|---|
| `readOnly` | `observe` | **The default, and the right starting point.** Visibility, history, drift detection and cross-estate search all work here. |
| `operate` | + `job.toggle`, `job.run` | An on-call DBA should be able to restart a failed job or disable a noisy one without an RDP session. |
| `schedule` | + `schedule.write` | Schedule changes are managed centrally. |
| `full` | + `job.write`, `operator.write` | Job definitions are authored and deployed from the dashboard. |

## Choosing

Start every worker at `readOnly` and raise it only where there is a concrete
need. Some things worth weighing:

**`job.write` is remote code execution on a database server.** A job step can
run T-SQL, PowerShell or CmdExec as the Agent service account. A worker at
`full` means anyone who can both author and approve a change in the dashboard
can run arbitrary code on that host. That may be exactly what you want for a
development estate and exactly what you do not want for a payments database.

**Tier by environment, not uniformly.** A common shape:

```
development       full
test              schedule
production        operate      # restart a failed job, yes; redefine it, no
regulated/PCI     readOnly     # changes go through change control, not here
```

**`operate` is the sweet spot for most production estates.** It covers the
overwhelmingly common out-of-hours action — a job failed, restart it — without
allowing anyone to change what the job does.

**Approvals are not a substitute for a low ceiling.** `job.write` requires a
second approver by default, and the approver cannot be the person who issued the
change. That is a good control against mistakes and a real one against a single
malicious insider. It is not a control against a compromised control plane,
because a compromised control plane can approve its own commands. Only the
worker-side ceiling survives that.

## Changing a ceiling

The ceiling lives on the SQL host on purpose — raising it requires access to
that host, which is the property that makes it meaningful.

```powershell
# On the SQL Server host
notepad "C:\Program Files\RemoteSqlAgent\worker.yaml"
# maxCapability: operate
Restart-Service rsagent-worker
```

The dashboard shows both the grant and the reported ceiling side by side in
**Administration → Workers**, so a mismatch is visible rather than mysterious.

## What is refused, and how you find out

A command that either gate rejects is refused with a reason, recorded against
the command, and visible in **Commands**:

```
This worker is not permitted to job.toggle. Its effective capabilities are:
observe. Raise maxCapability in worker.yaml if that is intended.
```

Refusals are audited the same as successes. A worker refusing commands it should
be accepting is a configuration problem you can see, not a silent failure.

## Second-approver rule

Editing a job definition can require a second person to approve it before it reaches msdb. It is
**off by default**.

A four-eyes rule is the right control for a change-managed estate and the wrong one for a lone DBA
looking after their own servers — for them it is an approval that can never be granted, since the
approver may not be the issuer. Sites that need it turn it on; the mechanism is unchanged when they
do.

```bash
RSAGENT_REQUIRE_APPROVAL_JOB_WRITE=true
# Roles exempt when it is on. Default: Admin.
RSAGENT_APPROVAL_EXEMPT_ROLES=Admin
```

Admins are exempt by default because an Admin can grant themselves any role and revoke anyone
else's, so requiring their changes to be countersigned is procedure rather than control. Set
`RSAGENT_APPROVAL_EXEMPT_ROLES=` (empty) to apply it to everyone including Admins.

It applies to `upsertJob`, `deleteJob`, `upsertOperator` and `deleteOperator` — the commands that
change a definition. Enable, disable, start and stop are never gated: they are reversible, and
gating them makes the tool useless for the thing it is most often opened for.

## What no capability permits

There is no capability that lets the control plane run arbitrary T-SQL. The
command vocabulary is a closed protobuf enum, and adding to it is a protocol
change reviewed as one.

Job *step bodies* are of course arbitrary T-SQL — but they are installed as
Agent job definitions through the approval flow and executed by SQL Agent on its
own schedule, never run ad hoc by the worker.
