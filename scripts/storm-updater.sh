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
HEARTBEAT="${CONTROL_DIR}/updater.json"

log() { printf '%s storm-updater: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

json_field() {
  # Small and dependency-free: the request is written by the panel and has a
  # known shape, so a full JSON parser would be more moving parts than value.
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -1
}

# Read out of the request once, by read_request, and held here — the request
# file is deleted before the update runs, so re-reading it for the final status
# would report an empty commit and an unknown job to the panel.
JOB_ID="unknown"
JOB_COMMIT=""
JOB_BY=""
JOB_AT=""

read_request() {
  JOB_ID="$(json_field id "$REQUEST" 2>/dev/null || echo 'unknown')"
  JOB_COMMIT="$(json_field requestedCommit "$REQUEST" 2>/dev/null || echo '')"
  JOB_BY="$(json_field requestedBy "$REQUEST" 2>/dev/null || echo '')"
  JOB_AT="$(json_field requestedAt "$REQUEST" 2>/dev/null || echo '')"
}

write_status() {
  local state="$1" message="$2"

  cat > "${STATUS}.tmp" <<JSON
{
  "id": "${JOB_ID}",
  "state": "${state}",
  "requestedCommit": "${JOB_COMMIT}",
  "requestedBy": "${JOB_BY}",
  "requestedAt": "${JOB_AT}",
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "message": "${message//\"/\'}"
}
JSON
  mv "${STATUS}.tmp" "$STATUS"
}

process_request() {
  [[ -f "$REQUEST" ]] || return 0

  read_request
  local commit="$JOB_COMMIT"

  # Anything that is not a commit id is not something to hand to git.
  if [[ ! "$commit" =~ ^[0-9a-f]{7,40}$ ]]; then
    log "ignoring a request with a malformed commit: ${commit}"
    write_status failed "The requested commit is malformed."
    rm -f "$REQUEST"
    return 0
  fi

  log "applying ${commit}, requested by ${JOB_BY}"
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
# systemd sets no HOME. update.sh puts its database dumps under it, so without
# this the service and a manual root run would disagree about where backups go.
Environment=HOME=/root
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

  # Compose already mounts this directory and already points the API at it, so
  # there is nothing to edit by hand — the API just has to be restarted to see
  # a directory that now exists and is writable.
  echo
  echo "Installed and running. One step left, from ${REPO_DIR}:"
  echo
  echo "  docker compose up -d api"
  echo
  echo "Admin -> Updates will then offer the button."
}

case "${1:-}" in
  --install) install_service; exit 0 ;;
  --once)    mkdir -p "$CONTROL_DIR"; process_request; exit 0 ;;
  --help|-h) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  '')        ;;
  *)         echo "Unknown option: $1" >&2; exit 1 ;;
esac

# The panel decides whether to offer the update button by whether this file is
# fresh. A mounted directory proves nothing — Docker creates one whether or not
# anybody installed an updater — so the signal has to come from a process that
# is actually running.
write_heartbeat() {
  cat > "${HEARTBEAT}.tmp" <<JSON
{
  "seenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "interval": ${INTERVAL},
  "repository": "${REPO_DIR}",
  "pid": $$
}
JSON
  mv "${HEARTBEAT}.tmp" "$HEARTBEAT"
}

mkdir -p "$CONTROL_DIR"
log "watching ${CONTROL_DIR} every ${INTERVAL}s"
trap 'rm -f "$HEARTBEAT"; exit 0' TERM INT
while true; do
  write_heartbeat
  process_request
  sleep "$INTERVAL"
done
