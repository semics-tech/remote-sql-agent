# Threat model

Scope: the worker, the control plane, and the channel between them. Per §6, a writable worker is
effectively remote code execution on a database server — job steps can run T-SQL, PowerShell and
CmdExec — so the analysis assumes a capable, motivated attacker.

Status markers: **[now]** mitigated in the current build; **[planned]** tracked as a known gap in
`migration.md`, not yet built. See `security.md` for the overall implementation status — as of this
writing every architecture-spec milestone (M0–M5) is implemented, so nothing below is marked against
a milestone number that has since shipped.

## Assets

1. **The ability to make SQL Agent run something.** The crown jewel. Job steps run as the Agent
   service account or a proxy.
2. **Job definition content.** Step bodies routinely contain connection strings and credentials.
3. **The audit trail.** Its value in an investigation depends entirely on being unforgeable.
4. **Estate topology.** Which servers exist, what they run, when they are idle.

## Trust boundaries

```
   [ SQL Server host ]         │  [ network ]  │   [ control plane host ]      │  [ browser ]
   worker.yaml, private key    │   mTLS        │   Postgres, signing key       │   session
   SQL login ─────────────────►│               │◄──── REST API ────────────────│
                     outbound only ───────────►│
```

The worker never accepts an inbound connection. This is the single most load-bearing property in the
design: it is what makes the product deployable across firewalled segments at all, and no feature may
erode it.

---

## Scenarios

### 1. Control plane fully compromised

*Attacker gains code execution on the control-plane host and can send arbitrary messages to workers.*

- **[now]** Workers enforce their own `maxCapability` ceiling from local config. A worker pinned to
  `readOnly` cannot be made to write. Tested in `packages/protocol/test/capabilities.test.ts`.
- **[now]** The command vocabulary is a closed protobuf enum with no arbitrary-SQL member. The
  attacker's expressiveness is bounded by what the worker version already implements.
- **[now]** Unknown capability strings are dropped by the worker, so a modified control plane cannot
  invent a capability an older worker will honour.
- **[now]** Certificate revocation lets an operator cut a compromised worker off; checked on every new
  connection, not cached from a previous one.
- **Residual risk:** for any worker whose ceiling is above `readOnly`, the attacker can do everything
  that ceiling permits. **Set the ceiling to the minimum the site actually needs — it is the only
  control that survives this scenario.**

### 2. Worker certificate stolen

*Attacker extracts the client certificate and key from a SQL Server host.*

- **[now]** Certificates are short-lived (90 days) and renew themselves at **half** lifetime, over the
  session the current certificate already authenticated — see `packages/worker/src/cert-renewal.ts`.
- **[now]** Revocation is checked on every connection (`packages/server/src/worker-auth/authenticate.ts`).
- **[now]** Enrolment tokens are single-use, one-hour, and bound to a host name, so the certificate
  cannot be re-minted for a different box.
- **Residual risk, specific to renewal:** possession of a working certificate authorises reissuing a
  new one (EST `simplereenroll`/kubelet-style renewal-by-possession), so a stolen certificate can
  renew itself indefinitely rather than expiring the attacker out. That is the accepted trade in every
  comparable system; the bound is the audit row written per renewal
  (`worker.certificate.renewed`) and the per-connection revocation check above, not an expiry the
  legitimate worker would trip over first.
- **Residual risk:** a stolen certificate grants the ability to *impersonate a worker* — to feed
  false job definitions and history upward. It does not grant the ability to send commands. Feeding
  false state upward is still serious: it could hide a malicious job from the estate view.
- **[now]** Partial mitigation: the control plane recomputes definition hashes rather than trusting
  the worker's, so hash collisions cannot be used to hide a change from drift detection.

### 3. Malicious or coerced control-plane administrator

*A legitimate Admin abuses their access.*

- **[now, off by default]** `job.write` and operator writes can require a second approver
  (`RSAGENT_REQUIRE_APPROVAL_JOB_WRITE=true`); the RBAC model deliberately separates authoring
  (`Editor`) from approval (`command.approve`, Admin only), so no single non-Admin role can both
  write and rubber-stamp. Asserted in `capabilities.test.ts`. Off by default because an unconditional
  four-eyes rule is unusable for a single DBA running their own estate — see the decision record in
  `migration.md`.
- **[now]** The audit module has no update or delete path, and none should be added.
- **[now]** Every mutation and session event is attributed to a user.
- **Residual risk:** an Admin with database access can edit `audit_log` directly, and — if the
  approval rule is left off, which is the default — a single Admin can also write and apply a change
  with no second party involved at all. Genuine protection against the former requires shipping the
  audit log off-box (OTLP export is implemented; see `authentication.md` §3). Against the latter,
  turn the approval rule on for any estate where a single actor writing job steps unsupervised is a
  real risk — it is a config value, not something still being built.

