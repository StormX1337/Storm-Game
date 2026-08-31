#!/usr/bin/env bash
#
# Storm Node Agent installer.
#
#   curl -fsSL https://panel.example.com/install/node.sh | sudo bash
#
# Or, non-interactively, with the values from `storm node create`:
#
#   sudo ./install-node.sh \
#     --panel-url https://panel.example.com \
#     --node-uuid <uuid> --token-id <id> --token <token> --secret <secret>
#
# Targets Ubuntu 22.04+/24.04+ and Debian 12+.

set -euo pipefail

readonly STORM_VERSION="1.0.0"
readonly INSTALL_DIR="/opt/storm-agent"
readonly CONFIG_DIR="/etc/storm"
readonly DATA_DIR="/var/lib/storm/servers"
readonly BACKUP_DIR="/var/lib/storm/backups"
readonly SERVICE_NAME="storm-agent"
readonly REQUIRED_NODE_MAJOR=20

ESC=$'\033'
BOLD="${ESC}[1m"; DIM="${ESC}[2m"; RED="${ESC}[31m"; GREEN="${ESC}[32m"
YELLOW="${ESC}[33m"; BLUE="${ESC}[34m"; RESET="${ESC}[0m"

step()  { echo -e "\n${BOLD}==>${RESET} ${BOLD}$*${RESET}"; }
ok()    { echo -e "  ${GREEN}✔${RESET} $*"; }
warn()  { echo -e "  ${YELLOW}!${RESET} $*"; }
fail()  { echo -e "  ${RED}✖${RESET} $*" >&2; exit 1; }
info()  { echo -e "  ${DIM}$*${RESET}"; }

# Flags win, then the environment, then a prompt. Prefer the environment for
# the secrets: a flag is visible to anyone who can run `ps` while the installer
# is working.
PANEL_URL="${STORM_PANEL_URL:-}"
NODE_UUID="${STORM_NODE_UUID:-}"
TOKEN_ID="${STORM_TOKEN_ID:-}"
TOKEN="${STORM_TOKEN:-}"
SECRET="${STORM_SECRET:-}"
AGENT_PORT="${STORM_AGENT_PORT:-8081}"
SFTP_PORT="${STORM_SFTP_PORT:-2022}"
SKIP_DOCKER=0
ASSUME_YES=0
CONFIG_FILE="${STORM_CONFIG_FILE:-}"

usage() {
  cat <<USAGE
Storm Node Agent installer ${STORM_VERSION}

Options:
  --panel-url <url>     Panel URL the agent reports to        (required)
  --node-uuid <uuid>    Node UUID from the panel              (required)
  --token-id <id>       AGENT_TOKEN_ID                        (required)
  --token <token>       AGENT_TOKEN                           (required)
  --secret <secret>     AGENT_SECRET                          (required)
  --agent-port <port>   Port the agent listens on             (default 8081)
  --sftp-port <port>    Port the SFTP server listens on       (default 2022)
  --config <file>       Read the values from a downloaded agent.env
  --skip-docker         Do not install or configure Docker
  --yes                 Do not prompt for confirmation
  --help                Show this message

Every option can also be supplied through the environment, which keeps the
secrets out of the process list:

  STORM_PANEL_URL  STORM_NODE_UUID  STORM_TOKEN_ID  STORM_TOKEN  STORM_SECRET
  STORM_AGENT_PORT  STORM_SFTP_PORT

Values other than --panel-url come from the panel: Admin -> Nodes -> Agent
configuration, or the CLI command "storm node create".

The panel offers that configuration as a file. Put it at /etc/storm/agent.env
before running this, or point --config at it, and nothing needs typing.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --panel-url)  PANEL_URL="${2:-}"; shift 2 ;;
    --node-uuid)  NODE_UUID="${2:-}"; shift 2 ;;
    --token-id)   TOKEN_ID="${2:-}"; shift 2 ;;
    --token)      TOKEN="${2:-}"; shift 2 ;;
    --secret)     SECRET="${2:-}"; shift 2 ;;
    --agent-port) AGENT_PORT="${2:-}"; shift 2 ;;
    --sftp-port)  SFTP_PORT="${2:-}"; shift 2 ;;
    --config)     CONFIG_FILE="${2:-}"; shift 2 ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --help|-h)    usage; exit 0 ;;
    *)            fail "Unknown option: $1 (try --help)" ;;
  esac
done

