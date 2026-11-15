#!/bin/sh
# Time the one-command demo stack and print a markdown table.
#
#   scripts/time-demo.sh            # run from anywhere; needs docker compose
#
# Measures, from `docker compose up -d`:
#   - seconds until sqlserver, postgres and server report healthy and the
#     one-shots (certs, seed) have exited 0
#   - seconds until the worker logs "[demo] worker starting." (enrolled)
#   - peak memory per container and peak total, sampled with `docker stats`
# then tears the stack down (`down -v`), including on Ctrl-C or timeout.
#
# Run it on an amd64 host or Apple Silicon with Rosetta enabled in Docker
# Desktop: SQL Server will not start under plain QEMU.
#
# Environment:
#   RSAGENT_VERSION   image tag for the control plane (compose default applies)
#   TIMEOUT           give up after this many seconds (default 300)
#   SAMPLE_INTERVAL   seconds between `docker stats` samples (default 5)
#
# No network beyond image pulls. Pulls happen first and are NOT timed, so the
# numbers are for a warm image cache. Existing demo volumes are removed first
# so every run is a cold first start.

set -u

TIMEOUT="${TIMEOUT:-300}"
SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-5}"

here="$(cd "$(dirname "$0")" && pwd)" || exit 1
compose_file="$here/../deploy/docker-compose.demo.yml"
[ -f "$compose_file" ] || { echo "cannot find $compose_file" >&2; exit 1; }

dc() { docker compose -f "$compose_file" "$@"; }

command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin not found" >&2; exit 1; }

work="$(mktemp -d)" || exit 1
samples="$work/samples"
: >"$samples"
sampler_pid=""

cleanup() {
  if [ -n "$sampler_pid" ]; then
    kill "$sampler_pid" 2>/dev/null
    wait "$sampler_pid" 2>/dev/null
    sampler_pid=""
  fi
  dc down -v >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

now() { date +%s; }

# health <service>: prints the health status, or the run state if no healthcheck.
health() {
  cid="$(dc ps -a -q "$1" 2>/dev/null | head -n 1)"
  [ -n "$cid" ] || { echo none; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo none
}

# exited_ok <service>: true if the one-shot exited with code 0.
exited_ok() {
  cid="$(dc ps -a -q "$1" 2>/dev/null | head -n 1)"
  [ -n "$cid" ] || return 1
  [ "$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$cid" 2>/dev/null)" = "exited 0" ]
}

# Sampler: one line per container per tick: "<epoch> <name> <MiB>".
sample_loop() {
  while :; do
    t="$(now)"
    docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' 2>/dev/null |
      awk -v t="$t" '
        $1 !~ /rsagent-demo/ { next }
        {
          v = $2; u = v; gsub(/[0-9.]/, "", u); sub(/[A-Za-z]+$/, "", v)
          m = v + 0
          if (u == "GiB") m = m * 1024
          else if (u == "KiB") m = m / 1024
          else if (u == "B") m = m / 1048576
          printf "%s %s %.1f\n", t, $1, m
        }' >>"$samples"
    sleep "$SAMPLE_INTERVAL"
  done
}

echo "Resetting any previous demo stack..." >&2
dc down -v >/dev/null 2>&1

echo "Pulling images (not timed)..." >&2
dc pull -q >&2 || { echo "image pull failed" >&2; exit 1; }

echo "Starting the stack..." >&2
start="$(now)"
sample_loop &
sampler_pid=$!
dc up -d >&2 || { echo "docker compose up failed (SQL Server needs amd64 or Rosetta)" >&2; exit 1; }

healthy_at=""
enrolled_at=""
while :; do
  t="$(now)"
  elapsed=$((t - start))
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "Timed out after ${TIMEOUT}s. Service state:" >&2
    dc ps -a >&2
    exit 2
  fi
  if [ -z "$healthy_at" ] &&
    [ "$(health sqlserver)" = healthy ] &&
    [ "$(health postgres)" = healthy ] &&
    [ "$(health server)" = healthy ] &&
    exited_ok certs && exited_ok seed; then
    healthy_at="$elapsed"
  fi
  if [ -z "$enrolled_at" ] && dc logs worker 2>/dev/null | grep -q '\[demo\] worker starting\.'; then
    enrolled_at="$elapsed"
  fi
  [ -n "$healthy_at" ] && [ -n "$enrolled_at" ] && break
  sleep 1
done

# Let the sampler catch the steady state after enrolment.
sleep "$SAMPLE_INTERVAL"
kill "$sampler_pid" 2>/dev/null
wait "$sampler_pid" 2>/dev/null
sampler_pid=""

arch="$(uname -m)"
echo
echo "### Demo start-up timing"
echo
echo "Host: $(uname -s) $arch, docker $(docker version -f '{{.Server.Version}}' 2>/dev/null || echo unknown). Warm image cache, cold volumes."
echo
echo "| Measure | Value |"
echo "| --- | --- |"
echo "| Seconds to all healthy (certs, seed done; sqlserver, postgres, server healthy) | $healthy_at |"
echo "| Seconds to worker enrolled (\"worker starting\" logged) | $enrolled_at |"
awk '
  { k = $1 " " $2; tot[$1] += $3; if ($3 > peak[$2]) peak[$2] = $3 }
  END {
    for (t in tot) if (tot[t] > pt) pt = tot[t]
    printf "| Peak total memory, all containers (MiB) | %.0f |\n", pt
  }' "$samples"
echo
echo "| Container | Peak memory (MiB) |"
echo "| --- | --- |"
awk '{ if ($3 > peak[$2]) peak[$2] = $3 }
  END { for (n in peak) printf "| %s | %.0f |\n", n, peak[n] }' "$samples" | sort

echo
echo "Tearing down..." >&2
