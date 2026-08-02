#!/usr/bin/env bash
#
# Set up the Remote SQL Agent control plane on any host with Docker.
#
#   mkdir -p rsagent && cd rsagent
#   curl -fsSLO https://raw.githubusercontent.com/semics-tech/remote-sql-agent/main/deploy/setup.sh
#   chmod +x setup.sh && ./setup.sh
#
# Or non-interactively, e.g. from cloud-init:
#
#   ./setup.sh --domain rsagent.corp.example.com
#
# Fetches docker-compose.yml and the Caddyfile, writes .env, issues a
# self-signed certificate for the worker hub, and brings the stack up with
# Let's Encrypt HTTPS for the dashboard.
#
# This assumes a public DNS name that Let's Encrypt can reach on ports 80 and
# 443 — Route A in docs/deployment.md. A deployment with no public DNS (an
# internal-only estate) still follows the manual TLS steps there; this script
# does not attempt that path.
#
# Safe to re-run: it only writes docker-compose.yml, Caddyfile, .env.example,
# tls/server.crt and .env once each, and leaves any of them that already exist
# untouched.

set -euo pipefail

DOMAIN=""
VERSION="0.2.0"
REF="main"

die() { printf '\nError: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: setup.sh [--domain HOST] [--version X.Y.Z] [--ref REF]

  --domain HOST    Public DNS name for the control plane, already pointing
                    here (e.g. rsagent.corp.example.com). Prompted for if
                    omitted and this is an interactive terminal.
  --version X.Y.Z   Control plane image tag to pin. Default: 0.2.0.
                    https://github.com/semics-tech/remote-sql-agent/releases
  --ref REF         Revision to fetch docker-compose.yml/Caddyfile from.
                    Default: main.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)  DOMAIN="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --ref)     REF="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)         die "Unknown option: $1" ;;
  esac
done

command -v docker >/dev/null || die "Docker is required: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 \
  || die "The Docker Compose plugin is required: https://docs.docker.com/compose/install/"
command -v openssl >/dev/null || die "openssl is required."
command -v curl >/dev/null || die "curl is required."

if [[ -z "$DOMAIN" ]]; then
  if [[ -t 0 ]]; then
    read -rp "Public DNS name for the control plane (e.g. rsagent.corp.example.com): " DOMAIN
  fi
  [[ -n "$DOMAIN" ]] \
    || { usage; die "--domain is required (or run this from a terminal so it can ask)."; }
fi

echo "Fetching deploy files from ${REF}..."
RAW="https://raw.githubusercontent.com/semics-tech/remote-sql-agent/${REF}/deploy"
for f in docker-compose.yml Caddyfile .env.example; do
  [[ -f "$f" ]] || curl -fsSL "${RAW}/${f}" -o "$f"
done

# A self-signed certificate for the worker hub, valid for the same name.
#
# Caddy's certificate cannot be reused for this: the hub reads PEM files once
# at startup and grpc-js cannot swap credentials on a bound server, so it
# would serve an expired certificate from roughly day 60 of every 90-day
# cycle — total and silent, hitting every worker at once a month after the
# dashboard visibly renewed.
#
# Self-signed is a real posture here, not a placeholder: workers pin it with
# --ca-cert / -CaCertPath, which is stronger than trusting any public CA.
# Replace it with your estate's own CA if you have one.
if [[ ! -f tls/server.crt ]]; then
  echo "Issuing a self-signed certificate for the worker hub..."
  mkdir -p tls
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout tls/server.key -out tls/server.crt \
    -subj "/CN=${DOMAIN}" \
    -addext "subjectAltName=DNS:${DOMAIN}"
  chmod 640 tls/server.key
fi

if [[ ! -f .env ]]; then
  # Appended rather than edited in place: Compose takes the last definition of
  # a key, so these override the placeholders in the example file and the
  # example stays readable as documentation.
  cp .env.example .env
  # Generated, never defaulted: a fixed password in a file everyone can copy
  # is the same as no password.
  #
  # Alphanumeric only, because this is interpolated into a postgres:// URL in
  # docker-compose.yml — a '/' or '@' from base64 would truncate it and the
  # failure would look like wrong credentials. Drawing 48 bytes leaves enough
  # after filtering to always reach 40 characters.
  POSTGRES_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"
  {
    echo ""
    echo "# --- written by setup.sh ---"
    echo "RSAGENT_PUBLIC_URL=https://${DOMAIN}"
    echo "RSAGENT_DOMAIN=${DOMAIN}"
    echo "RSAGENT_VERSION=${VERSION}"
    echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
    # Caddy is the one proxy in front of the API.
    echo "RSAGENT_TRUSTED_PROXY_HOPS=1"
    # Reachable only through Caddy, so the dashboard is never also served over
    # plain HTTP — where the browser refuses to encrypt credentials.
    echo "RSAGENT_HTTP_BIND=127.0.0.1"
  } >> .env
  chmod 600 .env  # it holds the database password
fi

echo "Starting the control plane..."
docker compose --profile tls up -d

cat <<BANNER

Control plane starting on https://${DOMAIN}

  Bootstrap password (printed once, in the log):
    docker compose logs server | grep -i password

  Workers need this certificate, because it is self-signed:
    $(pwd)/tls/server.crt
    curl .../install.sh | sudo bash -s -- --ca-cert ...   (-CaCertPath on Windows)

  Next: sign in, then Administration > Workers to enrol one.

  Still to do: back up the Postgres volume, and set up audit export.
  See docs/deployment.md and docs/security.md.

BANNER
