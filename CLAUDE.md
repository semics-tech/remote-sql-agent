# Working in this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it is short, and the rules in it
are the ones that matter. This file covers what is easy to get wrong when
working through an agent.

## Commits and pull request titles

Pull requests are squashed, so the **PR title becomes the commit subject on
`main`** and CI rejects one that is not a conventional commit:

```
type(scope): description
```

`type` is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`,
`ci`, `chore`, `revert`, `style`. `scope` is optional, lowercase, and names the
area — `worker`, `server`, `dashboard`, `protocol`, `deploy`, `deps`, `ci`.
`!` before the colon marks a breaking change.

```
feat(dashboard): show the step a running job is actually on
fix(worker): create the credential key with O_EXCL
build(deps): raise drizzle-orm past its injection advisory
```

Write the description as an instruction, no full stop, under 100 characters.
Use the same convention for individual commits, though only the title is
checked.

Bodies explain **why**, what else was considered, and what would surprise the
next reader — not a restatement of the diff. If the change touches the worker,
the write path or auth, say what widens if it is wrong.

## Before saying a change is done

```bash
pnpm lint && pnpm typecheck && pnpm test:unit
pnpm test:integration   # needs pnpm dev:up; slow, and the one that finds real bugs
pnpm audit --audit-level high
pnpm proto:check        # if you touched packages/protocol/proto/**
```

`pnpm dev:up` needs Docker to have about 6 GB. If containers show
`Exited (137)` they were OOM-killed, and the resulting failures look like
unrelated hook timeouts and "close is not a function" — check `docker ps -a`
before concluding anything about the code.

Never report work as finished on the strength of a plan. Run the checks.

If you touched the worker bundle, its dependencies or the SEA build, also run:

```bash
pnpm build:sea          # builds and self-tests a single-file executable
```

and check the bundle starts with nothing beside it, which is how it actually
ships:

```bash
cd "$(mktemp -d)" && cp <repo>/packages/worker/dist/rsagent-worker.mjs .
node rsagent-worker.mjs --rsagent-selftest
```

A bundle that only runs from inside the repository passes every test in CI.

## Staging

Stage named paths. **Never `git add -A` or `git add .`** — the working tree
routinely holds unrelated local edits, and sweeping them into a commit has
already happened once. If a file you did not touch appears in `git status`, say
so rather than committing it.

## Things that are deliberate, not oversights

These look like gaps and are not. Changing one is a design decision that needs
raising, not a fix to slip into an unrelated branch.

- **No local auth bypass.** Sign-in works the same in development as in
  production. Make the bootstrap password *knowable*; never make the check
  skippable. An authentication switch that can be turned off is one that
  eventually ships turned off.
- **`maxCapability` is read once at startup from `worker.yaml`.** No code path
  may let the control plane raise it. This is the property that survives a
  control-plane compromise.
- **The control plane never holds a usable SQL credential.** Passwords are
  encrypted in the browser to the target worker's public key. Nothing may
  introduce a path where a plaintext password reaches the server.
- **Job definitions are unencrypted `jsonb`** so cross-estate search works. See
  [docs/faq.md](docs/faq.md).
- **Drift is surfaced, never silently overwritten.** DBAs will keep using SSMS,
  and they should be able to.
- **No "run arbitrary T-SQL" command,** and adding one is not a shortcut to
  anything.
- **The worker bundle marks nothing external.** It ships as a single `.mjs`
  with no `node_modules` beside it — that is what the tarball, the executables
  and `npm i -g` all rely on. Marking a dependency `--external` to save a
  megabyte makes every one of those fail to start, and the npm route hides it
  because npm happens to install the package anyway.
- **The worker's `dependencies` are empty and its build inputs are
  devDependencies.** Everything is already inside the bundle; declaring it
  again just makes consumers download it twice.

## Two things worth knowing before reading msdb code

- `sysjobactivity.last_executed_step_id` is the step that **finished**, not the
  one running, and it is 0 before anything has. Deriving the running step from
  it directly is wrong. Where this has to be answered, answer it once and share
  it — two implementations drift, and the symptom is one screen contradicting
  another.
- SQL Agent addresses steps by **position**. `step_id` is 1..n with no gaps, and
  `on_success_step_id`, `on_fail_step_id` and `start_step_id` are all positions,
  so any structural edit silently repoints branching. Use the helpers in
  `packages/protocol/src/job-edit.ts` rather than moving steps by hand.

## Logging

Never log step bodies, canonical JSON, or passwords. Step bodies routinely
contain connection strings. The pino redact paths exist for this and should be
extended, not worked around.
