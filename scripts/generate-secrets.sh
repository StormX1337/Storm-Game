#!/usr/bin/env bash
#
# Fills the required secrets in .env with strong random values.
# Existing non-empty values are left alone unless --force is passed.

set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example "$ENV_FILE"
    echo "Created $ENV_FILE from .env.example"
  else
    echo "error: $ENV_FILE not found and no .env.example to copy" >&2
    exit 1
  fi
fi

random_secret() {
  # 48 bytes of entropy, base64url so it is safe in an env file unquoted.
  openssl rand -base64 48 2>/dev/null | tr '+/' '-_' | tr -d '=\n' \
    || head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
}

set_secret() {
  local key="$1"
  local current
  current=$(grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true)

  if [[ -n "$current" && $FORCE -eq 0 ]]; then
    echo "  $key already set, leaving it alone"
    return
  fi

  local value
  value=$(random_secret)

  if grep -qE "^${key}=" "$ENV_FILE"; then
    # A portable in-place edit: BSD and GNU sed disagree about -i.
    local tmp
    tmp=$(mktemp)
    awk -v key="$key" -v val="$value" \
      '{ if ($0 ~ "^"key"=") print key"="val; else print }' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  echo "  $key generated"
}

echo "Generating secrets in $ENV_FILE"
set_secret JWT_SECRET
set_secret ENCRYPTION_KEY
set_secret COOKIE_SECRET
set_secret POSTGRES_PASSWORD

chmod 600 "$ENV_FILE"
echo
echo "Done. Review $ENV_FILE, set APP_URL and ADMIN_* , then run: docker compose up -d"
