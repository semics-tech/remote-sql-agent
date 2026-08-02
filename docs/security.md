# Security guide

This document states what the product currently enforces, and — just as importantly — what it does
not yet enforce. Read the "Current status" table before deploying anything.

## Current status

The build in this repository implements milestones M0–M3 of the architecture spec.

| Control | Spec | Status |
|---|---|---|
| Outbound-only worker connections | §3.2.1 | **Implemented.** No worker component opens a listening socket. |
| Read-only by default | §6.1.1 | **Implemented.** No write command is applied by the worker in this build. |
| Worker-local capability ceiling | §6.3 | **Implemented and tested**, including end to end: an enrolment granting `job.toggle` still resolves to `observe` for a worker pinned `readOnly`. |
| Closed command vocabulary | §6.1.5 | **Implemented** as a protobuf enum. No "run arbitrary T-SQL" command exists. |
| Command signing + replay window | §6.4 | **Implemented in the contracts package**, not yet exercised (no write path). |
| Append-only audit log | §6.1.4 | **Implemented** for authentication, administration and worker session events. No update or delete path exists. |
| Audit export to a SIEM | backlog | **Implemented** via OTLP, queued with retry. See `authentication.md` §3. |
| Parameterised SQL everywhere | §5.2 | **Implemented**, enforced by review and partially by an eslint rule — see "SQL injection" below for what the rule does and does not catch. |
| Worker authentication | §6.2 | **Implemented**: enrolment tokens plus API key, mTLS, or Entra workload identity. |
| Embedded CA, cert issuance/revocation | §6.2 | **Implemented** for mTLS mode. Revocation checked per connection. |
| TLS on the worker hub | §6.2 | **Implemented**; the control plane refuses to start without it unless explicitly overridden. |
| Dashboard authentication | §6.5 | **Implemented**: local argon2id accounts and/or Entra OIDC with app-role mapping. |
| Server-side RBAC on every route | §6.5 | **Implemented.** Every route declares a permission; there is no unguarded data route. |
| Environment-scoped write permissions | §6.5 | **Implemented.** Grants add a role within one environment tag. Additive only — see below. |
| CSRF protection | §6.5 | **Implemented** (double-submit token bound to the session). |
| Automatic certificate rotation at 2/3 lifetime | §6.2 | **Not implemented.** Rotation is manual. |
| Approval workflow | §6.4 | **Not implemented.** M4, along with the write path. |
| SBOM generation and container image scanning | backlog | **Not implemented.** `pnpm audit --audit-level high` runs in CI on every PR and `minimumReleaseAge` (`pnpm-workspace.yaml`) delays resolving a package until it has survived 3 days in the registry, but neither produces a queryable software bill of materials or scans the published `control-plane` image's OS-level packages (the base image's own `apt` layer, not just the Node dependency tree). Adding this is a tool choice — Trivy, Grype and Syft-plus-a-registry-scanner all fit the "no data ever leaves the estate except what the audit log already exports" constraint differently — and is being left as a deliberate follow-up rather than picked here. |

> **Still not production-ready.** The write path (M4) and packaging (M5) do not exist, and
> certificate auto-rotation is manual. But the control plane is no longer open: it requires
> authentication for every data route, and workers must present an enrolled credential.

### Deployment checklist

- [ ] `RSAGENT_PUBLIC_URL` set to the real https origin (this also makes session cookies `Secure`)
- [ ] `RSAGENT_GRPC_TLS_CERT` / `RSAGENT_GRPC_TLS_KEY` set — never run the hub without TLS
- [ ] `RSAGENT_TRUSTED_PROXY_HOPS` set to the number of reverse proxies actually in front of
      the HTTP port — 0 if none. Too high and the client picks its own address, which forges
      `remoteAddress` on every audit row and sidesteps rate limiting
- [ ] Bootstrap admin password changed, or Entra configured
- [ ] Each worker's `maxCapability` set to the minimum that site needs (default `readOnly`)
- [ ] Postgres on an encrypted volume, and backups encrypted
- [ ] Audit export configured to a system outside this host

## Environment grants: what they do, and what they deliberately do not

