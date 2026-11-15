#!/bin/sh
# Add the pinned Node runtime and WinSW to an assembled Windows worker package.
#
#   deploy/worker/fetch-windows-runtime.sh packages/worker/dist/package
#
# Run after `pnpm --filter @remote-sql-agent/worker package -- --no-runtime`.
# Used by both release.yml and deploy/Dockerfile, so the zip attached to a
# release and the one the control plane serves at /downloads/ carry the same
# runtime. The pins live here, once; two copies would drift, and the symptom is
# a Windows host running a different Node depending on where it got the zip.
#
# Needs curl, unzip and sha256sum. Nothing here is Windows-specific: the zip is
# a bundle plus downloaded binaries, not a single-file executable, so a Linux
# host can assemble it.
set -eu

PKG_DIR="${1:?usage: fetch-windows-runtime.sh <package-dir>}"

# Node 24 LTS. Keep in step with NODE_VERSION in release.yml.
NODE_FULL="v24.18.1"

# WinSW publishes no checksum of its own, so this digest was taken from the
# asset itself (size 18,243,033, matching the GitHub API's record for the tag).
# Trust-on-first-use: it does not prove the original is honest, but it freezes
# it — a re-tagged release, a substituted asset or a compromised CDN fail the
# build instead of shipping quietly to every Windows SQL host.
WINSW_VERSION="v2.12.0"
WINSW_SHA256="05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"

[ -f "$PKG_DIR/rsagent-worker.mjs" ] || {
  echo "fetch-windows-runtime: $PKG_DIR has no rsagent-worker.mjs; run the worker package script first" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Verified against nodejs.org's own SHASUMS256.txt rather than trusted because
# it arrived over TLS. This binary is installed as a service on a database
# server; "the download succeeded" is not the same claim as "the download is
# what Node published".
ARCHIVE="node-${NODE_FULL}-win-x64.zip"
curl -fsSL "https://nodejs.org/dist/${NODE_FULL}/${ARCHIVE}" -o "$WORK/$ARCHIVE"
curl -fsSL "https://nodejs.org/dist/${NODE_FULL}/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
(cd "$WORK" && grep " ${ARCHIVE}\$" SHASUMS256.txt | sha256sum -c -)
unzip -q "$WORK/$ARCHIVE" -d "$WORK"
mkdir -p "$PKG_DIR/node"
cp "$WORK/node-${NODE_FULL}-win-x64/node.exe" "$PKG_DIR/node/"
cp "$WORK/node-${NODE_FULL}-win-x64/LICENSE"  "$PKG_DIR/node/"

curl -fsSL "https://github.com/winsw/winsw/releases/download/${WINSW_VERSION}/WinSW-x64.exe" \
  -o "$PKG_DIR/rsagent-worker.exe"
echo "${WINSW_SHA256}  $PKG_DIR/rsagent-worker.exe" | sha256sum -c -
