#!/usr/bin/env bash
#
# Host-side updater. Watches a directory the panel can write to, and applies
# the update the panel asked for.
#
# The panel deliberately has no access to Docker or to this checkout: a hole in
# a web endpoint must not become root on the machine that runs every customer's
# server. So the panel writes a request, and this — running on the host, as a
# service an operator installed on purpose — decides whether to honour it.
#
#   ./scripts/storm-updater.sh --once     # process a pending request, then exit
#   ./scripts/storm-updater.sh --install  # install the systemd service
#
# See docs/DEPLOYMENT.md.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_DIR="${STORM_CONTROL_DIR:-/var/lib/storm/control}"
INTERVAL="${STORM_UPDATER_INTERVAL:-15}"
REQUEST="${CONTROL_DIR}/request.json"
STATUS="${CONTROL_DIR}/status.json"

log() { printf '%s storm-updater: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

json_field() {
  # Small and dependency-free: the request is written by the panel and has a
  # known shape, so a full JSON parser would be more moving parts than value.
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -1
}

write_status() {
  local state="$1" message="$2"
  local commit requested_by requested_at id
  commit="$(json_field requestedCommit "$REQUEST" 2>/dev/null || echo '')"
  requested_by="$(json_field requestedBy "$REQUEST" 2>/dev/null || echo '')"
  requested_at="$(json_field requestedAt "$REQUEST" 2>/dev/null || echo '')"
  id="$(json_field id "$REQUEST" 2>/dev/null || echo 'unknown')"

  cat > "${STATUS}.tmp" <<JSON
{
  "id": "${id}",
  "state": "${state}",
  "requestedCommit": "${commit}",
  "requestedBy": "${requested_by}",
  "requestedAt": "${requested_at}",
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "message": "${message//\"/\'}"
}
JSON
  mv "${STATUS}.tmp" "$STATUS"
}

process_request() {
  [[ -f "$REQUEST" ]] || return 0

  local commit
  commit="$(json_field requestedCommit "$REQUEST")"

  # Anything that is not a commit id is not something to hand to git.
  if [[ ! "$commit" =~ ^[0-9a-f]{7,40}$ ]]; then
    log "ignoring a request with a malformed commit: ${commit}"
    write_status failed "The requested commit is malformed."
    rm -f "$REQUEST"
    return 0
  fi

  log "applying ${commit}, requested by $(json_field requestedBy "$REQUEST")"
  write_status running "Update in progress."

  # Take the request away first: a crash mid-update must not leave a request
  # that gets retried in a loop.
  rm -f "$REQUEST"

  cd "$REPO_DIR"

  local output
  if output=$(STORM_COMMIT="$commit" bash scripts/update.sh 2>&1); then
    log "update finished"
    write_status succeeded "Updated to ${commit:0:7}."
  else
    log "update failed"
    printf '%s\n' "$output" | tail -20 | sed 's/^/  /'
    write_status failed "$(printf '%s' "$output" | tail -3 | tr '\n' ' ')"
  fi
}

install_service() {
  [[ $EUID -eq 0 ]] || { echo "Run --install as root." >&2; exit 1; }

  install -d -m 0770 "$CONTROL_DIR"
  # The API container runs as uid 1001; it must be able to write the request
  # and read the status, and nothing more.
  chown root:1001 "$CONTROL_DIR" 2>/dev/null || chgrp 1001 "$CONTROL_DIR" || true

  cat > /etc/systemd/system/storm-updater.service <<UNIT
[Unit]
Description=Storm Panel updater
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
Environment=STORM_CONTROL_DIR=${CONTROL_DIR}
ExecStart=${REPO_DIR}/scripts/storm-updater.sh
Restart=always
RestartSec=10

# It rebuilds containers, so it cannot be locked down the way the agent is —
# but it can still be kept away from everything it does not need.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now storm-updater
  echo "Installed. Add this to .env and restart the API:"
  echo
  echo "  UPDATE_CONTROL_DIR=/var/lib/storm/control"
  echo
  echo "and mount it into the api service in docker-compose.yml:"
  echo
  echo "  volumes:"
  echo "    - ${CONTROL_DIR}:/var/lib/storm/control"
}

case "${1:-}" in
  --install) install_service; exit 0 ;;
  --once)    mkdir -p "$CONTROL_DIR"; process_request; exit 0 ;;
  --help|-h) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  '')        ;;
  *)         echo "Unknown option: $1" >&2; exit 1 ;;
esac

mkdir -p "$CONTROL_DIR"
log "watching ${CONTROL_DIR} every ${INTERVAL}s"
while true; do
  process_request
  sleep "$INTERVAL"
done
