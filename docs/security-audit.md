# Security audit history

A running record of security audits performed on this repository: what was
found, the PR that fixed it, and the regression test that stops it coming
back. This is the audit log; see [`security.md`](security.md) for the current
architecture and what it enforces, and [`threat-model.md`](threat-model.md)
for the assumptions behind it.

## How to read this

Every row was found by deliberately trying to break an invariant the product
claims to hold, not by static analysis alone. "Fixing PR" links a real merged
(or open, marked as such) pull request; "Regression test" names the specific
test that fails if the bug comes back. A row with no test either predates this
convention or has a documented reason (noted inline) — new findings are
expected to always carry one.

## 2026-08-02 — full-repo audit

Five parallel reviews, one per trust boundary: server auth/session/CSRF,
server domain logic and the worker-hub trust boundary, worker credential
handling and command signing, the dashboard client, and deploy/supply-chain.
Three real, currently-exploitable issues were found; everything else the
reviews specifically targeted was already closed by the 2026-07 round below.

| # | Finding | Severity | Fixing PR | Regression test |
|---|---|---|---|---|
| 1 | `deploy/worker/install.ps1` wrote `worker.yaml` (a plaintext SQL password under `-SqlAuth`) and had `enrol` generate `run\worker.key` (the private key every SQL credential from the control plane is encrypted to) into a directory that inherited Program Files' default ACL, locking it down only *after* each file existed. Any local, non-administrator account could read either file during that window. | High | [#106](https://github.com/semics-tech/remote-sql-agent/pull/106) | None automated — Windows-only script, no Windows CI runner in this repo. Manual verification steps are in the PR description. |
| 2 | The dashboard's T-SQL linter (`unqualifiedWrites` in `lint/tsql.ts`) matched `WHERE` anywhere in the statement text, so `UPDATE T SET x = (SELECT … WHERE …)` — an update with no restriction on `T` at all — read as qualified. A DBA reviewing a job-step diff would see a clean bill of health on a step that silently rewrites every row of a production table. | Medium | [#107](https://github.com/semics-tech/remote-sql-agent/pull/107) | `packages/dashboard/test/lint.test.ts` — "still flags an UPDATE with no outer WHERE even when a subquery has one" and two adjacent cases. |
| 3 | `POST /api/auth/logout` had no `preHandler`, so it was the one mutating route that skipped the CSRF double-submit check every other route enforces via `rbac.ts`'s `authenticate()`. Largely closed by `SameSite=Lax` on current browsers, so treated as hygiene rather than a reported vulnerability. | Low (hygiene) | [#108](https://github.com/semics-tech/remote-sql-agent/pull/108) | `packages/server/test/auth-routes.test.ts` — "logout CSRF" describe block, 4 cases. |

Areas reviewed with no findings meeting the confidence bar: authentication
bypass, session fixation, RBAC/environment-grant bypass, timing side-channels,
open redirect in the Entra callback, SQL injection, cross-worker/cross-instance
data leakage, drift silently overwritten, sensitive data reaching the audit
log or SIEM export, command signature verification and key pinning, worker
`maxCapability` bypass, credential file TOCTOU elsewhere in the worker,
dynamic/string-built T-SQL, unsafe DOM sinks in the dashboard, GitHub Actions
script injection, and unverified binary execution in the Linux install path.
These were all closed by the 2026-07 round below and re-verified clean here.

