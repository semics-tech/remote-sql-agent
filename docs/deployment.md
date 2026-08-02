# Deploying the control plane

Where to run it, what it costs, and the two constraints that decide both.

The worker has three install routes and they are covered in the
[README](../README.md). This is about the other half: the control plane, which
is one container plus Postgres.

---

## Two constraints

Both look like oversights. Neither is, and a deployment that ignores either
fails quietly rather than loudly.

### 1. One process, two ports

| Port | Protocol | Who reaches it |
|---|---|---|
| 8080 | HTTP/1.1 | Browsers — dashboard, REST API, `/install.sh`, `/downloads/` |
| 8443 | HTTP/2 + TLS | Workers — one long-lived bidirectional gRPC stream each |

They cannot share a port: gRPC owns its own socket. And **8443 must reach the
process as raw TCP**. The hub terminates TLS itself, which is what makes mTLS
and the workers' pinned CA work end to end — put an L7 proxy in front and both
break. Most managed HTTP front ends also impose a request timeout, which severs
a stream that is meant to stay open for months.

> Azure Container Apps' HTTP ingress times a request out at **240 seconds**. A
> worker stream through it would be cut every four minutes. Workers survive that
> — they reconnect with backoff — but each reconnect resends a full snapshot per
> instance, so the estate never settles.

### 2. Exactly one replica

The registry of connected workers is an in-memory map
(`packages/server/src/hub/registry.ts`). A worker holds its stream to one
replica; a command issued on any other finds it absent and never delivers. The
live-update fan-out is process-local in the same way.

Nothing errors. Roughly half of all commands simply never arrive, while the
dashboard looks healthy.

This also means **you cannot split the API and the hub into two services** — the
REST process must hold the worker sockets in order to dispatch to them.

