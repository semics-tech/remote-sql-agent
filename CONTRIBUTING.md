# Contributing

Thanks for considering it. This document is short on ceremony and specific about
the few things that genuinely matter here.

## Before you start

**Open an issue first for anything non-trivial.** This product writes to
production database servers, so a change that looks small can have a large blast
radius. A short conversation before the code saves rework.

Bug fixes, documentation, and tests need no discussion — just send them.

## Getting set up

Node.js 24+, pnpm 10+, Docker.

```bash
git clone https://github.com/semics-tech/remote-sql-agent
cd remote-sql-agent
pnpm install
pnpm dev:up      # Postgres + SQL Server 2022 with Agent enabled
pnpm dev:seed    # ~10 varied fixture jobs
```

> The SQL Server image is amd64 and runs under emulation on Apple Silicon. Allow
> 60–90s for it to become healthy, and give Docker at least 6 GB. Below that it
> is the container the kernel picks first: `docker ps -a` shows `Exited (137)`,
> and everything downstream looks like a connection bug instead.

```bash
pnpm test          # unit + integration
pnpm lint
pnpm typecheck
```

CI runs all of these plus a generated-protobuf staleness check.

### Running the full stack

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

**Signing in.** The dashboard asks for credentials in development too — there
is deliberately no local bypass, because every RBAC path in the product hangs
off having a real signed-in user with a real role. `pnpm dev:server` fixes the
bootstrap password to something you already know, by setting
`RSAGENT_BOOTSTRAP_ADMIN_PASSWORD`:

```
username: admin
password: rsagent-dev
```

That only applies on first boot, when the database has no users yet. If you
have an older dev database, or forgot a changed password:

```bash
pnpm dev:reset-admin
```

It refuses to touch anything but a database on `localhost`. In a real
deployment neither of these exists: the control plane generates a password on
first boot and prints it once.

**Enrolling the dev worker.** Needed before step 3 above works. Sign in, then
**Estate → Add a worker** for a token:

```bash
pnpm dev:enrol --token rsen_xxxxxxxxxxxx
```

That writes `packages/worker/run/worker.key` (the credential) and
`credential.key` (the key SQL credentials are encrypted to). Delete either and
the worker cannot reconnect — rotate a new one from **Administration →
Workers**.

**Letting the dev worker make changes.** Two gates, and **both** must allow it
— see [docs/capabilities.md](docs/capabilities.md):

1. **Administration → Workers → Manage** — tick the capabilities to grant.
2. `deploy/worker.dev.yaml` — raise `maxCapability` from `readOnly`.

`maxCapability` is read **once at startup**, so restart the worker afterwards;
reconnecting re-sends the old value. Confirm it took by looking for
`capabilities` in the worker's `Worker ready` log line, or the "Can actually
do" column in Administration.

> Two worker processes sharing one credential supersede each other in a loop —
> each connect kicks the other off. If capability changes appear to be
> ignored, or the estate flickers, check for a stray worker before anything
> else.

**Seeing drift detection work.** Edit a job the way a DBA would, directly in
SQL:

```bash
docker exec rsagent-dev-sqlserver-1 /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'RsAgent_Dev_Pass123' -C -Q "
EXEC msdb.dbo.sp_update_jobstep
    @job_name = N'RSAgent Fixture - Heartbeat Log', @step_id = 1,
    @command = N'EXEC dbo.usp_LogMaintenance @Source = N''Heartbeat'', @Message = N''Edited in SSMS'';';"
```

Within the poll interval the job shows a **drift** badge, and its Versions tab
has a new `on-premise edit` version with a diff of the changed step body.

### Project layout

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

## The rules that matter

### No SQL string building, ever

Every SQL statement is a static string literal with values bound as parameters.
An eslint rule catches an interpolated or concatenated string passed directly
to `.query()`/`.batch()`/`.execute()`, but it is a syntactic check: hoisting
the built string into a variable first defeats it. Review is what actually
covers that case — see "SQL injection" in `docs/security.md` for the exact
limit. If you find yourself wanting to interpolate, you want a parameter.

### The worker never trusts the control plane

The worker's capability ceiling comes from its own `worker.yaml` and is checked
locally. Nothing the control plane sends may raise it. This is the property that
survives a control-plane compromise, and it is not negotiable.

