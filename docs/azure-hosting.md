# Hosting the control plane on Azure

Options for running the dashboard and API in Azure, cheapest first, and what
each one costs you in adaptation rather than money.

Prices are approximate, US/UK regions, mid-2026, and change. Use the
[Azure pricing calculator](https://azure.microsoft.com/en-us/pricing/calculator/)
before committing to anything. What does not change is the shape of the
constraints below, and those are what actually decide this.

---

## What the architecture forces

Four properties of this system rule out most of the cheap serverless answers.
Read these before the options; each option is really just a different way of
satisfying them.

**One container, two ports.** The dashboard is built into the control-plane
image and served by the API process from `RSAGENT_DASHBOARD_DIR`
([`deploy/Dockerfile`](../deploy/Dockerfile)). There is no separate front end to
host. Port 8080 is the dashboard, REST API and SSE stream; port 8443 is the
worker hub. Both must be reachable from outside — workers dial *out* to 8443,
and that is the only inbound port the SQL network segments need.

**Exactly one replica.** `WorkerRegistry` and `EventBroker` are in-memory, and
deliberately so — see the comment in
[`packages/server/src/hub/registry.ts`](../packages/server/src/hub/registry.ts):
control-plane HA is a non-goal for v1. A connection is only live for the process
holding the socket. Run two replicas and commands dispatch into a process that
does not have the worker's stream, while a browser connected to replica A never
sees events published on replica B. Neither failure is loud. **Pin
min replicas = max replicas = 1 and remove any HTTP-based scale rule.** Until
the registry is shared, "scaling" means a bigger instance, not more of them.

**The hub terminates its own TLS.** `RSAGENT_GRPC_TLS_CERT` and
`RSAGENT_GRPC_TLS_KEY` are read from disk and the server refuses to start
without them. The only override, `RSAGENT_GRPC_REQUIRE_TLS=false`, is documented
as local-development-only, because in token mode TLS is the only thing keeping
worker API keys off the wire. Any platform that terminates TLS at its own edge
forces that flag on in production. That is a real downgrade, not a formality —
prefer platforms that pass TCP through.

**Postgres, and long-lived connections.** Migrations run at boot, so the
database must exist and be reachable before the container starts. Idle timeouts
are not a problem: SSE sends a keepalive comment every 25s, workers heartbeat
every 30s, and the gRPC client sets `keepalive_time_ms: 30_000`. All three sit
comfortably under the ~4-minute idle timeout common to Azure's front ends.
`trustProxy: true` is already set, so running behind a reverse proxy needs no
change.

---

## Option A — one small VM running the shipped Compose file

**Best for testing, and cheapest by a wide margin.**

`deploy/docker-compose.yml` already is this deployment. A B-series Linux VM,
Docker, `docker compose up -d`, done — Postgres runs as a container next to the
server, so there is no managed-database bill. Both ports work natively, the hub
keeps its own TLS, and one replica is guaranteed by construction.

| | |
|---|---|
| Compute | B2ats v2 (2 vCPU / 1 GiB) ~$7/mo, or B1ms (1 vCPU / 2 GiB) ~$15/mo |
| Database | $0 — Postgres container |
| Disk | ~30 GiB managed disk, $2–5/mo |
| **Total** | **~$10–20/mo, or $0 for 12 months** |

A new Azure free account includes 750 hours/month of B1s, B2ats v2 or
B2pts v2 for 12 months, which covers one always-on VM. For a test estate that
genuinely is free.

Take the 2 GiB size unless you are counting pennies. Node plus Postgres plus
Docker in 1 GiB works but leaves nothing spare, and the failure mode is the
OOM-kill described in [CLAUDE.md](../CLAUDE.md) — containers showing
`Exited (137)` and errors that look like anything but memory.

For dashboard TLS, put Caddy in front for automatic certificates, or reuse the
hub certificate. Note that the VM is yours to patch and back up; nothing else
here is.

## Option B — Container Apps + Flexible Server

**The one to grow into.** More expensive than the VM and worth it once you want
managed backups, rolling deploys and no host to patch.

Main HTTP ingress maps to 8080 and gets a managed certificate and custom domain
at no charge. The hub goes on an **additional external TCP port** for 8443,
which is TLS passthrough — so the app keeps terminating its own gRPC TLS and
`RSAGENT_GRPC_REQUIRE_TLS` stays where it belongs. That is the reason to prefer
this over App Service.

Two constraints on that port: external TCP ingress requires the environment to
be VNet-integrated and the app to be external, and every externally exposed port
must be unique across the whole Container Apps environment. The VNet itself adds
no cost, just a delegated subnet.

| | |
|---|---|
| Container Apps, 0.5 vCPU / 1 GiB, always on | $10–34/mo |
| PostgreSQL Flexible Server B1ms + 32 GiB | ~$16–19/mo |
| **Total** | **~$26–53/mo** |

The compute range is wide because of how idle billing works. A replica bills at
the reduced idle rate only when it is processing no HTTP requests, using under
0.01 vCPU **and** seeing under 1,000 bytes/second of network traffic. A control
plane holding open worker streams and SSE connections will fail that last test a
good deal of the time, so budget nearer the top of the range. The free grant
(180,000 vCPU-seconds and 360,000 GiB-seconds per subscription per month) is
already netted off above; it covers roughly 100 hours of a 0.5 vCPU replica, not
a month of one.

Set `minReplicas: 1`, `maxReplicas: 1`. This is the platform where getting that
wrong is easiest and quietest.

## Option C — App Service for Linux

Works, but costs you two things worth keeping.

gRPC is supported on Linux App Service by nominating an HTTP/2 port in app
settings, and the 20-minute gRPC inactivity timeout is harmless given the 30s
heartbeat. But TLS terminates at the App Service front end, which means running
`RSAGENT_GRPC_REQUIRE_TLS=false` in production, and **HTTP/2 on App Service does
not support client certificates** — which removes `mtls` from
`RSAGENT_WORKER_AUTH_MODES` entirely. If any site needs certificate-based worker
auth, this option is out.

B1 is ~$13/mo plus the database, so it is not cheaper than Container Apps once
you add Flexible Server. The F1 free tier is not usable: 60 CPU-minutes/day and
no always-on will not hold a worker stream.

## Option D — Container Instances

Multiple ports on one public IP and per-second billing, but no managed
certificate, no custom domain and no restart policy worth relying on. Around
$30/mo left running, which is more than the VM for less. Only interesting if you
script it up for a test run and delete it afterwards, in which case the
per-second billing is the whole point.

## Option E — splitting the dashboard onto Static Web Apps

Tempting because the free tier is genuinely free, and not worth doing.

The API container has to run regardless, so the saving is close to zero, and the
cost is real: the dashboard is built into the server image rather than published
separately, CORS is deliberately locked to the single exact origin
`config.publicUrl` (a reflected origin with `credentials: true` is equivalent to
no CORS at all), and session cookies would become cross-site — needing
`SameSite=None` and a fresh look at CSRF. Same-origin is doing security work
here. Leave it.

---

## Could the app be restructured to hit Azure's free tiers?

Yes, on paper. The arithmetic says don't.

Azure's cheap tiers are cheap because you pay nothing while idle. This control
plane is never idle: workers hold a socket open and heartbeat every 30s. Two
things force always-on compute — the held stream, and Postgres, which has no
auto-pause (you can stop a Flexible Server manually, and billing does stop
immediately, but nothing does it for you). Removing one without the other saves
nothing, so a serverless rewrite is all-or-nothing.

The all-in version would be: dashboard on Static Web Apps (free), REST API on
Functions (1M free executions/month), SSE and the worker hub both on
[Web PubSub](https://azure.microsoft.com/en-us/pricing/details/web-pubsub/)
(free tier, 20 concurrent connections, 20,000 messages/day), commands dispatched
through a Storage Queue, and state in the
[Azure SQL free offer](https://learn.microsoft.com/en-us/azure/azure-sql/database/free-offer?view=azuresql)
(100,000 vCore-seconds and 32 GB per database per month, for the lifetime of the
subscription). That really does total about $0.

Three things break it.

**The free database cannot stay awake.** 100,000 vCore-seconds at the serverless
minimum of 0.5 vCore is **55 hours of activity per month**. A control plane
taking heartbeats every 30s never idles long enough to auto-pause, so it would
exhaust the monthly allowance in about **2.3 days** and then auto-pause until the
next calendar month. Auto-pause on the database holding every job definition in
the estate is not a failure mode worth designing toward.

**The free ceilings bite exactly when the product starts working.** Web PubSub
free is 20 concurrent connections — worker sockets and browser streams share
that budget. At 25 SQL hosts you are on Standard, which costs more than the VM.
Free tiers are sized for demos, and this outgrows them at the point where it is
proving useful.

**The rewrite is in the most expensive places.** Moving the hub off gRPC means
changing [`worker.proto`](../packages/protocol/proto/rsagent/v1/worker.proto) and
reshipping every deployed worker in lockstep, or supporting two transports
forever. `mtls` almost certainly does not survive the move to WebSocket clients,
and the threat model relies on it for sites that cannot hold an API key.
Outbound-only *is* preserved — WebSockets still dial out — so the central
property survives, but that is the only thing that comes through cleanly.
Separately, Postgres → SQL Server means porting 11 `jsonb` columns whose type is
a deliberate choice (see [faq.md](faq.md)) onto a different JSON story, and
Drizzle only gained an MSSQL dialect in 1.0.0-beta against the 0.45 line this
repo pins.

Set against a saving of $10–20/month, none of that pays. Several of the pieces
you would trade away are listed in [CLAUDE.md](../CLAUDE.md) as deliberate rather
than accidental.

### The restructure that does pay

It is not a hosting change. The constraint that actually limits this system is
the single replica, and the fix is worth making on its own merits:

- Every deploy currently drops every worker stream, because there is only ever
  one process and it restarts. Shared state buys zero-downtime rollouts.
- It is the precondition for scaling out on any platform, Azure or otherwise.
- It touches no credential path, no worker protocol and no deployed binary.

The shape: persist worker→node affinity so dispatch knows which process holds a
given stream, route commands to that node, and replace `EventBroker`'s in-process
fan-out with the same mechanism. Postgres `LISTEN`/`NOTIFY` covers both and adds
no new infrastructure, since Postgres is already there.

Worth taking regardless, and free: if you do move to a managed Flexible Server,
scheduling a stop overnight and at weekends roughly halves the compute bill and
needs no code change at all.

---

## Recommendation

Start on **Option A**: a free-tier B-series VM running the Compose file you
already ship. It needs no adaptation, exercises the real deployment path, and
costs nothing for the first year.

Move to **Option B** when you want it managed. Both ports survive intact, the
hub keeps its own TLS, and the only discipline required is pinning the replica
count.

Before the control plane can scale *out* rather than up, `WorkerRegistry` and
`EventBroker` both need to stop being per-process — a shared registry plus a
routing layer, or Postgres `LISTEN`/`NOTIFY` for the event fan-out. That is a
design change to raise on its own, not something to fold into a hosting move.