Every user has a **base role** that applies to the whole estate. An
**environment grant** adds a role on top of it for instances carrying one
environment tag. The shape most estates want is a base role of `Viewer` plus a
grant of `Editor` on `production` to whoever runs production: reads every
server, writes one environment.

Grants are stored in `environment_grants` and administered under
**Administration → Access**.

### Grants add. They never subtract.

There is no expressible grant that removes access, so no combination of rows in
that table can leave anybody with less than their base role. Two consequences
follow, and both are load-bearing:

- **Nothing here hides anything.** Read routes are not environment-scoped at
  all. If a user can list instances, they can list every instance; if they can
  read a job, they can read every job, including its step bodies and its run
  history. An administrator who believes these rows keep production *invisible*
  to the rest of the organisation has drawn the wrong conclusion. Use separate
  control planes if you need that.
- **The worst case of a mistake in this table is over-permission in one
  environment, never an outage.** That is a deliberate trade: over-permission is
  visible in the audit trail, and an estate that has locked itself out of its
  own SQL Servers at 02:00 is not.

Adding a subtractive dimension later is not a small change. It would mean
auditing every read path in the product for leaks — cross-estate search, the
job list, notification payloads, `/metrics`, and the audit log itself — which is
a different piece of work with a different risk profile.

### An untagged instance is reachable by base role only

A grant for `production` does **not** apply to an instance with no environment
tag. An instance enrolled before anybody set up tagging, or one where the tag
was mistyped, must not silently inherit production's write permissions.

The cost is that tagging is load-bearing: an untagged instance is writable only
by whoever already holds the role estate-wide. The Access screen lists untagged
instances for exactly this reason — from the operator's side, "my grant does
nothing here" is indistinguishable from a permissions bug. Use the environment
tag `*` for a grant that should reach everything, including untagged instances.

Tags are matched **ignoring case** and surrounding whitespace, so `Production`
on the instance satisfies a grant written for `production`. Both sides are
normalised on the way in as well as on comparison, so a tag cannot exist twice
in two casings.

An instance carries the tag of the **configuration that created it**
(`worker_instance_configs`), which is what the dashboard writes when an
administrator tags it. An instance that came from a worker's own `worker.yaml`
has no configuration row and is therefore untagged — reachable by base role
only, per the rule above. There is deliberately no second copy of the tag on
`instances`: the first version of this feature had one, nothing wrote to it, and
the guard read `NULL` for every instance in the estate.

### Estate-wide permissions are never conferred by a grant

`user.admin`, `worker.admin` and `audit.read` sit behind routes that consult the
base role only. An `Admin` grant on `production` does not become the ability to
create users, enrol workers or write more grants — a grant that could grant
would be self-extending. The primary separation is which guard each route uses
(`requirePermission` versus `requireInstancePermission` in
`packages/server/src/auth/rbac.ts`), and there is a test that fails if an
`Admin` grant on `*` ever reaches an estate-wide route.

That is reinforced at the resolver itself: `canInEnvironment` and
`permissionsInEnvironment` (`packages/server/src/auth/environments.ts`) refuse
these three permissions from a grant regardless of which guard calls them, so
the invariant does not depend solely on every future route being wired
correctly. `command.approve` is the deliberate exception — a grant *can* raise
someone to it, so an Editor scoped to production can be approved by someone
whose own privilege is also scoped to production, with neither holding
estate-wide Admin.

### Group membership is a snapshot taken at sign-in

For Entra users, the `groups` and `roles` claims are captured on each sign-in and
stored on the user row. Removing somebody from a group in Entra therefore takes
effect at their next sign-in, or when their session expires — whichever comes
first. That bound is the session TTL, and it is the same bound the base role
already has. To revoke immediately, disable the user or delete the grant; both
take effect on the next request.

**The groups overage claim.** Past roughly 200 group memberships, Entra stops
listing `groups` in the token and emits a `_claim_names` / `_claim_sources` pair
pointing at Microsoft Graph instead. This product does not follow that link:
doing so needs a Graph permission, a second network call on the sign-in path,
and a failure mode where signing in depends on Graph being reachable. Such a
user gets *fewer* grants than intended — the safe direction — and the condition
is recorded on the user row so it can be reported rather than guessed at.

