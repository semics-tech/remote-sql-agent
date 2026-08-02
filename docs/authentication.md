# Authentication and audit

Two separate identity problems, solved separately:

- **Who is using the dashboard** — local accounts and/or Microsoft Entra ID.
- **Which worker is connecting** — an API key, a client certificate, or an Azure managed identity.

They share nothing but the audit log. A compromise of one does not imply the other.

---

## 1. Dashboard sign-in

Set `RSAGENT_AUTH_MODE` to `local`, `entra`, or `both`.

`both` is worth considering even for an Entra-first deployment: it keeps a local break-glass
administrator usable when the IdP, the network path to it, or the app registration is broken. If you
choose `entra` alone, make sure you have another way back in.

### Local accounts

```bash
RSAGENT_AUTH_MODE=local
RSAGENT_BOOTSTRAP_ADMIN=admin
RSAGENT_BOOTSTRAP_ADMIN_PASSWORD=<optional>
```

On first boot, if the database has no users, one administrator is created. If you do not supply a
password, a random one is generated and printed **once** to the log:

```
Created the bootstrap administrator.
  username: admin
  password: TfzAzSKAHzTlDYqwWAGzxzfw
```

There is deliberately no fixed default password. Passwords are hashed with argon2id at the OWASP
recommended parameters.

### Microsoft Entra ID

**1. Register the application** in Entra (Azure portal → Microsoft Entra ID → App registrations →
New registration).

- Redirect URI, type *Web*: `https://rsagent.example.com/api/auth/entra/callback`
- Note the **Application (client) ID** and **Directory (tenant) ID**.
- Certificates & secrets → New client secret. Note the value.

**2. Define app roles.** App registration → App roles → Create. Add four, each with *Allowed member
types: Users/Groups*:

| Display name | Value | Dashboard role |
|---|---|---|
| Viewer | `rsagent.viewer` | Read the estate, jobs, history, versions |
| Operator | `rsagent.operator` | + enable/disable and start/stop jobs |
| Editor | `rsagent.editor` | + edit schedules and jobs (subject to approval) |
| Admin | `rsagent.admin` | + workers, capabilities, users, audit |

**3. Assign users or groups** to those roles: Enterprise applications → your app → Users and groups.
Assigning a *group* is usually what you want — membership is then managed in Entra alone.

**4. Configure the control plane:**

```bash
RSAGENT_AUTH_MODE=both
RSAGENT_PUBLIC_URL=https://rsagent.example.com
RSAGENT_ENTRA_TENANT_ID=<directory-tenant-id>
RSAGENT_ENTRA_CLIENT_ID=<application-client-id>
RSAGENT_ENTRA_CLIENT_SECRET=<client-secret>
```

`RSAGENT_PUBLIC_URL` must match the registered redirect URI's origin exactly — it is used to build
the redirect and to decide whether session cookies may be marked `Secure`.

**What happens on sign-in.** The authorisation code flow runs with PKCE; the `id_token` is validated
against the tenant's JWKS with issuer, audience and nonce checks. The user is matched on the `oid`
claim — never on username or email, both of which can be reassigned to a different person in Entra.
The role is re-derived from app roles on **every** sign-in, so revoking a role in Entra takes effect
at the user's next sign-in without any change here.

**A user with no mapped app role is refused**, rather than silently admitted as a Viewer. To change
that, set `RSAGENT_ENTRA_DEFAULT_ROLE=Viewer` — but understand that this grants every account in the
tenant read access to every job definition in the estate, which routinely contain connection strings.

Custom role names:

```bash
RSAGENT_ENTRA_APP_ROLE_MAP="dba.lead:Admin,dba.oncall:Operator"
```

Roles set from Entra cannot be edited in the dashboard; the API rejects the attempt rather than
letting the change silently revert at the user's next sign-in.

### What Entra gives you for free

Entra's own **sign-in logs** record every authentication against this application: who, when, from
where, MFA state, conditional access outcome. No configuration on our side.

Entra does **not** and cannot record application events — "user X edited job Y on SQLPROD03" will
never appear in an Entra audit log, because Entra has no ingestion path for third-party application
events. That trail lives in this product's own audit log; see §3 for exporting it.

### Session handling

Sessions are server-side. The cookie carries an opaque random token and the database stores only its
SHA-256, so a database compromise does not hand over live sessions and an administrator can revoke a
session immediately — neither of which is true of a self-contained JWT. Cookies are `HttpOnly`,
`SameSite=Lax`, and `Secure` whenever `RSAGENT_PUBLIC_URL` is https. Mutating requests additionally
require a double-submit CSRF token.

---

## 2. Worker authentication

### Which one to use