echo -e "${BOLD}${BLUE}"
cat <<'BANNER'
   ______ __
  / __/ /____  ______ ___
 _\ \/ __/ _ \/ __/  ' \
/___/\__/\___/_/ /_/_/_/   Node Agent
BANNER
echo -e "${RESET}${DIM}  version ${STORM_VERSION}${RESET}"

# ------------------------------------------------------------ preflight --

step "Checking the system"

[[ $EUID -eq 0 ]] || fail "This installer must run as root (use sudo)."

[[ -f /etc/os-release ]] || fail "Cannot identify this operating system."
# shellcheck disable=SC1091
. /etc/os-release

case "${ID}" in
  ubuntu)
    MAJOR="${VERSION_ID%%.*}"
    (( MAJOR >= 22 )) || fail "Ubuntu ${VERSION_ID} is not supported (need 22.04 or newer)."
    ;;
  debian)
    MAJOR="${VERSION_ID%%.*}"
    (( MAJOR >= 12 )) || fail "Debian ${VERSION_ID} is not supported (need 12 or newer)."
    ;;
  *)
    warn "${PRETTY_NAME} is untested. Continuing, but you are off the map."
    ;;
esac
ok "${PRETTY_NAME}"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64) ok "Architecture ${ARCH}" ;;
  *) fail "Unsupported architecture: ${ARCH}" ;;
esac

if ! ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 && ! curl -fsS --max-time 5 https://deb.debian.org >/dev/null 2>&1; then
  warn "Outbound network looks unreachable; package installation may fail."
fi

# --------------------------------------------------------- configuration --

step "Collecting configuration"

# The panel hands out a ready-made agent.env, and its own dialog tells people to
# save it at /etc/storm/agent.env. Reading it here is what makes that true:
# without this the installer prompted for values the operator had already put on
# the machine, and then overwrote the file with what they retyped.
read_config_file() {
  local file="$1"
  [[ -r "$file" ]] || return 1

  local key value
  while IFS='=' read -r key value; do
    # A file downloaded through a browser on Windows arrives with CRLF, and a
    # trailing \r turns PANEL_URL into a host that does not resolve and the
    # token into one that does not match — both failing much later, with an
    # error that points nowhere near the cause.
    key="${key%%[[:space:]]*}"
    value="${value%$'\r'}"
    [[ -z "$key" || "$key" == \#* ]] && continue
    # Values the panel writes are unquoted, but tolerate quotes anyway.
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"

    case "$key" in
      PANEL_URL)      [[ -z "$PANEL_URL"  ]] && PANEL_URL="$value" ;;
      NODE_UUID)      [[ -z "$NODE_UUID"  ]] && NODE_UUID="$value" ;;
      AGENT_TOKEN_ID) [[ -z "$TOKEN_ID"   ]] && TOKEN_ID="$value" ;;
      AGENT_TOKEN)    [[ -z "$TOKEN"      ]] && TOKEN="$value" ;;
      AGENT_SECRET)   [[ -z "$SECRET"     ]] && SECRET="$value" ;;
      AGENT_PORT)     AGENT_PORT="${AGENT_PORT:-$value}" ;;
      SFTP_PORT)      SFTP_PORT="${SFTP_PORT:-$value}" ;;
    esac
  done < "$file"
  return 0
}

if [[ -n "$CONFIG_FILE" ]]; then
  read_config_file "$CONFIG_FILE" || fail "Cannot read ${CONFIG_FILE}"
  ok "Read ${CONFIG_FILE}"
elif read_config_file "${CONFIG_DIR}/agent.env"; then
  ok "Read the configuration already at ${CONFIG_DIR}/agent.env"
fi

prompt_for() {
  local var="$1" label="$2" secret="${3:-0}"
  local value="${!var}"
  if [[ -n "$value" ]]; then return; fi

  if [[ ! -t 0 ]]; then
    fail "${label} is required. Pass it as a flag when running non-interactively."
  fi
  if [[ "$secret" == "1" ]]; then
    read -rsp "  ${label}: " value; echo
  else
    read -rp "  ${label}: " value
  fi
  printf -v "$var" '%s' "$value"
}

prompt_for PANEL_URL "Panel URL (https://panel.example.com)"
prompt_for NODE_UUID "Node UUID"
prompt_for TOKEN_ID  "Agent token ID"
prompt_for TOKEN     "Agent token" 1
prompt_for SECRET    "Agent secret" 1

