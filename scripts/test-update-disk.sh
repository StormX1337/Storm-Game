#!/usr/bin/env bash
#
# Proves `update.sh` refuses to start a build it has no room for, and says how
# to make room without saying anything that would delete the database.
#
# A panel updated a dozen times had 14 GB of Docker build cache on a 38 GB
# disk. Nothing collects it, so it only ever grows. A build that runs out of
# disk does not fail cleanly — it can take the running containers with it, and
# the first anyone hears about it is a 521 from Cloudflare.
#
# The check has to happen before anything is touched, and it has to name
# `docker builder prune`, because the command an operator reaches for under
# pressure is `docker system prune -af --volumes` and that one deletes the
# panel's database.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

# Asserts on the script's own output. `want` is a phrase that must appear;
# prefix it with ! for one that must not.
check() {
  local label="$1" want="$2" output="$3" negated=0
  [[ "$want" == '!'* ]] && { negated=1; want="${want#!}"; }

  if grep -qi -- "$want" <<<"$output"; then found=1; else found=0; fi

  if [[ "$found" -ne "$negated" ]]; then
    printf '  ok   %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n    %s: %s\n    got:\n%s\n' "$label" \
      "$([[ "$negated" == 1 ]] && echo 'must not contain' || echo 'wanted')" \
      "$want" "$(sed 's/^/      /' <<<"$output")"
    fail=$((fail + 1))
  fi
}

g() { git -c user.email=t@t -c user.name=T -c commit.gpgsign=false "$@"; }

# A deployment sitting one commit behind its remote, so the script gets all
# the way to the build instead of stopping at "already up to date".
g init --quiet --bare --initial-branch=main "$WORK/remote.git"
g clone --quiet "$WORK/remote.git" "$WORK/deploy" 2>/dev/null
cd "$WORK/deploy"
mkdir -p scripts
cp "$SCRIPT_DIR/update.sh" scripts/update.sh
: > docker-compose.yml
: > .env
g add -A && g commit -qm 'first'
g push -q -u origin main

g clone --quiet "$WORK/remote.git" "$WORK/upstream" 2>/dev/null
cd "$WORK/upstream"
printf 'two\n' > b.txt && g add -A && g commit -qm 'a later change'
g push -q origin main
cd "$WORK/deploy"

# `docker` is stubbed: this test is about the script's arithmetic and its
# wording, and a real daemon would make it untestable anywhere it matters.
# `docker system df` reports a pile of cache, the way the box that prompted
# this did. Anything else answers harmlessly.
mkdir -p "$WORK/bin"
#
# The `--format '{{.Type}} {{.Reclaimable}}'` shape, not the human table: the
# table has a TOTAL column in the middle, and a stub that emitted that made
# the script look like it was reading the count as a size. It was the stub
# that was wrong, but only because the two shapes differ — which is exactly
# the mistake the real awk could have made.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "system" && "$2" == "df" ]]; then
  echo "Images 304.8MB"
  echo "Containers 73.73kB"
  echo "Local Volumes 0B"
  echo "Build Cache 12.6GB"
  exit 0
fi
echo "docker stub: $*"
exit 0
STUB
chmod +x "$WORK/bin/docker"

# The readiness probe, stubbed to answer at once. Without it the runs that do
# reach the build sit in a sixty-attempt retry loop waiting for a panel the
# stubbed daemon never started.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo '{"status":"ok"}'
exit 0
STUB
chmod +x "$WORK/bin/curl"

# `df -Pm .` is what the script asks. This answers with whatever MB the caller
# wants free, in the exact shape the real one uses.
free_df() {
  cat > "$WORK/bin/df" <<STUB
#!/usr/bin/env bash
echo "Filesystem 1048576-blocks Used Available Capacity Mounted on"
echo "/dev/sda1 38000 27000 $1 75% /"
STUB
  chmod +x "$WORK/bin/df"
}

run_update() { ( cd "$WORK/deploy" && PATH="$WORK/bin:$PATH" bash scripts/update.sh --no-backup 2>&1 ) || true; }

printf '\nThe disk is nearly full\n'
BEFORE="$(cd "$WORK/deploy" && git rev-parse HEAD)"
free_df 512
out="$(run_update)"
check "it refuses instead of starting a build it cannot finish" "512 MB free" "$out"
check "and says what it wanted" "at least 4096 MB" "$out"
check "it says the panel is untouched, which is the operator's first question" \
  "still running the old version" "$out"
check "it names the cache it can see" "12.6GB" "$out"
check "and the command that reclaims it" "docker builder prune -af" "$out"
check "it warns off the one that deletes the database" "Never add --volumes" "$out"
check "it stops before building" '!Building images' "$out"
check "and before touching the containers" '!Applying migrations' "$out"

printf '\nThe deployment is left exactly as it was\n'
# "Nothing has been changed" has to be true when it is printed, which is why
# the check sits ahead of the merge and not next to the build it guards. The
# first version of this ran after the fast-forward and said it anyway.
check "it does not claim to have updated the source" '!Source updated' "$out"
[[ "$(cd "$WORK/deploy" && git rev-parse HEAD)" == "$BEFORE" ]] &&
  { printf '  ok   %s\n' "the checkout is on the same commit as before"; pass=$((pass + 1)); } ||
  { printf '  FAIL %s\n' "the checkout was moved anyway"; fail=$((fail + 1)); }

printf '\nThe threshold is the operator'"'"'s to set\n'
out="$( cd "$WORK/deploy" && PATH="$WORK/bin:$PATH" STORM_MIN_FREE_MB=256 bash scripts/update.sh --no-backup 2>&1 || true )"
check "a lower bar lets the same 512 MB through" "512 MB free" "$out"
check "and the build is reached" "Building images" "$out"

printf '\nThere is room\n'
free_df 9000
out="$(run_update)"
check "it says how much and carries on" "9000 MB free" "$out"
check "reaching the build" "Building images" "$out"
check "with no warning about pruning" '!builder prune -af' "$out"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