| Your SQL hosts | Use | Setup | Ongoing work |
|---|---|---|---|
| Azure VMs, VMSS, or Arc-enabled | **`entra`** | Enrol, plus two control-plane env vars | None. No credential exists on the host |
| Anything else | **`mtls`** | Enrol. That is all | None. The certificate renews itself |
| Development, or a stopgap | `token` | Enrol | Rotate the key yourself |

`mtls` is the default the installers write, and it needs no PKI of your own: the control plane runs
its own small CA, created automatically the first time it is needed. `entra` is better still where
it works, because there is nothing on the host to steal. `token` is the weakest of the three and the
control plane says so at startup if a real deployment is still using it.

Set which modes the hub accepts:

```bash
RSAGENT_WORKER_AUTH_MODES=mtls           # recommended
RSAGENT_WORKER_AUTH_MODES=mtls,token     # e.g. during a migration
```

The hub accepts **any** listed mode from **any** worker, so the estate is only as strong as the
weakest entry. Migrating every worker to `mtls` buys nothing until `token` comes off this list.

### The enrolment flow, shared by all three

An administrator mints a single-use, host-bound token (dashboard → Administration → Workers, or
`POST /api/enrolment-tokens`); the installer passes it to the worker once; the worker exchanges it
for a durable credential.

```bash
rsagent enrol --token rsen_... /etc/rsagent/worker.yaml
```

The enrolment token expires in an hour by default, is bound to a host name, and is consumed inside
the same transaction that creates the credential — two installers racing with the same token cannot
both succeed.

**The auth mode is chosen when the token is minted, and `worker.yaml` must agree.** The install
command shown in the dashboard already carries the matching `--auth-mode` / `-AuthMode`; if the two
disagree, enrolment fails with a message saying so rather than half-configuring the host.

### mtls — client certificates (default)

```yaml
controlPlane:
  address: rsagent.example.com:8443
  auth:
    mode: mtls
  tls:
    enabled: true
    clientCertPath: /var/lib/rsagent/worker.crt
    clientKeyPath:  /var/lib/rsagent/worker.key
    caCertPath:     /var/lib/rsagent/ca.crt
```

Nothing else to set up. The installer writes those paths, `rsagent enrol` fills them, and there is
no certificate authority to stand up: `RSAGENT_WORKER_AUTH_MODES=mtls` is the whole server-side
configuration.

The worker generates its keypair locally and sends only a CSR, so the private key never leaves the
host. The control plane's embedded CA issues the certificate.

**Renewal is automatic.** The worker re-requests a certificate at half its lifetime, over the session
its current certificate already authenticated — the same pattern kubelet and EST `simplereenroll`
(RFC 7030) use. Nothing needs to be scheduled, and no second credential exists for the purpose:

- The new certificate is issued while the old one is still valid, and the worker reconnects
  immediately to prove the new one works while there is still time to intervene.
- Failures are retried hourly against roughly 45 days of runway, so a control plane that is down for
  a weekend costs nothing.
- Superseded certificates are revoked automatically; only the current and previous ones stay live.
- Every renewal writes an audit row (`worker.certificate.renewed`).

Tune the lifetime with `RSAGENT_WORKER_CERT_VALIDITY_DAYS` (default 90). Shorter is fine now that
renewal is automatic.

Identity is bound to the certificate's **SHA-256 fingerprint**, recorded at issuance — not to its CN
or SAN, neither of which is evaluated at authentication. Renaming a host or changing its DNS does
not break authentication, and a worker cannot name itself into another worker's identity: the CSR's
subject is discarded and the issued certificate is named from the enrolled worker id.

Revocation is checked against the database on every connection rather than via a published CRL, so
revoking takes effect on the next connection instead of at the next CRL refresh.

**A worker offline past its expiry cannot recover on its own** and must be re-enrolled with a fresh
token. That is deliberate — recovering automatically would need a second standing credential whose
only purpose is to be valid after the first one stopped being.

### entra — Azure managed identity

```yaml
auth:
  mode: entra
  audience: api://rsagent-control-plane
```

```bash
RSAGENT_WORKER_AUTH_MODES=entra
RSAGENT_WORKER_ENTRA_TENANT_ID=<tenant-id>
RSAGENT_WORKER_ENTRA_AUDIENCE=api://rsagent-control-plane
```

No secret is stored on the SQL host at all: the worker asks the Azure instance metadata service for a
short-lived token on every connection. Nothing to rotate, nothing to leak from disk, no expiry to
chase. Best option when your SQL hosts are Azure VMs, VM Scale Sets, or Arc-enabled servers.

The trade is a runtime dependency: if Entra or the instance metadata service is unreachable, the
worker cannot establish a session, where a certificate or key on disk would have kept working. The
installers detect an available managed identity and say so, but never select this mode for you —
the same command should not mean different things on different hosts.