PANEL_URL="${PANEL_URL%/}"
[[ "$PANEL_URL" =~ ^https?:// ]] || fail "Panel URL must start with http:// or https://"
[[ "$NODE_UUID" =~ ^[0-9a-fA-F-]{36}$ ]] || fail "Node UUID does not look like a UUID."
[[ -n "$TOKEN_ID" && -n "$TOKEN" && -n "$SECRET" ]] || fail "Token values cannot be empty."

ok "Panel: ${PANEL_URL}"
ok "Node:  ${NODE_UUID}"

if [[ $ASSUME_YES -eq 0 && -t 0 ]]; then
  echo
  read -rp "  Install the Storm Node Agent on this machine? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

# ------------------------------------------------------------ packages --

step "Installing dependencies"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg tar unzip xz-utils \
  iproute2 procps openssl jq >/dev/null
ok "Base packages"

# ------------------------------------------------------------- docker --

if [[ $SKIP_DOCKER -eq 1 ]]; then
  warn "Skipping Docker installation as requested"
elif command -v docker >/dev/null 2>&1; then
  ok "Docker already installed ($(docker --version | cut -d, -f1))"
else
  step "Installing Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
  ok "Docker installed"
fi

if [[ $SKIP_DOCKER -eq 0 ]]; then
  systemctl is-active --quiet docker || systemctl start docker
  docker info >/dev/null 2>&1 || fail "Docker is installed but not responding."
  ok "Docker daemon is responding"

  # A dedicated bridge with inter-container communication disabled keeps one
  # customer's server from reaching another's over the shared network.
  if ! docker network inspect storm_net >/dev/null 2>&1; then
    docker network create --driver bridge \
      --opt com.docker.network.bridge.enable_icc=false storm_net >/dev/null
    ok "Created the storm_net Docker network"
  else
    ok "storm_net network already exists"
  fi
fi

# --------------------------------------------------------------- node --

install_nodejs() {
  step "Installing Node.js ${REQUIRED_NODE_MAJOR}"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  ok "Node.js $(node --version)"
}

if command -v node >/dev/null 2>&1; then
  CURRENT_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if (( CURRENT_MAJOR >= REQUIRED_NODE_MAJOR )); then
    ok "Node.js $(node --version) already installed"
  else
    warn "Node.js $(node --version) is too old"
    install_nodejs
  fi
else
  install_nodejs
fi

# ---------------------------------------------------------- directories --

step "Creating directories"

install -d -m 0755 "$INSTALL_DIR"
install -d -m 0700 "$CONFIG_DIR"      # holds the agent token and host key
install -d -m 0755 "$DATA_DIR"
install -d -m 0700 "$BACKUP_DIR"
ok "$INSTALL_DIR, $CONFIG_DIR, $DATA_DIR, $BACKUP_DIR"

# ---------------------------------------------------------------- agent --

step "Installing the agent"

# The agent bundle is served by the panel alongside this script, so the agent
# always matches the panel that issued the token.
BUNDLE_URL="${PANEL_URL}/install/storm-agent.tar.gz"
TMP_BUNDLE="$(mktemp -d)/agent.tar.gz"

if curl -fsSL --max-time 120 -o "$TMP_BUNDLE" "$BUNDLE_URL" 2>/dev/null; then
  tar -xzf "$TMP_BUNDLE" -C "$INSTALL_DIR"
  rm -rf "$(dirname "$TMP_BUNDLE")"
  ok "Agent downloaded from the panel"
elif [[ -d "$(dirname "${BASH_SOURCE[0]}")/../apps/node-agent" ]]; then
  # Running from a checkout: build in place instead of downloading.
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  warn "Panel bundle unavailable; building from ${REPO_ROOT}"
  command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10.33.0 >/dev/null 2>&1
  ( cd "$REPO_ROOT" \
    && pnpm install --frozen-lockfile >/dev/null \
    && pnpm --filter @storm/types build >/dev/null \
    && pnpm --filter @storm/config build >/dev/null \
    && pnpm --filter @storm/security build >/dev/null \
    && pnpm --filter @storm/node-agent build >/dev/null )
  cp -r "$REPO_ROOT"/{node_modules,packages,package.json,pnpm-workspace.yaml} "$INSTALL_DIR/"
  mkdir -p "$INSTALL_DIR/apps"
  cp -r "$REPO_ROOT/apps/node-agent" "$INSTALL_DIR/apps/"
  ok "Agent built from source"
else
  fail "Could not download the agent from ${BUNDLE_URL} and no source checkout was found."
fi

[[ -f "$INSTALL_DIR/apps/node-agent/dist/main.js" ]] \
  || fail "Agent bundle is missing apps/node-agent/dist/main.js"

# --------------------------------------------------------- configuration --

step "Writing configuration"

cat > "${CONFIG_DIR}/agent.env" <<CONFIG
# Storm Node Agent configuration
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by install-node.sh ${STORM_VERSION}
NODE_ENV=production
NODE_UUID=${NODE_UUID}
PANEL_URL=${PANEL_URL}

AGENT_HOST=0.0.0.0
AGENT_PORT=${AGENT_PORT}
AGENT_TOKEN_ID=${TOKEN_ID}
AGENT_TOKEN=${TOKEN}
AGENT_SECRET=${SECRET}

DATA_DIRECTORY=${DATA_DIR}
BACKUP_DIRECTORY=${BACKUP_DIR}
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_NETWORK=storm_net

SFTP_ENABLED=true
SFTP_PORT=${SFTP_PORT}
SFTP_HOST_KEY_PATH=${CONFIG_DIR}/sftp_host_key

HEARTBEAT_INTERVAL=20
CONSOLE_BUFFER_LINES=400
LOG_LEVEL=info

# Uncomment to serve the agent API over TLS (recommended in production):
# TLS_CERT_PATH=/etc/storm/tls/fullchain.pem
# TLS_KEY_PATH=/etc/storm/tls/privkey.pem
CONFIG

chmod 600 "${CONFIG_DIR}/agent.env"
ok "${CONFIG_DIR}/agent.env (permissions 600)"

# -------------------------------------------------------------- systemd --

step "Configuring systemd"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Storm Node Agent
Documentation=${PANEL_URL}
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
# The agent manages Docker and must chown files into the unprivileged uid
# that game containers run as, so it runs as root by design.
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${CONFIG_DIR}/agent.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/apps/node-agent/dist/main.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=storm-agent

# Hardening that is compatible with managing Docker and server files.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${DATA_DIR} ${BACKUP_DIR} ${CONFIG_DIR}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
ok "Service ${SERVICE_NAME} enabled"

# ---------------------------------------------------------------- start --

step "Starting the agent"

systemctl restart "${SERVICE_NAME}"

for attempt in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null 2>&1; then
    ok "Agent is responding on port ${AGENT_PORT}"
    break
  fi
  if (( attempt == 20 )); then
    echo
    journalctl -u "${SERVICE_NAME}" -n 30 --no-pager || true
    fail "Agent did not become healthy. The last 30 log lines are above."
  fi
  sleep 1
done

# ----------------------------------------------------------- verification --

step "Verifying connectivity"

if curl -fsS --max-time 10 "${PANEL_URL}/health" >/dev/null 2>&1; then
  ok "Panel is reachable from this node"
else
  warn "Could not reach ${PANEL_URL}/health from this node."
  warn "The agent will keep retrying; check DNS and firewall rules."
fi

HEALTH="$(curl -fsS "http://127.0.0.1:${AGENT_PORT}/health" 2>/dev/null || echo '{}')"
if command -v jq >/dev/null 2>&1 && [[ "$(echo "$HEALTH" | jq -r '.data.docker // false')" == "true" ]]; then
  ok "Agent can talk to Docker"
else
  warn "Agent reports it cannot reach the Docker socket."
fi

# ------------------------------------------------------------- firewall --

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  step "Firewall"
  warn "ufw is active. Allow the ports the panel and players need:"
  info "ufw allow ${AGENT_PORT}/tcp    # panel -> agent"
  info "ufw allow ${SFTP_PORT}/tcp     # SFTP"
  info "ufw allow 25565:25595/tcp  # example game port range"
fi

cat <<SUMMARY

${GREEN}${BOLD}Storm Node Agent is installed and running.${RESET}

  ${DIM}Service${RESET}      systemctl status ${SERVICE_NAME}
  ${DIM}Logs${RESET}         journalctl -u ${SERVICE_NAME} -f
  ${DIM}Config${RESET}       ${CONFIG_DIR}/agent.env
  ${DIM}Servers${RESET}      ${DATA_DIR}
  ${DIM}Backups${RESET}      ${BACKUP_DIR}
  ${DIM}Agent API${RESET}    http://0.0.0.0:${AGENT_PORT}
  ${DIM}SFTP${RESET}         port ${SFTP_PORT}

Next: open the panel, confirm the node shows as ${GREEN}online${RESET}, then add
port allocations to it before creating servers.

SUMMARY