Scale up, not out. See [Sizing](#sizing).

---

## Choosing a route

| | **A — VM + Compose** | **B — Container Apps** | **C — Kubernetes** |
|---|---|---|---|
| For | Anyone. Start here | Azure shops that will not run a VM | Estates already running a cluster |
| Cost/month | Azure B2s ≈ **£32** all-in<br>Hetzner CX22 ≈ **£3**<br>Oracle Always Free ≈ **£0** | ≈ **£70–85** | Marginal if the cluster exists |
| Effort | Lowest — one file, one command | VNet-injected environment **and** a bring-your-own certificate | Medium |
| TLS | Caddy gets and renews it | Your certificate, twice over | Ingress + a Secret |
| Catch | You patch the host | Live updates reconnect every 240 s | Someone will scale it |

**Route A unless you have a specific reason.** It is the cheapest, it needs
nothing but Docker, and it is the only one where the hub's TLS is entirely
yours. Route B buys managed patching and backups for roughly double the price
and several sharp edges. Route C is worth it only if the cluster is already
there.

### Is there a free option?

Not a managed one. This needs a process running 24/7 holding open streams, plus
a database — which is outside every serverless free tier.

The genuinely free answer is a free **VM**. Oracle Cloud's Always Free Ampere
instances run the whole stack at £0/month forever, and the image is published
for arm64. As of June 2026 the allowance is 2 OCPU / 12 GB, halved from 4/24 —
still comfortably more than this needs. Capacity in popular regions can be hard
to get.

Azure's free account gives 12 months of a B1s VM and a B1ms Postgres. That is a
free *year*, not free forever, and B1s is 1 GB — below the floor below.

---

## Route A — a VM running Compose

No checkout. Three files and a published image.

### 1. Point DNS at the machine first

Caddy asks Let's Encrypt for a certificate on startup and the check fails if the
name does not resolve yet. It retries, but the first minutes of log look worse
than they are.

### 2. Bring the host up

Either use [`deploy/cloud-init.yaml`](../deploy/cloud-init.yaml) as user-data —
edit `RSAGENT_DOMAIN` in it first:

```bash
az vm create -g rsagent -n rsagent --image Ubuntu2404 \
  --size Standard_B2s --custom-data @cloud-init.yaml

hcloud server create --type cx22 --image ubuntu-24.04 \
  --user-data-from-file cloud-init.yaml --name rsagent
```

…or, on a host that already has Docker:

```bash
mkdir -p /opt/rsagent/deploy && cd /opt/rsagent/deploy
BASE=https://raw.githubusercontent.com/semics-tech/remote-sql-agent/main/deploy
curl -fsSLO $BASE/docker-compose.yml
curl -fsSLO $BASE/Caddyfile
curl -fsSL  $BASE/.env.example -o .env
```

### 3. Fill in `.env`

```bash
RSAGENT_VERSION=0.2.0                              # pin it
RSAGENT_PUBLIC_URL=https://rsagent.corp.example.com
RSAGENT_DOMAIN=rsagent.corp.example.com
POSTGRES_PASSWORD=<40 random characters>
RSAGENT_TRUSTED_PROXY_HOPS=1                       # Caddy is one hop
RSAGENT_HTTP_BIND=127.0.0.1                        # only Caddy may reach 8080
```

### 4. Give the hub a certificate

It refuses to start without one, because in token mode TLS is the only thing
keeping worker API keys off the wire. Put `server.crt` and `server.key` for
`RSAGENT_DOMAIN` in `./tls`.

Use your estate's CA if you have one. Otherwise self-signed is a legitimate
posture here rather than a shortcut — workers pin it with `--ca-cert`, which is
a stronger position than trusting every public CA:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout tls/server.key -out tls/server.crt \
  -subj "/CN=rsagent.corp.example.com" \
  -addext "subjectAltName=DNS:rsagent.corp.example.com"
```

**Do not point the hub at Caddy's certificate.** The hub reads its PEM files
once at startup and grpc-js cannot swap credentials on a bound server, so a
90-day certificate is served past expiry until something restarts the container
— roughly day 60 of every cycle. The failure is total, silent, and hits every
worker at once, a month after the dashboard visibly renewed.

### 5. Start it

```bash
docker compose --profile tls up -d          # with HTTPS
docker compose up -d                        # if you terminate TLS elsewhere
```

### 6. Open the firewall

| Port | From |
|---|---|
| 443 | Wherever the dashboard is used |
| 80 | The internet, for the ACME challenge only |
| 8443 | Your SQL Server segments only |

Nothing ever connects *to* a worker.

### 7. Collect the bootstrap password

Printed once, on first boot:

```bash
docker compose logs server | grep -i password
```

---

## Behind Cloudflare, or any CDN proxy

Cloudflare solves the dashboard side and **must not** be put in front of the
worker hub. The two ports need opposite treatment, and the failure mode if you
get it wrong is slow rather than obvious.

| Record | Proxy | Port | |
|---|---|---|---|
| `rsagent.corp.example.com` | 🟠 Proxied | 443 → 8080 | Dashboard and API |
| `rsagent-hub.corp.example.com` | ⬜ **DNS only** | 8443 | Workers dial this directly |

```bash
RSAGENT_PUBLIC_URL=https://rsagent.corp.example.com
RSAGENT_HUB_ADVERTISED_ADDRESS=rsagent-hub.corp.example.com:8443
```

Without that second line, every install command the dashboard prints sends
workers at the proxied name.

### Why the hub cannot be proxied

Port 8443 is on Cloudflare's proxied HTTPS list, so this looks like it should
work. It does not, for three independent reasons:

- **Bidirectional streams do not survive an L7 proxy.** Cloudflare's read
  timeout is 100–120 seconds and idle streams are reset sooner. The worker
  heartbeat is 30 s so a healthy stream stays under it, but any pause resets the
  connection — and every reconnect resends a full snapshot per instance.
- **mTLS becomes impossible.** Client certificates do not survive termination.
- **CA pinning stops meaning anything.** Workers would verify Cloudflare's edge
  certificate rather than yours, so `--ca-cert` no longer pins anything.

Cloudflare's product for raw TCP is Spectrum, which is Enterprise-only. Every
other CDN and WAF has the same shape: if it terminates HTTP, it cannot carry the
hub.

### The hub still needs its own certificate

`RSAGENT_GRPC_REQUIRE_TLS` is about the hub, not the dashboard, so putting
Cloudflare in front of 443 does not remove the requirement — the control plane
still refuses to start without `RSAGENT_GRPC_TLS_CERT` and
`RSAGENT_GRPC_TLS_KEY`.

Self-signed is the simplest answer and workers pin it with `--ca-cert`. If you
want a publicly-issued certificate for a name that is not internet-reachable on
80, use **Let's Encrypt with a DNS-01 challenge** and a Cloudflare API token —
it needs no inbound HTTP, so it works on a grey-clouded record.

Do not use a Cloudflare Origin Certificate here. Only Cloudflare's edge trusts
it, and the workers are not Cloudflare's edge.

### Settings that change

**Use SSL/TLS mode Full (strict).** Flexible means Cloudflare reaches your
origin over plain HTTP, across the public internet. Keeping the `tls` profile
behind Cloudflare gives you a valid origin certificate and end-to-end
encryption.

**`RSAGENT_TRUSTED_PROXY_HOPS` counts Cloudflare too:**

| Chain | Value |
|---|---|
| Cloudflare → Caddy → server | `2` |
| Cloudflare → server directly | `1` |

Cloudflare sets `X-Forwarded-For` to the real client; Caddy then appends
Cloudflare's edge address. Count both or every audit row records an edge IP
instead of the person.

**Restrict 8080 to [Cloudflare's IP ranges](https://www.cloudflare.com/ips/).**
Otherwise anyone who finds the origin address reaches the dashboard over plain
HTTP, where credential onboarding silently does not work.

---

## Route B — Azure Container Apps

Managed, at roughly double the cost of a VM and with more to get right.

- **Dashboard and API** on the main HTTP ingress → 443, with a custom domain.
- **The hub** on an *additional external TCP port* 8443. This is layer 4, so the
  container keeps terminating its own TLS and the 240-second timeout does not
  apply.

Three things to know before committing:

1. **External TCP ingress requires a VNet-injected environment.** Externally
   exposed extra ports must also be unique across the whole environment.
2. **Bring your own certificate.** Container Apps' free managed certificates
   cannot be exported, so the hub cannot use one. Store a single certificate in
   Key Vault and reference it twice: as the custom-domain certificate, and as
   two app secrets mounted as files for the hub. Prefer a 1-year certificate —
   every renewal restarts the revision and reconnects the estate.
3. **Set `minReplicas: 1, maxReplicas: 1`.** See constraint 2.

Mount the hub PEMs with an explicit secret list, not "mount all secrets", or the
Postgres password lands on disk beside the private key:

```
volumes: [{ name: 'tls', storageType: 'Secret',
            secrets: [{ secretRef: 'hub-tls-crt', path: 'server.crt' },
                      { secretRef: 'hub-tls-key', path: 'server.key' }] }]
```

Also set `RSAGENT_HUB_ADVERTISED_ADDRESS` if the exposed port differs from 8443,
and `RSAGENT_TRUSTED_PROXY_HOPS=1`.

> **Not yet verified.** Whether a custom domain CNAME'd to the app reaches a raw
> TCP port is not something Microsoft's documentation states consistently — the
> ingress article says FQDN plus exposed port, the networking article lists only
> 80/443 inbound. Test it with
> `openssl s_client -connect rsagent.<domain>:8443` before committing to this
> route. A Bicep template is not published here for that reason.

---

## Route C — Kubernetes

[`deploy/k8s/control-plane.yaml`](../deploy/k8s/control-plane.yaml). Edit the
two Secrets and the hostnames, then apply. Postgres is out of scope — use a
managed database.

The hub is a `LoadBalancer` Service, not a second Ingress rule, so it stays
layer 4. The Deployment is `replicas: 1` with `strategy: Recreate`.

Two settings that are required rather than hygiene, both found by running it:

- **`enableServiceLinks: false`.** Kubernetes injects an environment variable
  per Service named `<SERVICE_NAME>_PORT`, so a Service called `rsagent-http`
  sets `RSAGENT_HTTP_PORT=tcp://10.43.x.x:80` — colliding with the config
  variable — and the process dies at startup on `Expected number, received nan`,
  naming neither Kubernetes nor the Service.
- **An `emptyDir` at `/tmp`** if you set `readOnlyRootFilesystem: true`. The
  server writes nothing to disk, but it runs TypeScript through tsx, which
  caches transforms there. Without it: `ENOENT: mkdir '/tmp/tsx-1000'`.

> This manifest is schema-valid and has been applied to a live cluster, but a
> full run to Ready has not been completed. Treat it as a starting point.

---

## Sizing

| | CPU | Memory |
|---|---|---|
| Floor | 0.5 vCPU | 1 GB |
| **Default** | **1 vCPU** | **2 GB** |
| Large estate | 2 vCPU | 4 GB |

Below the floor, a cold start plus a reconnect storm will run out of memory.

**Ceiling: roughly 200 workers / 400 monitored instances** at the default poll
intervals on 1 vCPU / 2 GB. At that point each instance is producing about 0.25
messages per second, and the first wall is **Postgres, not Node** — the
connection pool is fixed at 10.

The levers, in the order to reach for them:

1. Raise the poll intervals (`RSAGENT_DEFINITION_POLL_SECONDS` and friends).
   They are pushed down to workers at connect, so this is a server-side change.
2. Raise the database tier.
3. Raise CPU and memory.

There is no horizontal option.

---

## Things that will catch you

**`RSAGENT_PUBLIC_URL` is compared character for character.** It is the CORS
allowlist, so a trailing slash, or `http` where the browser sends `https`, gives
a dashboard that loads and then fails every API call with an opaque error. The
same string decides whether session cookies are marked `Secure`, so an `http://`
typo silently ships non-Secure cookies over HTTPS.

**Serve the dashboard over HTTPS.** SQL credentials are encrypted in the browser
to the target worker's public key, and `crypto.subtle` does not exist in an
insecure context. Over plain HTTP the credential field disables itself. If you
enable the `tls` profile, also set `RSAGENT_HTTP_BIND=127.0.0.1` — otherwise the
same dashboard is still served over HTTP on a second origin where it silently
does not work.

**Set `RSAGENT_TRUSTED_PROXY_HOPS` to the true number of proxies.** Too high and
a caller can choose their own client IP, which forges `remoteAddress` on every
audit row and sidesteps rate limiting. 0 — the default — ignores the header
entirely and is correct when nothing is in front. A CDN counts as a hop; see
[Behind Cloudflare](#behind-cloudflare-or-any-cdn-proxy).

**Never put an HTTP proxy in front of the hub.** Anything that terminates HTTP
— a CDN, a WAF, an ingress controller, an application gateway — breaks mTLS,
makes the workers' pinned CA meaningless, and imposes a request timeout on a
stream meant to stay open for months. The hub needs to be reached as raw TCP.

**Set `RSAGENT_HUB_ADVERTISED_ADDRESS` if the hub is not at
`RSAGENT_PUBLIC_URL`'s host on 8443.** That string is copied into `worker.yaml`
on every SQL host. A wrong value does not fail loudly: workers retry on backoff
forever and simply never appear.

**The Windows one-liner needs `-PackageUrl` for now.** The container image
builds only the Linux worker package, so
`/downloads/rsagent-worker-windows.zip` is a 404. Point it at the release asset
until that is fixed:

```powershell
Install-RsAgentWorker -ControlPlane rsagent.corp.example.com:8443 -Token rsen_... `
  -PackageUrl https://github.com/semics-tech/remote-sql-agent/releases/latest/download/rsagent-worker-0.1.1-win-x64.zip
```

---

## Operating it

**Upgrading.** Bump `RSAGENT_VERSION`, then `docker compose pull && docker
compose up -d`. Migrations run at startup. Workers reconnect on their own
backoff and resend a snapshot; jobs keep running throughout, because a control
plane outage costs visibility, not execution.

**Backups.** Everything is in Postgres. Job definitions routinely contain
connection strings, so put the volume on encrypted storage and encrypt the
backups — see [security.md](security.md).

**Monitoring.** `/health` reports the process is alive with no database call —
point a liveness or startup probe at it. `/readyz` additionally checks Postgres
is reachable and is what a readiness probe or load balancer health check
should use instead; a pod or instance that cannot reach the database is taken
out of rotation rather than continuing to receive traffic it cannot serve.
Both, and `/metrics`, are unauthenticated by default and expose counts only,
never job content. `/metrics` is Prometheus text format; set
`RSAGENT_METRICS_TOKEN` to require `Authorization: Bearer <token>` on it where
the scrape network is not otherwise trusted.

**Audit export.** The database always holds the audit trail;
`RSAGENT_AUDIT_OTLP_ENDPOINT` forwards it somewhere off this host, which is the
point. Any OTLP backend — Azure Monitor, Splunk, Datadog, Elastic, Loki.

**Trace export.** A different signal on a different endpoint:
`RSAGENT_TRACE_OTLP_ENDPOINT` forwards one span per API request and one span
per worker command (dispatch to result or expiry) to an OTLP traces collector.
Off by default — like audit export, there is nowhere useful for it to go until
you set the endpoint. `RSAGENT_TRACE_SAMPLE_RATIO` caps the volume on a large
estate; the default of 1 traces everything, which is fine at this product's
usual traffic.

Then work through the deployment checklist in
[security.md](security.md#deployment-checklist).
