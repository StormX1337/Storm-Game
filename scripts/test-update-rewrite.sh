#!/usr/bin/env bash
#
# Proves `update.sh --check` survives an upstream whose history was rewritten,
# still refuses when the deployment has commits of its own, and offers a way
# out when the checkout has been edited in place.
#
# Rewriting authorship rewrites every commit at once, so a deployment that has
# already pulled ends up holding commits the remote no longer has. Git calls
# that "divergent branches" and stops, which is where an operator gets stuck.
# This builds exactly that — a bare remote, a deployment clone, a force-push —
# and runs the real script against it.

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

  if grep -qi -- "$want" <<<"$output"; then
    found=1
  else
    found=0
  fi

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
run_check() { ( cd "$WORK/deploy" && bash scripts/update.sh --check 2>&1 ) || true; }
run_update() { ( cd "$WORK/deploy" && bash scripts/update.sh "$@" 2>&1 ) || true; }

g init --quiet --bare --initial-branch=main "$WORK/remote.git"
g clone --quiet "$WORK/remote.git" "$WORK/deploy" 2>/dev/null

cd "$WORK/deploy"
mkdir -p scripts
cp "$SCRIPT_DIR/update.sh" scripts/update.sh
# Enough of a deployment for the script's own preflight to pass.
: > docker-compose.yml
: > .env
printf 'one\n' > a.txt
g add -A && g commit -qm 'first'
g push -q -u origin main

printf '\nA normal update\n'
g clone --quiet "$WORK/remote.git" "$WORK/upstream" 2>/dev/null
cd "$WORK/upstream"
printf 'two\n' > b.txt && g add -A && g commit -qm 'a later change'
g push -q origin main
out="$(run_check)"
check "a fast-forward is offered as usual" "a later change" "$out"
check "and is not mistaken for a rewrite" '!rewritten' "$out"
cd "$WORK/deploy" && g merge -q --ff-only origin/main

printf '\nThe upstream history is rewritten under it\n'
cd "$WORK/upstream"
# What `rewrite-authorship.sh --apply --push` does to every commit: same
# change, new hash.
g commit -q --amend --no-edit --author='IvoX777 <ivanpopov777@gmx.de>'
g push -q --force origin main
out="$(run_check)"
check "the rewrite is named for what it is" "rewritten" "$out"
check "and does not dead-end on 'resolve by hand'" '!resolve by hand' "$out"
check "nor on git's own divergent-branches wording" '!divergent' "$out"

printf '\nThe deployment has a commit of its own\n'
cd "$WORK/deploy"
printf 'edited on the server\n' > local.txt
g add -A && g commit -qm 'operator changed something here'
out="$(run_check)"
check "it refuses rather than discarding the operator's work" "commits of its own" "$out"
check "and names the commit it would have thrown away" "operator changed something here" "$out"

printf '\nThe checkout has been edited in place\n'
# What actually happens: somebody runs `pnpm install` on the host, it rewrites
# the lockfile, and every update from then on stops on a wall of diffstat with
# no way through — including the update button, which has no shell behind it.
cd "$WORK/deploy"
g reset -q --hard HEAD~1   # drop the operator's commit from the case above
printf 'rewritten by a stray pnpm install\n' > a.txt

out="$(run_update)"
check "an edited checkout is refused rather than overwritten" "would be overwritten" "$out"
check "and the way out is named in the same breath" "stash-local" "$out"
check "with what it usually is" "pnpm install" "$out"
check "the panel reads the first marked line, so the flag is on it" \
  "Local changes would be overwritten. Re-run with --stash-local" "$out"

out="$(run_check)"
check "--check says so without touching anything" "stash-local" "$out"
[[ "$(cd "$WORK/deploy" && git diff --name-only)" == "a.txt" ]] &&
  { printf '  ok   %s\n' "--check left the edit alone"; pass=$((pass + 1)); } ||
  { printf '  FAIL %s\n' "--check discarded the edit"; fail=$((fail + 1)); }

out="$(run_update --stash-local)"
check "with the flag it sets them aside and says how to get them back" "git stash pop" "$out"
[[ -z "$(cd "$WORK/deploy" && git diff --name-only)" ]] &&
  { printf '  ok   %s\n' "the checkout is clean afterwards"; pass=$((pass + 1)); } ||
  { printf '  FAIL %s\n' "the checkout is still dirty"; fail=$((fail + 1)); }
[[ -n "$(cd "$WORK/deploy" && git stash list)" ]] &&
  { printf '  ok   %s\n' "and the edit is recoverable, not gone"; pass=$((pass + 1)); } ||
  { printf '  FAIL %s\n' "the edit was thrown away"; fail=$((fail + 1)); }

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