One coverage gap surfaced during re-verification rather than a live bug: the
command-signing-key-pin tear-down in `session.ts` (fixed by
[#91](https://github.com/semics-tech/remote-sql-agent/pull/91) in the 2026-07
round) had no dedicated regression test. Closed in this round by
`packages/worker/test/command-signing-key-pin.test.ts` — see the #91 row
below.

## 2026-07 — deep-dive review (A/B/C/D items)

A full-project review (five parallel audits plus a verification pass) found
the codebase already unusually disciplined — zero `any`, zero `@ts-ignore`, no
`innerHTML`/`eval`, no plaintext-credential path to the server, no dynamic SQL
— and that the control plane could not raise a worker's `maxCapability`. The
findings were gaps in breadth and edge cases, several load-bearing. Full
detail and severity reasoning lived in the working plan for that round; this
table keeps the durable record.

| Finding | Fixing PR | Regression test |
|---|---|---|
| Environment-scoped RBAC was inert — `instances.environment_tag` had zero writers, so every environment grant silently fell back to matching only a `*` grant. | [#79](https://github.com/semics-tech/remote-sql-agent/pull/79) | `packages/server/test/route-guards.test.ts` — tags an instance through `POST /api/workers/:workerId/instance-configs`, not `db.update`, then asserts the guard refuses/permits. |
| Job definitions (full canonical JSON, including step bodies and connection strings) were written into `audit_log.detail` and shipped to the configured SIEM via OTLP export, violating the "never log step bodies, canonical JSON, or passwords" rule. | [#81](https://github.com/semics-tech/remote-sql-agent/pull/81) | `packages/server/test/audit-redaction.test.ts` — asserts no audit row's serialised `detail` contains a step body, across every command kind. |
| Three trust-boundary gaps let a worker affect state outside its own instances: an empty snapshot delta soft-deleted every job on an instance; `recordResult` was not scoped to the reporting worker; an unrecognised command id fell back to an arbitrary instance, laundering a DBA's SSMS edit as a control-plane change. | [#83](https://github.com/semics-tech/remote-sql-agent/pull/83) | `packages/server/test/command-result-scope.test.ts` ("a result reported by a worker the command was not sent to", "ignores an id that matches nothing at all") and `packages/server/test/versioning.test.ts`. |
| The drift-conflict check on job writes was bypassable by omission — `PUT …/jobs/{uuid}` with no `baseDefinitionHash` and no `allowOverwrite` silently overwrote an unacknowledged DBA edit. | [#80](https://github.com/semics-tech/remote-sql-agent/pull/80) | `packages/server/test/job-write-conflict.test.ts` — omitting both fields on an existing job returns 400, not a silent write. |
| The SQL/PowerShell lint masker split text by Unicode code point but indexed it with UTF-16 offsets, so any astral character (an emoji in a comment) shifted every subsequent finding to the wrong line or made it vanish. | [#82](https://github.com/semics-tech/remote-sql-agent/pull/82) | `packages/dashboard/test/lint.test.ts` fixtures with an astral character in each masked region. |
| Three separate paths left a worker alive, reporting healthy, and monitoring nothing: an unhandled connect rejection with no reconnect, a first-connect failure that was never retried, and a reconnect snapshot failure that stopped polling for the session. | [#84](https://github.com/semics-tech/remote-sql-agent/pull/84) | `packages/worker/test/liveness.test.ts` — covers each of the three paths independently. |
| The command-signing key was trusted fresh from every `HelloAck`, so the proxy that terminates TLS could also substitute its own signing key — defeating the stated purpose of per-command signatures. | [#91](https://github.com/semics-tech/remote-sql-agent/pull/91) | `packages/protocol/test/signing.test.ts` covers signature verification generally; `packages/worker/test/command-signing-key-pin.test.ts` (added during the 2026-08-02 audit below, closing a gap it found) asserts a `HelloAck` presenting a non-matching key tears the session down when `commandSigningKeyFingerprint` is pinned, and that a matching key connects normally. |
| The worker tarball and WinSW were installed with no checksum, and the credential/mTLS key files were written without `O_EXCL`, so a pre-existing file or symlink at the target path would be silently followed. | [#92](https://github.com/semics-tech/remote-sql-agent/pull/92) | `packages/worker/test/credential-key.test.ts` — "refuses to write the key through a symlink planted at the path", "adopts the key already on disk when another process wins the race". Checksum verification in `release.yml` has no automated test (CI-config behaviour). |
| A boolean config parser accepted only `'true'/'1'/'yes'` literally, so a typo like `RSAGENT_GRPC_REQUIRE_TLS=True` silently started the hub in plaintext, and the same shape disabled four-eyes approval. | [#88](https://github.com/semics-tech/remote-sql-agent/pull/88) | `packages/server/test/fail-open.test.ts` — asserts an unrecognised boolean value throws rather than defaulting permissively. |
| Environment grants could leak estate-wide permissions (`user.admin`/`worker.admin`/`audit.read`) if a route used the wrong guard. | [#93](https://github.com/semics-tech/remote-sql-agent/pull/93) | `packages/server/test/route-guards.test.ts` — "refuses an Admin grant on every environment" (parameterised over every estate-wide route); see also `environments.ts`'s hard exclusion, documented in `security.md`. |
| Login had no CSRF protection before a session existed (the double-submit cookie did not yet exist to check against); SSE sessions were not re-checked after connection open. | [#96](https://github.com/semics-tech/remote-sql-agent/pull/96) | `packages/server/test/auth-routes.test.ts` — "login CSRF" describe block. |
| Worker command-handler gaps: unguarded `JSON.parse` on command payloads, idempotency ordering, and stream identity confusion on reconnect. | [#97](https://github.com/semics-tech/remote-sql-agent/pull/97) | `packages/worker/test/command-handler.test.ts` — "malformed JSON is refused, not thrown" (schedule and operator upserts); `packages/worker/test/session-stale-stream.test.ts` for stream identity. |
| Unbounded growth in the worker outbox and pending-attribution map; loose file permissions on state files. | [#98](https://github.com/semics-tech/remote-sql-agent/pull/98) | `packages/worker/test/outbox.test.ts` ("bounded size", "applied command idempotency records are pruned") and `packages/worker/test/pending-attribution.test.ts` ("entries that are never consumed"). |

## Tooling added specifically to stop classes of these bugs recurring

- **Type-aware linting** ([#85](https://github.com/semics-tech/remote-sql-agent/pull/85)) — `no-floating-promises`, `no-misused-promises`, `await-thenable`, `require-await`. Every worker health-monitoring bug above was a promise-lifecycle bug; this rule finds that shape automatically.
- **Coverage reporting** ([#86](https://github.com/semics-tech/remote-sql-agent/pull/86)) — `agent-writer.ts`, the only code that writes to a customer's `msdb`, had no dedicated unit test before this. Reporting-only, no threshold gate yet.
- **`pnpm audit --audit-level high`** in CI on every PR, plus **`minimumReleaseAge`** (`pnpm-workspace.yaml`, [#103](https://github.com/semics-tech/remote-sql-agent/pull/103)) — refuses to resolve a package published in the last 3 days, catching an unknown-vulnerability supply-chain compromise before it's known, not just a disclosed one.
- **CodeQL**, SHA-pinned GitHub Actions, and the worker-bundle self-test running in CI ([#102](https://github.com/semics-tech/remote-sql-agent/pull/102)) — a repo-only bundle used to pass every test and then fail to start once shipped standalone.
- **OTel trace instrumentation** ([#105](https://github.com/semics-tech/remote-sql-agent/pull/105)) — not a vulnerability fix, but the audit-log gap above (finding job definitions in the SIEM export) was only visible by tracing the full export path; tracing makes that kind of leak easier to catch by inspection next time.

## What was checked and is not a finding

Documented here so a future audit doesn't re-litigate the same question:

- **Estate-wide read access is by design, not a bypass.** Any base role can read every job, instance, and audit row across the whole estate regardless of environment grants — grants are additive-only and scope *writes*, never reads. See "Environment grants" in `security.md`.
- **A worker's `maxCapability` cannot be raised by the control plane**, verified end to end (an enrolment granting `job.toggle` still resolves to `observe` for a worker pinned `readOnly`) and re-verified in both audit rounds above.
- **The control plane never holds a usable SQL credential** — passwords are encrypted client-side to the target worker's public key; re-verified in both rounds.
- **RFC1918 addresses are intentionally allowed as webhook targets**; only the link-local/metadata range is blocked. This product runs inside the firewall by design — see "A webhook is an outbound request" in `security.md`.
- **SBOM generation and container image scanning are not implemented.** Tracked as a known gap in `security.md`, not fixed here — it's a tool choice (Trivy/Grype/Syft) rather than a bug.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public
issue. See [`security.md`](security.md#reporting-a-vulnerability).
