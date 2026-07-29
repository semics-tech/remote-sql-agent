# Quick start

From nothing to one SQL Server instance visible in the dashboard. Budget 30
minutes, most of which is waiting for containers.

You need a Linux host with Docker for the control plane, and one Windows SQL
Server host to put a worker on.

---

## 1. Control plane

```bash
git clone https://github.com/semics/remote-sql-agent
cd remote-sql-agent/deploy
cp .env.example .env
```

Edit `.env`. Two values must be right before anything works:

```bash
RSAGENT_PUBLIC_URL=https://rsagent.corp.example.com   # how browsers and workers reach this host
POSTGRES_PASSWORD=<something long and random>
```

### TLS for the worker hub

Workers authenticate with a bearer API key by default, so the hub **requires**
TLS — the control plane refuses to start without it. Put a certificate and key
for `RSAGENT_PUBLIC_URL`'s host name in `deploy/tls/`:

```
deploy/tls/server.crt
deploy/tls/server.key
```

Use your internal CA, or a public one. If you use a private CA, keep a copy of
its certificate: workers need it (`-CaCertPath` at install).

For a lab on a trusted network you can skip TLS by adding
`RSAGENT_GRPC_REQUIRE_TLS=false` — worker keys then travel in clear text, so do
not do this anywhere real.

### Start it

```bash
docker compose up -d
docker compose logs -f server
```

On first boot the control plane creates an administrator and prints its
generated password **once**:

```
Created the bootstrap administrator.
  username: admin
  password: TfzAzSKAHzTlDYqwWAGzxzfw
```

Copy it now — it is not recoverable. Sign in at `RSAGENT_PUBLIC_URL` and change
it.

> Prefer Microsoft Entra sign-in? Set it up now rather than later — see
> [authentication.md](authentication.md) §1. Keep `RSAGENT_AUTH_MODE=both` so a
> local administrator still works if Entra is unreachable.

---

## 2. Prepare the SQL Server login

The worker needs far less than people expect. On each SQL Server instance:

```sql
USE [master];
CREATE LOGIN [CORP\SQLAGENT-SVC] FROM WINDOWS;   -- or a SQL login

USE [msdb];
CREATE USER [CORP\SQLAGENT-SVC] FOR LOGIN [CORP\SQLAGENT-SVC];
ALTER ROLE [SQLAgentReaderRole] ADD MEMBER [CORP\SQLAGENT-SVC];
```

That covers everything the worker reads: jobs, steps, schedules, operators,
alerts, run history and activity.

Add write capability **only when you actually want it**:

```sql
ALTER ROLE [SQLAgentOperatorRole] ADD MEMBER [CORP\SQLAGENT-SVC];
```

Never grant `sysadmin`.

If you install the worker service as LocalSystem (the default), the SQL
principal is the machine account and there is no stored credential at all.

---

## 3. Add the worker

In the dashboard: **Estate → Add a worker**.

Give it the SQL host's computer name and choose what it may do. **Read only is
the right way to start** — estate visibility, run history, versioning and
cross-estate search all work without any write capability.

You get a one-line command to run on the SQL Server host. The token in it is
single-use, expires within the hour, and is bound to that host name, so it
cannot enrol anything else.

---

## 4. Run it on the SQL Server host

**Windows**, from an elevated PowerShell:

```powershell
iwr https://rsagent.corp.example.com/install.ps1 -UseBasicParsing | iex
Install-RsAgentWorker -ControlPlane 'rsagent.corp.example.com:8443' -Token 'rsen_xxxxxxxxxxxx'
```

**Linux**, as root:

```bash
curl -fsSL https://rsagent.corp.example.com/install.sh | sudo bash -s -- \
     --control-plane rsagent.corp.example.com:8443 --token rsen_xxxxxxxxxxxx
```

Both install a service, enrol, and connect. The package comes from the control
plane rather than the internet, because a SQL host in a segmented network can
always reach the control plane — it is about to connect to it — and usually
cannot reach GitHub.

If your CA is private, add `-CaCertPath C:\certs\corp-ca.pem` or
`--ca-cert /etc/ssl/corp-ca.pem`.

The installer asks for **no SQL credentials**. The worker connects and waits.

---

## 5. Tell it which instances to monitor

The worker appears under **Estate → Add a worker → Waiting to be told what to
monitor** within a few seconds. Add each SQL Server instance on the host:

| Field | Usually |
|---|---|
| Instance name | `MSSQLSERVER`, or the named instance |
| Address | `localhost` — the worker connects locally |
| Authentication | **Windows — the worker's service account** |

**Prefer Windows authentication.** The service account is the credential, and
there is no password stored anywhere. Grant it `SQLAgentReaderRole` in `msdb`
as in step 2.

If you must use a SQL login, the password you type is **encrypted in your
browser** to a public key that worker generated on its own host. The control
plane stores ciphertext it has no key for and relays it; only that host can
open it. This needs the dashboard to be served over HTTPS — `crypto.subtle` is
unavailable otherwise, and the field is disabled with an explanation rather
than quietly sending the password in clear. See
[security.md](security.md#sql-credentials-the-control-plane-is-a-courier-not-a-keyholder).

One worker handles every instance on its host.

---

## 6. Check it worked

The instance should appear in the estate view within a minute, with its jobs,
run history and schedules.

If it does not, look at `C:\Program Files\RemoteSqlAgent\rsagent-worker.out.log`.
The common causes all name themselves clearly:

| Log says | Cause |
|---|---|
| `No worker key found` | Enrolment did not complete. Generate a new token and re-run the installer. |
| `The control plane rejected this worker credential` | The key was revoked, or the worker was deleted in the dashboard. |
| `Failed to connect to instance` | The SQL login is missing or lacks `SQLAgentReaderRole`. |
| Instance shows **Login refused** | Wrong password, or the login is disabled. Edit the instance and enter it again. |
| Instance shows **Credential unreadable** | The worker was reinstalled and generated a new key. Enter the password again. |
| `Agent error log is not readable` | Expected and harmless. See the FAQ. |

---

## 7. Turn on writes, when you are ready

Read-only is genuinely useful on its own — estate visibility, run history,
drift detection and cross-estate search all work without any write capability.

When you do want to make changes:

1. **Administration → Workers → Manage →** tick the capabilities the host
   should accept (`job.toggle`, `job.run`, `schedule.write`, `job.write`).
   Anything the host's own ceiling blocks is shown as blocked there.
2. On the SQL host, raise the ceiling in
   `C:\Program Files\RemoteSqlAgent\worker.yaml`:

   ```yaml
   maxCapability: operate   # readOnly | operate | schedule | full
   ```

3. Restart the service: `Restart-Service rsagent-worker`.

**Both are required.** The effective capability is the smaller of the two, and
the worker computes it from its own config — so a compromised control plane
cannot raise it. See [capabilities.md](capabilities.md).

---

## What next

- [capabilities.md](capabilities.md) — what each capability permits, and how to choose
- [authentication.md](authentication.md) — Entra sign-in, worker auth modes, audit export
- [security.md](security.md) — what is enforced, and the deployment checklist
- [faq.md](faq.md) — including "does this replace SQL Agent?" (no)
