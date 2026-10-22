#!/bin/sh
# Demo only. Runs inside the control-plane image (it already carries Node and
# the matching worker bundle at /app/worker-packages), so the worker is always
# the same version as the server and nothing is downloaded.
#
# Stateless on purpose: everything lives on a tmpfs, so each start enrols afresh.
set -eu

RUN=/run/rsagent
PKG=/app/worker-packages/rsagent-worker-linux.tar.gz

tar -xzf "$PKG" -C "$RUN" ./rsagent-worker.mjs

echo "[demo] minting an enrolment token as the bootstrap admin..."
rc=0
TOKEN="$(node /demo/mint-token.mjs)" || rc=$?
if [ "$rc" -eq 78 ]; then
  # The server answered with a 4xx. Retrying cannot help and would only burn
  # the login rate limit, so exit 0 (compose's on-failure policy won't restart).
  echo "[demo] the control plane rejected the enrolment request (see above); not retrying." >&2
  exit 0
elif [ "$rc" -ne 0 ]; then
  exit "$rc"
fi

echo "[demo] enrolling ${RSAGENT_WORKER_HOST}..."
node "$RUN/rsagent-worker.mjs" enrol --token "$TOKEN" /demo/worker.demo.yaml

echo "[demo] worker starting."
exec node "$RUN/rsagent-worker.mjs" /demo/worker.demo.yaml
