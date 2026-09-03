#!/usr/bin/env bash
#
# Proves the host-side updater reads what the panel writes.
#
# The request is a small JSON file the panel drops in a shared directory, and
# the updater reads it with sed rather than a parser. That is fine for strings
# and blind to booleans: a flag read with the string reader answers empty for
# every request ever written, so the feature looks like it was never wired up.
# This runs the real functions against real request files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

check() {
  local label="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    printf '  ok   %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n    wanted: %s\n    got:    %s\n' "$label" "$want" "$got"
    fail=$((fail + 1))
  fi
}

# The readers, lifted out of the updater exactly as it defines them, so this
# tests the script rather than a copy of it that has drifted.
eval "$(sed -n '/^json_field() {/,/^}/p;/^json_true() {/,/^}/p' "$SCRIPT_DIR/storm-updater.sh")"

write_request() {
  printf '%s\n' "$1" > "$WORK/request.json"
}

printf '\nReading a request the panel wrote\n'

write_request '{
  "id": "upd_abc123",
  "state": "requested",
  "requestedCommit": "4edaf18c0ffee00",
  "requestedBy": "storm",
  "requestedAt": "2026-09-03T06:00:00.000Z"
}'
check "the job id" "upd_abc123" "$(json_field id "$WORK/request.json")"
check "the commit to move to" "4edaf18c0ffee00" \
  "$(json_field requestedCommit "$WORK/request.json")"
check "who asked" "storm" "$(json_field requestedBy "$WORK/request.json")"

printf '\nThe flag that sets local edits aside\n'

# Absent, which is every ordinary update.
json_true stashLocal "$WORK/request.json" &&
  { printf '  FAIL %s\n' "an ordinary request asked to stash"; fail=$((fail + 1)); } ||
  { printf '  ok   %s\n' "an ordinary request does not ask to stash"; pass=$((pass + 1)); }

write_request '{
  "id": "upd_def456",
  "requestedCommit": "4edaf18c0ffee00",
  "requestedBy": "storm",
  "stashLocal": true
}'
json_true stashLocal "$WORK/request.json" &&
  { printf '  ok   %s\n' "a ticked request is read as ticked"; pass=$((pass + 1)); } ||
  { printf '  FAIL %s\n' "the flag was written but never read"; fail=$((fail + 1)); }

# Booleans are unquoted, which the string reader cannot see at all. If the
# updater ever goes back to reading this with json_field, this is the check
# that says so.
check "the string reader is blind to it, as expected" "" \
  "$(json_field stashLocal "$WORK/request.json")"

write_request '{ "requestedCommit": "abc1234", "stashLocal": false }'
json_true stashLocal "$WORK/request.json" &&
  { printf '  FAIL %s\n' "false was read as true"; fail=$((fail + 1)); } ||
  { printf '  ok   %s\n' "false is false"; pass=$((pass + 1)); }

# A commit that merely contains the word must not turn the flag on.
write_request '{ "requestedCommit": "abc1234", "requestedBy": "stashLocal-true" }'
json_true stashLocal "$WORK/request.json" &&
  { printf '  FAIL %s\n' "a lookalike value turned the flag on"; fail=$((fail + 1)); } ||
  { printf '  ok   %s\n' "a lookalike value leaves it off"; pass=$((pass + 1)); }

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