A valid Entra token proves the caller is *a* principal in your tenant, not that it is a worker you
know — so the identity's object id is pinned at enrolment and an unpinned identity is refused.

### token — an API key

```yaml
controlPlane:
  address: rsagent.example.com:8443
  auth:
    mode: token
    keyFile: C:\ProgramData\rsagent\worker.key
```

Works anywhere, including hosts that can reach neither Azure nor a certificate of their own. The key
is stored only as an argon2id hash on the control plane and is shown exactly once; it can be rotated
and revoked from the dashboard. Rotation issues a new key while leaving the old one valid until you
explicitly revoke it, so a rotation cannot lock out a worker that has not picked up the new key yet.

**This is a bearer secret: it requires TLS.** Anyone who can read it can impersonate that worker
until it is revoked — including anything that terminates TLS between the worker and the hub, which
comes away with a credential it can replay from anywhere. That is the concrete reason to prefer the
other two: a client certificate and a managed identity both prove possession of a key that never
crosses the wire.

Set `RSAGENT_WORKER_TOKEN_TTL_DAYS` to expire keys, but note that rotation is operator-initiated —
unlike mTLS, nothing renews them for you.

**The control plane warns at startup** when a real deployment still has workers on API keys. It
decides "real" from whether hub TLS is required and whether `RSAGENT_PUBLIC_URL` is a non-local
host, not from `NODE_ENV` — a security warning that switches itself off when an environment variable
is missing is not one you can rely on.

### Hub TLS

```bash
RSAGENT_GRPC_TLS_CERT=/etc/rsagent/tls/server.crt
RSAGENT_GRPC_TLS_KEY=/etc/rsagent/tls/server.key
RSAGENT_GRPC_TLS_CLIENT_CA=/etc/rsagent/tls/ca.crt   # mtls mode only; defaults to the embedded CA
```

Client certificates are *requested* but not *required* at the TLS layer even in mTLS mode, because
enrolment legitimately arrives without one. Requiring a credential is the application's job, where it
can tell enrolment and session apart.

---

## 3. Audit export

Every authentication, every administrative change and every worker session event is written to the
`audit_log` table. **The database is the source of truth and always receives the event.** There is no
update or delete path in the audit module.

Export to an external system is optional, asynchronous and queued: the event is enqueued in the same
transaction that records it, and delivered by a background worker with retry and backoff. A collector
outage degrades to "the SIEM is behind", never to "the request failed" or "the event is gone". If an
event exhausts its retry budget it is dropped from the *export queue* only, with a loud error — it
remains in the database, so the gap is discoverable.

Export speaks **OTLP** (OpenTelemetry logs over HTTP), so the destination is your choice:

```bash
RSAGENT_AUDIT_OTLP_ENABLED=true
RSAGENT_AUDIT_OTLP_ENDPOINT=http://otel-collector:4318/v1/logs
RSAGENT_AUDIT_OTLP_HEADERS="x-api-key=..."      # optional
OTEL_SERVICE_NAME=remote-sql-agent
```

Each event carries `event.name` (the action), `rsagent.actor`, `rsagent.actor_type`,
`rsagent.target`, `client.address`, and `rsagent.detail` (JSON). Failed sign-ins, rejected worker
credentials and failed commands are emitted at `WARN`; everything else at `INFO`.

### Common destinations

The usual shape is to run an OpenTelemetry Collector next to the control plane and let it fan out.
Point the control plane at the collector, then configure the collector's exporter:

**Azure Monitor / Log Analytics**

```yaml
exporters:
  azuremonitor:
    connection_string: ${APPLICATIONINSIGHTS_CONNECTION_STRING}
service:
  pipelines:
    logs: { receivers: [otlp], exporters: [azuremonitor] }
```

Events land in the `AppTraces` table and are queryable in KQL:

```kql
AppTraces
| where Properties["event.name"] startswith "command."
| project TimeGenerated, Properties["rsagent.actor"], Properties["event.name"], Properties["rsagent.target"]
```

**Splunk** — `splunk_hec` exporter, or point the endpoint directly at HEC with a
`Authorization=Splunk <token>` header.

**Datadog** — `datadog` exporter with `api::key`, or send OTLP directly to
`https://http-intake.logs.datadoghq.com/api/v2/logs` with `DD-API-KEY`.

**Elastic** — OTLP is accepted natively by Elastic APM Server; set the endpoint and an
`Authorization=ApiKey <key>` header, no collector needed.

**Grafana Loki** — `loki` exporter in the collector, or Grafana Cloud's OTLP endpoint with basic auth.

**Anything else** — if it speaks OTLP you can point at it directly; if it does not, the collector
almost certainly has an exporter for it.

### Retention

Audit rows are never pruned by the retention job — only `job_history` and `agent_log_entries` are.
If you need to age out audit data, export it first and remove it deliberately.
