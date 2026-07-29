## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Blast radius

<!-- Delete any that do not apply. Be honest — this is the section reviewers read first. -->

- [ ] Touches the **write path** (anything that can change a customer's SQL Server)
- [ ] Touches **authentication or authorisation**
- [ ] Touches **canonical serialisation** (`canonical.ts`, `job-definition.ts`)
- [ ] Changes the **wire contract** (`.proto`)
- [ ] Changes the **database schema** (migration included?)
- [ ] None of the above

If any box above is ticked, say what could go wrong and what you did about it:

<!-- e.g. "Adds a new command type. Capability mapping added and asserted in
     capabilities.test.ts; worker refuses it if the ceiling does not permit." -->

## How it was tested

<!-- Not "tests pass" — what did you actually verify, and against what?
     Integration tests run against a real SQL Server; say if you ran them. -->

- [ ] `pnpm test` passes
- [ ] `pnpm lint` and `pnpm typecheck` pass
- [ ] Integration tests run against a real SQL Server
- [ ] Verified by hand (say how)

## Checklist

- [ ] No SQL built by string concatenation or interpolation
- [ ] New behaviour has a test
- [ ] Error messages tell the reader what to do next
- [ ] Generated protobuf regenerated and committed (`pnpm proto:gen`) if `.proto` changed
- [ ] Docs updated if behaviour or configuration changed
- [ ] `docs/migration.md` updated if this closes or adds a known gap
