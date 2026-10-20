# Try it in one command

> **Demo only. Not for production.** The SQL Server `sa` password and the admin
> password are throwaway values published in this repository, the hub
> certificate is self-signed, and the worker signs in as `sa`. Everything is
> bound to `127.0.0.1`. For a real deployment follow
> [quick-start.md](quick-start.md).

[`deploy/docker-compose.demo.yml`](../deploy/docker-compose.demo.yml) starts a
complete, populated estate on your laptop: no Node, no pnpm, no tokens to copy.

```bash
git clone https://github.com/semics-tech/remote-sql-agent && cd remote-sql-agent
docker compose -f deploy/docker-compose.demo.yml up
```

Wait for `[demo] worker starting.` in the log, then open
<http://localhost:8080> and sign in as `admin` / `rsagent-demo`. The estate is
already there: one instance (`DEMO-SQLHOST01`) with about eleven Agent jobs,
including one that fails on purpose, one that is always running, a disabled job, multi-step jobs, and one
that mentions `LEGACYFIN01` in a step so you can try cross-estate search.

## Requirements

| | Minimum |
|---|---|
| Docker Desktop memory | **4 GB** (Settings > Resources) |
| Free disk | about 4 GB for images |
| Ports | `8080` free on localhost |

Below 4 GB a container is OOM-killed and shows `Exited (137)`; this looks like a
connection problem but is not. Raise the Docker memory limit and run `up` again.

Memory limits, so you can see where it goes:

| Service | Limit |
|---|---|
| SQL Server 2022 (buffer pool capped at 1.5 GB) | 2 GB |
| Control plane | 640 MB |
| Postgres (tuned small) | 256 MB |
| Worker | 256 MB |
| One-shot containers (certificate, seed), exit when done | 64 to 128 MB |

SQL Server is amd64 only. On Apple Silicon it runs under emulation and takes
60 to 90 seconds to become healthy; the other services wait for it, so the log
is quiet for a minute. That is normal.

## Notes for screenshots

- **A running job is always there.** `RSAgent Fixture - Long Running Report` is
  started by the seed and rescheduled every 10 minutes. Its single step waits in
  a loop for about 12 minutes, so a run is always in progress (Agent skips a
  start while one is running). It sleeps, so it costs no CPU and almost no
  memory. Shoot the job list or the job's detail page for the **running** state.
- The job list has about eleven jobs; `Known Failure` shows the failed state and
  the disabled job shows the disabled state, so one frame can carry all three.
- Wait for `[demo] worker starting.` and about 15 seconds after that so the
  first poll has landed before you capture.
- For the **drift** badge, run the drift command below first and wait about 15
  seconds.

## See drift detection work

In a second terminal:

```bash
docker compose -f deploy/docker-compose.demo.yml run --rm drift
```

This edits the `RSAgent Fixture - Heartbeat Log` job's step directly in `msdb`,
the way a DBA would in SSMS. Within about 15 seconds that job shows a **drift**
badge, and its Versions tab has a new `on-premise edit` version with a diff of
the changed step body.

To put it back for another take:

```bash
docker compose -f deploy/docker-compose.demo.yml run --rm drift-revert
```

## How it works

| Service | What it does |
|---|---|
| `certs` | One-shot. Writes a self-signed hub certificate, so the demo runs with TLS on rather than switching the check off. |
| `postgres` | Control-plane store. Not published to the host. |
| `sqlserver` | SQL Server 2022 Developer edition with SQL Server Agent enabled. |
| `seed` | One-shot. Applies [`deploy/sql-seed/seed.sql`](../deploy/sql-seed/seed.sql), the same fixtures as `pnpm dev:seed`. |
| `server` | The published control plane image, pinned to a release (currently `0.2.0`). Serves the dashboard on `:8080`. |
| `worker` | Runs from the same image, using the worker bundle it carries, so versions always match. On start it signs in as the bootstrap admin, mints an enrolment token through the same REST call the dashboard uses, enrols, then runs. Capped at `readOnly`. |
| `drift`, `drift-revert` | Profile-gated; only run when you ask. |

The worker keeps no state: its credential lives on a tmpfs, so every start
enrols afresh.

To try a different release: `RSAGENT_VERSION=0.2.1 docker compose -f deploy/docker-compose.demo.yml up`.

## Troubleshooting

- **`Exited (137)`**: out of memory. See Requirements.
- **Dashboard shows the instance as offline**: give it a minute after SQL Server
  turns healthy, then check `docker compose -f deploy/docker-compose.demo.yml logs worker`.
- **Run only one worker.** Two workers sharing a credential knock each other off
  in a loop. Stop any dev worker running on your host (`pnpm dev:worker`) first.
- **Port 8080 in use**: stop whatever holds it. The dashboard's public URL is
  fixed at `http://localhost:8080` in the demo.

## Clean up

```bash
docker compose -f deploy/docker-compose.demo.yml down -v
```

`-v` removes the volumes too, so the next `up` starts from nothing.
