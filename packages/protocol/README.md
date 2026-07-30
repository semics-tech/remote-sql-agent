# @remote-sql-agent/protocol

Shared contracts for [Remote SQL Agent](https://github.com/semics-tech/remote-sql-agent).

Consumed from source by the worker, the control plane and the dashboard, so all
three derive byte-identical canonical bytes from the same job — which is what
makes drift detection mean anything.

## Not published to npm

This package is internal. Nothing installs it: the worker inlines it into its
bundle, and the control plane image carries it.

Publishing it would turn these contracts into a public API with semver
expectations attached, which is a promise worth making only once someone
actually needs it. `JobDefinition.v1` can currently change shape whenever the
worker and server change together — the property that keeps drift detection
honest — and that freedom is worth more than a package nobody has asked for.

Version `0.1.0` was published before this was decided and is deprecated. If you
want to build against the wire protocol, the `.proto` files in `proto/` and the
zod schemas in `src/` are the source of truth, and
[an issue](https://github.com/semics-tech/remote-sql-agent/issues) asking for a
published package is the way to change this.

## What is in it

### `JobDefinition.v1`

The canonical representation of a SQL Server Agent job: job, steps, schedules
and notification config. A zod schema, so you get runtime validation and static
types from one definition.

Deliberately excludes anything that varies between two servers holding "the
same" job — `job_id`, `date_modified`, `originating_server` — so two instances
running an identical job produce an identical hash.

```ts
import { canonicaliseJobWithHash, parseJobDefinition } from '@remote-sql-agent/protocol';

const { canonicalJson, hash } = canonicaliseJobWithHash(definition);
// hash is stable across machines, and across CRLF/LF differences in step bodies
```

### Schedule codec

SQL Agent's `freq_type` / `freq_interval` / `freq_subday_*` model is famously
fiddly. This stores it faithfully and converts to something humane for display:

```ts
import { describeSchedule, toHumaneSchedule } from '@remote-sql-agent/protocol';

describeSchedule(schedule);
// "Occurs every 2 weeks on Monday, Wednesday, Friday every 30 minutes
//  between 08:00:00 and 18:00:00"
```

### Capability and role model

The capability tiers, the command-to-capability mapping, and the dashboard RBAC
matrix — including `effectiveCapabilities()`, which intersects a server-side
grant with a worker's local ceiling.

### Wire protocol

Protobuf definitions for the worker hub, with generated TypeScript types. The
`.proto` files ship in the package if you need to generate for another language.

## Browser use

The main entry point imports `node:crypto` and gRPC. For a browser bundle:

```ts
import { describeSchedule, type JobDefinition } from '@remote-sql-agent/protocol/browser';
```

That surface has the domain types, the schedule codec and the capability model,
without the transport or crypto.

## Stability

`0.x`: breaking changes may land in minor versions. `JobDefinition.v1` is
versioned in its own name — a breaking change to the job shape would be
`JobDefinition.v2`, alongside v1 rather than replacing it.

## Licence

[Apache 2.0](https://github.com/semics-tech/remote-sql-agent/blob/main/LICENSE)
