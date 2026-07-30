# @remote-sql-agent/worker

The worker component of [Remote SQL Agent](https://github.com/semics-tech/remote-sql-agent).

Runs next to a SQL Server instance, mirrors its SQL Server Agent jobs to a
central control plane over an **outbound-only** connection, and applies approved
changes back. It opens no listening port, so no inbound firewall rule is needed
on the SQL host.

**SQL Agent remains the execution engine.** The worker never runs a job itself —
it reads `msdb` and calls the documented Agent stored procedures, the same ones
SSMS calls. Stop the worker and every job keeps running.

> On Windows, prefer the packaged installer from the
> [releases page](https://github.com/semics-tech/remote-sql-agent/releases): it
> registers a service, locks down file permissions and handles enrolment. This
> npm package is aimed at SQL Server on Linux.

## Install

```bash
npm install -g @remote-sql-agent/worker
```

Requires Node.js 24 or newer. The Windows package ships a pinned runtime, so this only applies if you run the bundle yourself.

For Azure managed identity authentication, also install the optional peer:

```bash
npm install -g @azure/identity
```

## Use

Generate a single-use enrolment token in the dashboard
(**Administration → Workers**), write a config, then enrol once:

```bash
rsagent enrol --token rsen_xxxxxxxxxxxx /etc/rsagent/worker.yaml
rsagent /etc/rsagent/worker.yaml
```

Minimal `worker.yaml`:

```yaml
hostName: sqlprod01

controlPlane:
  address: rsagent.corp.example.com:8443
  auth:
    mode: token                       # token | mtls | entra
    keyFile: /var/lib/rsagent/worker.key
  tls:
    enabled: true
    caCertPath: /etc/rsagent/ca.pem   # if your CA is private

# The local ceiling. The control plane can grant less than this, never more.
maxCapability: readOnly               # readOnly | operate | schedule | full

instances:
  - name: MSSQLSERVER
    server: localhost
    user: rsagent_worker
    password: ${RSAGENT_SQL_PASSWORD}
```

Run it under systemd in production — a unit file ships in the release zip.

## SQL Server permissions

Read-only mirroring needs one role:

```sql
USE [msdb];
CREATE USER [rsagent_worker] FOR LOGIN [rsagent_worker];
ALTER ROLE [SQLAgentReaderRole] ADD MEMBER [rsagent_worker];
```

Add `SQLAgentOperatorRole` only if the worker should make changes. **Never grant
`sysadmin`.**

## The capability ceiling

`maxCapability` is the security-critical setting. It is a ceiling the control
plane **cannot raise** — the worker computes its effective capabilities from
this file on every session and never trusts the server's arithmetic.

A worker pinned to `readOnly` cannot be made to write even if the control plane
is fully compromised. Leave it there unless this host genuinely needs to accept
changes.

## Documentation

- [Quick start](https://github.com/semics-tech/remote-sql-agent/blob/main/docs/quick-start.md)
- [Capabilities](https://github.com/semics-tech/remote-sql-agent/blob/main/docs/capabilities.md)
- [Authentication](https://github.com/semics-tech/remote-sql-agent/blob/main/docs/authentication.md)

## Licence

[Apache 2.0](https://github.com/semics-tech/remote-sql-agent/blob/main/LICENSE)