For Entra to emit `groups` at all, the app registration needs
`groupMembershipClaims` configured. Grants are keyed on the group **object id**,
not its display name: a display name can be changed in Entra and then reused by
a different group, and a grant keyed on one would follow the name.

## What a worker can and cannot do

A worker's effective capability is the **intersection** of two independently controlled sets:

1. the server-side grant on the `workers` row, editable by a control-plane admin, and
2. the `maxCapability` tier in the worker's own `worker.yaml`, on the SQL Server host.

The intersection is computed by the worker itself, from its own config, on every session. The
control plane's arithmetic is advisory and is never trusted. A site that pins `maxCapability:
readOnly` has a worker that cannot be made to write **even if the control plane is fully
compromised**, short of an attacker who can also edit files on the SQL Server host — at which point
they did not need the worker.

Unknown capability strings sent by the server are dropped rather than passed through, so a newer
control plane cannot smuggle a capability past an older worker that does not understand it.

## SQL Server privileges

The worker's login needs far less than DBAs often expect. Grant the minimum:

```sql
USE [msdb];
CREATE USER [rsagent_worker] FOR LOGIN [rsagent_worker];
ALTER ROLE [SQLAgentReaderRole] ADD MEMBER [rsagent_worker];
-- The role grants EXECUTE on sp_help_*, not SELECT on the tables the worker
-- reads directly. Both are needed; see deploy/sql/worker-permissions.sql.
```

That covers the whole read path: job definitions, steps, schedules, operators, alerts, run history
and activity.

**The Agent error log is the exception.** `xp_readerrorlog` requires `securityadmin` or `sysadmin`,
which a least-privileged worker will not have. Rather than demand those rights, the worker detects
the permission error, logs a warning, and permanently disables log streaming for that instance. The
dashboard explains the absence in the Error Log tab. This is a deliberate trade: an optional feature
is dropped instead of escalating the blast radius of a compromised worker login.

Never grant the worker `sysadmin`. A future build will warn loudly if it detects that it has it.

## Handling of sensitive job content

Job step bodies routinely contain connection strings, credentials and other secrets.

**Implemented:** step bodies and canonical definitions are excluded from all structured logs, on
both the worker and the control plane, by explicit pino redaction paths. They are never written to
disk by the worker other than as SHA-256 hashes in the outbox.

**Resolved deviation from §6.6 — definitions are deliberately not encrypted at rest.** The spec
originally called for app-level AES-GCM encryption of job definitions. That conflicts directly with
§9.5, which wants cross-estate search over step-body text and calls it a killer feature: encrypted
blobs cannot be searched by the database, and decrypting every definition in the application on
every search neither scales nor keeps the plaintext out of memory.

**Decision: keep definitions as searchable `jsonb`.** Cross-estate search is load-bearing for the
product and encryption at rest is delegated to the platform. Deploy accordingly:

- enable Postgres transparent disk encryption, or run the data directory on an encrypted volume;
- restrict direct database access to the control-plane service account;
- treat a Postgres backup as containing credentials, and encrypt backups.

Redaction rules in the UI (regex masking of `Password=…` and similar) remain worth adding and are
tracked separately — they protect against shoulder-surfing and over-broad dashboard access, which is
a different threat from at-rest compromise.

## SQL credentials: the control plane is a courier, not a keyholder

When an administrator configures a worker's instances from the dashboard, they may supply a SQL
Server login and password. That password is **encrypted in the operator's browser** to a public key
the target worker generated on its own SQL host at enrolment. The control plane receives base64
ciphertext, stores it in `worker_instance_configs.credential_ciphertext`, and relays it — it holds
no key that can open it.

**Why not just store them centrally and decrypt on demand?** Because that would put working logins
for every instance in the estate inside the single component that every network segment can reach by
design. A control plane breach would hand an attacker fifty SQL Servers. This architecture exists
specifically to avoid concentrating that kind of power in the reachable component, and a credential
store would give it all back.

The mechanics:

| Where | What exists there |
| --- | --- |
| Browser | The plaintext, for as long as the form is open. Encrypted before submit, then discarded. |
| Control plane / Postgres | RSA-OAEP-SHA256 ciphertext and the fingerprint of the key it was encrypted to. No private key. |
| Worker host | The RSA private key, `0600`, at `credentialKeyFile`. Generated locally; never transmitted. |
| Worker memory | The decrypted password, while a connection pool is open. Never written to disk. |

Consequences worth being explicit about:

- **A host compromise still yields that host's credential.** Anything able to read the worker's
  private key can read its SQL password. This is unavoidable — a worker has to be able to log in —
  and it is why **integrated authentication is the default the installer offers**: with a Windows
  service account or gMSA there is no password anywhere.
- **The dashboard must be served over HTTPS.** `crypto.subtle` is unavailable in an insecure
  context, so on plain HTTP the credential field is disabled with an explanation rather than
  silently falling back to sending the password in clear.
- **A re-keyed worker invalidates stored ciphertext.** If a worker is reinstalled it generates a new
  key; the control plane notices the fingerprint change on the next `Hello`, marks affected configs
  `awaiting_credentials`, and the dashboard asks for the password again. It does not present this as
  a bad password, because it is not one.
- **Ciphertext is never returned by the API.** `GET /api/workers/:id/instance-configs` reports
  `hasCredential: true` and nothing more.

Notification channel secrets — Slack and Teams webhook URLs, SMTP passwords — are different: the
control plane is the party that uses them, so it necessarily holds them in usable form. They are
never returned by the API, only a `secretHint` (`hooks.slack.com/…/T0A9`) that is enough to tell two
channels apart and useless to anyone who reads it.

### A webhook is an outbound request the control plane makes on request

Anyone who can configure a channel can make the control plane issue an HTTP POST from inside the
network it sits in, and press **Test** to do it on demand. The threat model treats a malicious
administrator as in scope (§3), so this is bounded rather than trusted:

- **The response body is never returned to the caller.** A failure reports the status code and
  nothing else. Echoing the body made the test button a readable oracle: point a channel anywhere,
  press Test, read the reply out of the error message.
- **Redirects are refused.** A redirect is a second request to a host no check ever saw. No real
  webhook endpoint answers a POST with one.
- **The link-local range is refused** — `169.254.0.0/16`, its IPv4-mapped form, `fe80::/10`, and the
  metadata hostnames cloud providers publish. That is where instance metadata services hand out role
  credentials to anything that asks, and it is never a legitimate webhook target.

RFC1918 addresses are deliberately **allowed**. This product lives inside the firewall, so an
internal relay on a private address is the normal target; blocking those would break the primary use
case and become a setting every estate turns off. The containment that matters is that nothing comes
back — a request that lands somewhere it should not tells the sender nothing.

The limit, stated rather than implied: the check is on the literal host. A *name* that resolves to a
link-local address is not caught, and resolving here would not catch it either, since DNS can answer
differently for the check and for the request.

### SMTP will not send a password in the clear

A channel with a username configured sets `requireTLS`, so a server that does not offer STARTTLS is
a connection failure rather than a cleartext `AUTH`. Without it an active MITM only has to omit the
capability. Unauthenticated relays are exempt: they are normal internally, often have no TLS at all,
and have no credential to protect.

## SQL injection

No SQL statement anywhere in the worker or control plane is built by string concatenation or
template interpolation. Every value is bound as a parameter. This is enforced two ways:

- an eslint rule (`no-restricted-syntax` in `eslint.config.js`) that fails the build when an
  interpolated template literal or a `+` concatenation is passed **directly** as the argument to
  `.query()`, `.batch()` or `.execute()`. It is a syntactic check, not a data-flow one: it does not
  see through a variable, so `const sql = \`SELECT ... ${x}\`; conn.query(sql)` passes the rule while
  building exactly the statement it exists to catch. The direct-argument form is what a reviewer
  would otherwise have to check for by hand, so the rule is worth having — but it narrows the
  reviewer's job rather than replacing it, and
- code review, which is what actually covers the hoisted case above.

The one place that legitimately builds a statement dynamically — creating the test database, where
`CREATE DATABASE` cannot take a parameter — is in test-only code and quotes the identifier.

## Trusting worker-reported data

The control plane recomputes the SHA-256 of every definition it receives rather than trusting the
hash the worker sent. A worker that has been taken over therefore cannot make two different
definitions share a hash in order to hide a change from drift detection. A mismatch is logged and
the locally computed hash wins.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