Similarly: the control plane recomputes definition hashes rather than trusting
the worker's, and worker identity comes from the credential rather than from
anything the worker claims in a message.

### Canonical serialisation is load-bearing

`packages/protocol/src/canonical.ts` must produce byte-identical output from the
worker and the control plane for the same job. A change that breaks this flags
every job in every estate as drifted.

If you touch it, the golden-file tests will tell you. Believe them.

### Nothing may require inbound connectivity to a SQL host

The worker dials out and never listens. A feature that needs the control plane to
reach a worker is the wrong feature — it would make the product undeployable in
the environments it exists for.

### The protobuf files are the source of truth

Edit `packages/protocol/proto/**`, then:

```bash
pnpm proto:gen
```

Commit the generated output. CI fails if it has drifted.

Adding a command type is a deliberate protocol change and is reviewed as one.
There is no "run arbitrary T-SQL" command and there should not be.

## Tests

New behaviour needs a test. Two things to know:

**Server tests use a real Postgres.** Each test file provisions its own database.
Version allocation under concurrency, `ON CONFLICT` idempotency and high-water-mark
monotonicity are not meaningfully testable against a mock.

**Integration tests use a real SQL Server.** They start real jobs and wait for
real history. Slow, and worth it — most of the bugs found during development were
things a mock would have happily agreed with.

If you change the write path, the round-trip fidelity test is the one that
matters: a definition sent from the dashboard must be byte-for-byte identical
when read back from `msdb`.

## Style

Prevailing style, enforced by eslint and TypeScript in strict mode. A few
conventions:

- Comments explain **why**, not what. If a line needs a comment to say what it
  does, rename something instead.
- Non-obvious decisions get a comment. Much of this codebase is choosing between
  two defensible options; the next reader should not have to rediscover why.
- Error messages are written for the person who hits them, and say what to do
  next. `"CapabilityDenied"` is not enough; `"This worker is not permitted to
  job.toggle... Raise maxCapability in worker.yaml if that is intended"` is.
- British spelling in prose and identifiers (`canonicalise`, `serialise`),
  matching the existing code.

## Pull requests

- Branch from `main`.
- Keep it focused. A PR doing two things takes more than twice as long to review.
- Fill in the template — particularly the blast radius section if you touched
  the worker, the write path, or auth.
- CI must be green.

### Title your PR as a conventional commit

Pull requests are squashed, so **the PR title becomes the commit subject on
`main`** — it is the permanent record, not a label for the review. CI checks it.

```
type(scope): description
type: description
```

`type` is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`,
`ci`, `chore`, `revert`, `style`. `scope` is optional, lowercase, and names the
area touched — `worker`, `server`, `dashboard`, `protocol`, `deploy`, `deps`,
`ci`. Append `!` before the colon for a breaking change.

```
feat(dashboard): show the step a running job is actually on
fix(worker): create the credential key with O_EXCL
build(deps): raise drizzle-orm past its injection advisory
feat(protocol)!: require a signature on every command
```

Write the description as an instruction — "show the step", not "shows" or
"showing" — with no full stop, under 100 characters.

Individual commits inside the branch are not checked. They are squashed away, so
gating them would police text that never lands anywhere. Use whatever helps
review; the convention is worth following there too, and the guidance below on
commit bodies applies to the PR body, which becomes the commit body.

### Say why in the body

The subject says what changed. The body says why it needed to, what else was
considered, and anything that would surprise the next reader. A change to the
worker, the write path or auth should say what widens if it is wrong.

This matters more here than in most codebases: much of this work is choosing
between two defensible options, and a year from now the diff will not remember
which one you rejected.

Files that get extra scrutiny, and why:

| Path | Why |
|---|---|
| `packages/worker/src/sql/agent-writer.ts` | The only code that mutates a customer's SQL Server |
| `packages/worker/src/command-handler.ts` | The five gates before it |
| `packages/protocol/src/canonical.ts` | A change here can flag an entire estate as drifted |
| `packages/server/src/auth/**`, `worker-auth/**` | Authentication and authorisation |
| `packages/protocol/proto/**` | The wire contract |

## Security issues

Please do not open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under [Apache 2.0](LICENSE). By submitting a pull
request you confirm you have the right to license your contribution under it.
