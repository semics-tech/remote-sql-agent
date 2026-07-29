#!/usr/bin/env bash
#
# One-line installer for the Remote SQL Agent worker on Linux.
#
# Served by the control plane at /install.sh and normally run as:
#
#   curl -fsSL https://rsagent.corp.example.com/install.sh | sudo bash -s -- \
#        --control-plane rsagent.corp.example.com:8443 --token rsen_...
#
# The package comes from the control plane rather than the internet: a SQL
# Server host in a segmented network can always reach the control plane — it is
# about to connect to it — and usually cannot reach GitHub.
#
# The worker connects OUTBOUND ONLY. Nothing listens on this host.
#
# No SQL credentials are asked for here. The worker enrols with nothing to
# monitor; an administrator says which instances to watch from the dashboard,
# and any password they supply is encrypted in their browser to a key this host
# generates at enrolment. The control plane relays a credential it cannot read.

set -euo pipefail

CONTROL_PLANE=""
TOKEN=""
MAX_CAPABILITY="readOnly"
PACKAGE_URL=""
INSTALL_DIR="/opt/rsagent"
CONFIG_DIR="/etc/rsagent"
STATE_DIR="/var/lib/rsagent"
SERVICE_USER="rsagent"
CA_CERT_PATH=""

die() { printf '\nError: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: install.sh --control-plane HOST:PORT --token TOKEN [options]

  --control-plane HOST:PORT   Worker hub address (required)
  --token TOKEN               Single-use enrolment token (required)
  --max-capability TIER       readOnly | operate | schedule | full (default: readOnly)
  --package-url URL           Override where the worker package is fetched from
  --install-dir DIR           Default: /opt/rsagent
  --ca-cert PATH              Pin a private CA for the hub's TLS certificate
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --control-plane)  CONTROL_PLANE="${2:-}"; shift 2 ;;
    --token)          TOKEN="${2:-}"; shift 2 ;;
    --max-capability) MAX_CAPABILITY="${2:-}"; shift 2 ;;
    --package-url)    PACKAGE_URL="${2:-}"; shift 2 ;;
    --install-dir)    INSTALL_DIR="${2:-}"; shift 2 ;;
    --ca-cert)        CA_CERT_PATH="${2:-}"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "Unknown option: $1" ;;
  esac
done

[[ -n "$CONTROL_PLANE" ]] || { usage; die "--control-plane is required."; }
[[ -n "$TOKEN" ]] || { usage; die "--token is required."; }
[[ "$(id -u)" -eq 0 ]] || die "Run this with sudo: installing a systemd unit needs root."

case "$MAX_CAPABILITY" in
  readOnly|operate|schedule|full) ;;
  *) die "--max-capability must be one of: readOnly, operate, schedule, full" ;;
esac

command -v curl >/dev/null || die "curl is required."
command -v tar  >/dev/null || die "tar is required."

HUB_HOST="${CONTROL_PLANE%%:*}"
[[ -n "$PACKAGE_URL" ]] || PACKAGE_URL="https://${HUB_HOST}/downloads/rsagent-worker-linux.tar.gz"

# Node is a hard requirement and the version matters: the worker uses APIs that
# are not in 20. Say so precisely rather than failing later inside the service.
if ! command -v node >/dev/null; then
  die "Node.js 22 or newer is required and was not found on PATH."
fi
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node.js 22 or newer is required; found $(node -v)."

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "Downloading the worker package from $PACKAGE_URL"
if ! curl -fsSL "$PACKAGE_URL" -o "$STAGING/worker.tar.gz"; then
  die "Could not download $PACKAGE_URL
If the control plane is served over plain HTTP or on a non-standard port, pass
it explicitly, for example:
  --package-url http://${HUB_HOST}:8080/downloads/rsagent-worker-linux.tar.gz"
fi

tar -xzf "$STAGING/worker.tar.gz" -C "$STAGING"
WORKER_BUNDLE="$(find "$STAGING" -name 'rsagent-worker.mjs' -print -quit)"
[[ -n "$WORKER_BUNDLE" ]] || die "The downloaded package does not contain rsagent-worker.mjs."

# --- Service account and directories -----------------------------------------
#
# A dedicated unprivileged account, because the worker holds the private key
# that SQL credentials are encrypted to. Anything that can read that key can
# read this host's SQL password.

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 0755 "$INSTALL_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$CONFIG_DIR"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
install -m 0755 "$WORKER_BUNDLE" "$INSTALL_DIR/rsagent-worker.mjs"

# --- Configuration ------------------------------------------------------------
#
# Deliberately no `instances:` block. The worker enrols with nothing to monitor
# and is told what to watch from the dashboard, so nobody hand-edits YAML on
# fifty hosts.

if [[ -f "$CONFIG_DIR/worker.yaml" ]]; then
  echo "Keeping the existing $CONFIG_DIR/worker.yaml"
else
  cat > "$CONFIG_DIR/worker.yaml" <<YAML
# Remote SQL Agent worker.
# Instances are configured from the dashboard, not here.

hostName: $(hostname -s)

controlPlane:
  address: ${CONTROL_PLANE}
  auth:
    mode: token
    keyFile: ${STATE_DIR}/worker.key
  tls:
    enabled: true$( [[ -n "$CA_CERT_PATH" ]] && printf '\n    caCertPath: %s' "$CA_CERT_PATH" )

# The local ceiling. The control plane can grant less than this, never more.
maxCapability: ${MAX_CAPABILITY}

outbox:
  path: ${STATE_DIR}/outbox.db
YAML
  chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/worker.yaml"
  chmod 0640 "$CONFIG_DIR/worker.yaml"
fi

# --- Enrol --------------------------------------------------------------------
#
# Run as the service account so the credential key and worker key are written
# with the ownership the service will later need.

echo "Enrolling with $CONTROL_PLANE"
runuser -u "$SERVICE_USER" -- \
  node "$INSTALL_DIR/rsagent-worker.mjs" enrol --token "$TOKEN" "$CONFIG_DIR/worker.yaml" \
  || die "Enrolment failed. Tokens are single-use, expire after an hour, and are bound to a host name — generate a fresh one if in doubt."

# --- systemd ------------------------------------------------------------------

UNIT_SOURCE="$(find "$STAGING" -name 'rsagent-worker.service' -print -quit)"
if [[ -n "$UNIT_SOURCE" ]]; then
  install -m 0644 "$UNIT_SOURCE" /etc/systemd/system/rsagent-worker.service
else
  cat > /etc/systemd/system/rsagent-worker.service <<UNIT
[Unit]
Description=Remote SQL Agent worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=/usr/bin/env node ${INSTALL_DIR}/rsagent-worker.mjs ${CONFIG_DIR}/worker.yaml
Restart=always
RestartSec=10

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${STATE_DIR}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
UNIT
fi

systemctl daemon-reload
systemctl enable --now rsagent-worker.service

cat <<DONE

Worker installed and enrolled.

  Service:  systemctl status rsagent-worker
  Logs:     journalctl -u rsagent-worker -f
  Config:   ${CONFIG_DIR}/worker.yaml
  Ceiling:  ${MAX_CAPABILITY}

Next: open the dashboard and tell this worker which SQL instances to monitor.
It is connected but idle until you do.
DONE
