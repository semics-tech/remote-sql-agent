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
TOKEN="$(node /demo/mint-token.mjs)"

echo "[demo] enrolling ${RSAGENT_WORKER_HOST}..."
node "$RUN/rsagent-worker.mjs" enrol --token "$TOKEN" /demo/worker.demo.yaml

echo "[demo] worker starting."
exec node "$RUN/rsagent-worker.mjs" /demo/worker.demo.yaml
