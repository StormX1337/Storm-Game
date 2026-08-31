#!/usr/bin/env bash
#
# Updates a Compose deployment in place: back up, pull, rebuild, restart,
# and prove the result answers before walking away.
#
#   ./scripts/update.sh              # update to the latest commit
#   ./scripts/update.sh --check      # say what would change, touch nothing
#   ./scripts/update.sh --no-backup  # skip the database dump
#
# Game servers keep running throughout: they are containers on nodes, and
# nothing here stops them.

set -euo pipefail

ESC=$'\033'
BOLD="${ESC}[1m"; DIM="${ESC}[2m"; RED="${ESC}[31m"; GREEN="${ESC}[32m"
YELLOW="${ESC}[33m"; RESET="${ESC}[0m"

step() { printf '\n%s==>%s %s%s\n' "$BOLD" "$RESET" "$1" "$RESET"; }
ok()   { printf '  %s✔%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { printf '  %s✖%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

CHECK_ONLY=0
BACKUP=1
# systemd gives a service no HOME at all, and `set -u` turns that into a crash
# before the first useful line — which is how the panel's update button failed
# while running it by hand worked fine. /root is where the unit points, and the
# fallback keeps any other HOME-less context (cron, a CI runner) working too.
BACKUP_DIR="${STORM_BACKUP_DIR:-${HOME:-/root}/storm-backups}"
KEEP_BACKUPS="${STORM_KEEP_BACKUPS:-10}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)     CHECK_ONLY=1; shift ;;
    --no-backup) BACKUP=0; shift ;;
    --help|-h)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) fail "Unknown option: $1 (try --help)" ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f docker-compose.yml ]] || fail "Run this from a Storm Panel checkout."
[[ -f .env ]] || fail "No .env here. This looks like a fresh checkout, not a deployment."

compose() { docker compose "$@"; }

# ------------------------------------------------------------- what changes --

step "Checking for changes"

git rev-parse --git-dir >/dev/null 2>&1 || fail "Not a git checkout — update by hand."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$BRANCH" || fail "Could not reach the remote."

CURRENT="$(git rev-parse HEAD)"
TARGET="$(git rev-parse "origin/${BRANCH}")"

# What the running API was actually built from. The panel serves from images,
# not from the files on disk, so a checkout at the latest commit tells you
# nothing about what customers are looking at.
RUNNING="$(docker compose exec -T api printenv STORM_COMMIT 2>/dev/null | tr -d '\r' || true)"

if [[ "$CURRENT" == "$TARGET" ]]; then
  if [[ -z "$RUNNING" ]]; then
    warn "The API is not running, so its version is unknown."
  elif [[ "$RUNNING" == "$CURRENT" ]]; then
    ok "Already on the latest commit ($(git rev-parse --short HEAD)) — nothing to do."
    exit 0
  else
    # The usual way to arrive here: someone ran `git pull` by hand, saw no
    # change in the browser, and is now wondering why. The source moved; the
    # images did not.
    warn "The checkout is current, but the running panel was built from ${RUNNING:0:7}."
    [[ "$CHECK_ONLY" == "1" ]] ||
      warn "Rebuilding so what is deployed matches what is checked out."
  fi
else
  printf '%s\n' "$(git log --oneline --no-decorate "${CURRENT}..${TARGET}" | sed 's/^/  /')"
fi

# A deployment that has been edited in place cannot be fast-forwarded, and
# stashing someone's port change without telling them is worse than stopping.
if ! git diff --quiet || ! git diff --cached --quiet; then
  printf '\n'
  git --no-pager diff --stat HEAD | sed 's/^/  /'
  fail "Local changes would be overwritten. Commit or revert them, then run again."
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
  printf '\n'
  if [[ "$CURRENT" == "$TARGET" ]]; then
    ok "Check only — a rebuild would bring the running images up to the checkout."
  else
    ok "Check only — nothing was changed."
  fi
  exit 0
fi

# --------------------------------------------------------------- the backup --

if [[ "$BACKUP" == "1" ]]; then
  step "Backing up the database"
  mkdir -p "$BACKUP_DIR"
  DUMP="${BACKUP_DIR}/storm-$(date +%Y%m%d-%H%M%S).sql.gz"

  if compose ps --status running --services 2>/dev/null | grep -qx postgres; then
    # Fail the whole update if the dump fails: migrations are forward-only, and
    # the dump is the only way back.
    if compose exec -T postgres pg_dump -U "${POSTGRES_USER:-storm}" "${POSTGRES_DB:-storm}" \
        | gzip > "$DUMP"; then
      ok "$DUMP ($(du -h "$DUMP" | cut -f1))"
    else
      rm -f "$DUMP"
      fail "The dump failed. Not updating without one — use --no-backup to override."
    fi

    # Keep the last few; a server that quietly fills its disk is worse than a
    # short history.
    mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/storm-*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)))
    if [[ ${#OLD[@]} -gt 0 ]]; then
      rm -f "${OLD[@]}"
      ok "Pruned ${#OLD[@]} older dump(s), keeping $KEEP_BACKUPS"
    fi
  else
    warn "PostgreSQL is not running — skipping the dump."
  fi

  cp .env "${BACKUP_DIR}/env-$(date +%Y%m%d-%H%M%S).bak"
  chmod 600 "${BACKUP_DIR}"/env-*.bak
  ok "Copied .env (it holds ENCRYPTION_KEY; a dump without it is unreadable)"
fi

# ---------------------------------------------------------------- the update --

if [[ "$CURRENT" == "$TARGET" ]]; then
  step "Rebuilding $(git rev-parse --short HEAD)"
else
  step "Updating to $(git rev-parse --short "$TARGET")"
  git merge --ff-only "origin/${BRANCH}" >/dev/null || fail "Could not fast-forward. Resolve by hand."
  ok "Source updated"
fi

step "Building images"
compose build || fail "The build failed. The old containers are still running."
ok "Built"

step "Applying migrations and restarting"
# `up -d` runs the one-shot migrate service first and waits for it.
compose up -d || fail "Startup failed. Roll back with: git reset --hard $CURRENT && docker compose up -d --build"
ok "Containers started"

# ------------------------------------------------------------------ proving --

step "Checking the result"

PORT="${HTTP_PORT:-80}"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/ready" >/dev/null 2>&1; then
    ok "The API is ready"
    break
  fi
  sleep 2
done

if ! curl -fsS "http://127.0.0.1:${PORT}/ready" >/dev/null 2>&1; then
  printf '\n'
  compose logs --tail=30 api | sed 's/^/  /'
  fail "The panel did not come up. Roll back: git reset --hard $CURRENT && docker compose up -d --build"
fi

curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null \
  | sed 's/^/  /' || true

UNHEALTHY="$(compose ps --format '{{.Service}} {{.Status}}' | grep -i 'unhealthy\|restarting' || true)"
if [[ -n "$UNHEALTHY" ]]; then
  printf '\n'
  warn "Some containers are not healthy:"
  printf '%s\n' "$UNHEALTHY" | sed 's/^/    /'
fi

printf '\n%s✔ Updated to %s%s\n' "$GREEN" "$(git rev-parse --short HEAD)" "$RESET"
printf '%s  Roll back with: git reset --hard %s && docker compose up -d --build%s\n' \
  "$DIM" "${CURRENT:0:12}" "$RESET"