### 4. Machine-in-the-middle on the worker channel

- **[now]** The hub refuses to start without a TLS certificate (`RSAGENT_GRPC_TLS_CERT`/`_KEY`), and
  that requirement holds regardless of which worker auth mode is in use. `mtls` mode additionally
  pins the control plane's CA on the worker side (`--ca-cert` / `-CaCertPath`), rejecting anything
  signed by a different authority. Node's TLS stack refuses below TLS 1.2 by default; nothing in this
  codebase lowers that floor.
- **[now]** Per-command signatures are verified against a public key delivered in `HelloAck`,
  independently of the transport.
- **[now]** That key can be **pinned** in `worker.yaml` as
  `controlPlane.commandSigningKeyFingerprint`, and a worker refuses the whole session if what
  arrives does not match.

  The pin is what makes signatures defend against a compromised TLS-terminating proxy — a scenario
  mTLS alone does not cover. **Unpinned, they do not.** A proxy that terminates TLS also supplies
  `HelloAck`, so it substitutes its own signing key and signs its own commands, and the check proves
  only "whoever sent HelloAck also signed these". This document claimed the stronger property
  before the pin existed; it was wrong.

  A worker without a pin logs the fingerprint it received, once per session, so the value is to
  hand and the absence is visible.
- **Residual risk:** the signing-key pin is trust-on-first-configure. It does not help if an attacker
  is positioned before the *first* connection — the fingerprint should be carried to the host by
  whatever channel already carries the enrolment token, not copied later over the same connection
  it is meant to protect. `RSAGENT_GRPC_REQUIRE_TLS=false` exists for a lab on a trusted network and
  removes the TLS layer entirely if set; it is not a supported production configuration and nothing
  in the installers sets it.

### 5. Command replay

*Attacker captures a legitimate command and replays it later.*

- **[now]** Commands carry a UUID and `issued_at`. `isCommandFresh` rejects anything outside a
  15-minute window, with 60s tolerance for clock skew.
- **[now]** The worker records applied command IDs in its SQLite store and no-ops duplicates; the
  record survives restarts.
- **[now]** Signed bytes are length-prefixed, so field boundaries cannot be shifted to lift a
  signature from one command onto another. Tested in `signing.test.ts`.

### 6. Malicious job content reaching the dashboard

*A job step body contains markup or script crafted to attack a DBA's browser.*

- **[now]** All step bodies render as React text nodes or inside a read-only Monaco editor; there is
  no `dangerouslySetInnerHTML` anywhere in the dashboard.
- **[now]** Monaco is bundled locally rather than loaded from a CDN, so the dashboard has no
  third-party script origin at runtime.

### 7. Compromise of the SQL Server host

*Attacker already owns the database server.*

Out of scope, and honestly so: they can run anything SQL Agent can run without involving this
product. The relevant question is only whether the worker widens the blast radius to *other* hosts.
It does not — a worker holds credentials for its own instances only, and its certificate authorises
it to report on those instances, not to command others.

### 8. Supply chain

- **[now]** `pnpm-lock.yaml` is committed; CI installs with `--frozen-lockfile`.
- **[now]** `pnpm audit --audit-level high` runs in CI.
- **[now]** The worker compiles no native code at all: its outbox uses the runtime's built-in
  `node:sqlite`, so the code that runs on a customer's database server is the bundle plus the
  pinned Node runtime and nothing else. `argon2` is the only native module in the tree, and it is
  control-plane only.
- **[now]** Generated protobuf output is checked in and CI fails if it drifts from the `.proto`
  source, so a compromised codegen toolchain cannot silently alter the wire contract.

### 9. Denial of service against the control plane

- **[now]** REST API is rate-limited (600 req/min).
- **[now]** Worker reconnects use jittered exponential backoff, so 50+ workers losing the control
  plane do not reconnect in lockstep and knock it back down. Tested in `backoff.test.ts`.
- **[now]** The worker outbox is bounded with oldest-first eviction, and eviction is logged and
  reported in the heartbeat rather than silent.
- **Residual risk:** no per-worker quota on ingest volume. A compromised worker could flood history.

---

## Assumptions

- The SQL Server host's filesystem is trustworthy: `worker.yaml` and the private key are protected by
  `0600` on Linux, and on Windows by NTFS ACLs the installer sets restricting the install directory to
  Administrators and SYSTEM — **not** DPAPI. DPAPI-wrapping the key at rest is still open; see
  [migration.md](migration.md).
- The control-plane host is patched and access-controlled.
- Operators set `maxCapability` deliberately rather than leaving it at whatever the installer
  defaults to. The default is `readOnly`, and it should stay there unless a site has a concrete
  reason otherwise.
