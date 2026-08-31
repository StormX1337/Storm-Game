#!/usr/bin/env bash
#
# Rewrites this repository's history so every commit is authored by you, and
# strips the assistant attribution trailers from the messages.
#
#   ./scripts/rewrite-authorship.sh                 # show what would change
#   ./scripts/rewrite-authorship.sh --apply         # rewrite locally
#   ./scripts/rewrite-authorship.sh --apply --push  # rewrite and force-push
#
# REWRITE_NAME, REWRITE_EMAIL and REWRITE_MATCH_EMAIL override who the commits
# become and which addresses are rewritten. The email is what GitHub matches an
# account on, so it has to be one your account has registered.
#
# It rewrites metadata only. File contents are untouched, and the script
# verifies that before it will push.
#
# WARNING: this replaces the history on the remote. Every other clone — your
# VPS included — has to be reset afterwards:
#
#   git fetch origin && git reset --hard origin/<branch>
#
# Rewriting also drops commit signatures, because the commits are rebuilt. Every
# rewritten commit will read "Unverified" on GitHub afterwards. That is a
# property of rewriting history, not something this script chooses.

set -euo pipefail

# GitHub links a commit to an account by the address in it, not by the name —
# so this has to be an address that account has registered, or the commits show
# up under a stranger, or under nobody at all.
NAME="${REWRITE_NAME:-IvoX777}"
EMAIL="${REWRITE_EMAIL:-ivanpopov777@gmx.de}"

# Addresses to rewrite, separated by commas. Anything not listed keeps its own
# author: this is for correcting your own commits, not for claiming other
# people's.
MATCH="${REWRITE_MATCH_EMAIL:-noreply@anthropic.com,ivanbul85@gmail.com}"

APPLY=0
PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --push)  PUSH=1; shift ;;
    --help|-h) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."
git rev-parse --git-dir >/dev/null

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE_TREE="$(git rev-parse "HEAD^{tree}")"

echo "Repository: $(pwd)"
echo "Branch:     ${BRANCH}"
echo "New author: ${NAME} <${EMAIL}>"
echo "Rewriting:  ${MATCH}"
echo
echo "Authors currently in the history:"
git log --format='%an <%ae>' | sort | uniq -c | sed 's/^/  /'

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Nothing changed. Re-run with --apply to rewrite, and --push to publish."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "${TMP}/env-filter.sh" <<EOF
# The author only, and only the addresses named above.
#
# GitHub credits the author, so that is what puts a commit under your name. The
# committer is left alone: it is what the signature covers, and rewriting it
# would make every commit read as unsigned by someone it was not.
case ",${MATCH}," in
  *",\$GIT_AUTHOR_EMAIL,"*)
    export GIT_AUTHOR_NAME="${NAME}"
    export GIT_AUTHOR_EMAIL="${EMAIL}"
    ;;
esac
EOF

cat > "${TMP}/msg-filter.sh" <<'EOF'
grep -v -e "^Co-Authored-By: Claude" -e "^Claude-Session:" -e "^🤖 Generated with \[Claude Code\]" |
  awk 'BEGIN{blank=0} /^[[:space:]]*$/{blank++; next} {while(blank-->0) print ""; blank=0; print}'
EOF

echo
echo "Rewriting..."
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --env-filter ". ${TMP}/env-filter.sh" \
  --msg-filter "bash ${TMP}/msg-filter.sh" \
  -- --all

# Metadata only. If a single byte of content moved, something is wrong and
# nothing should reach the remote.
AFTER_TREE="$(git rev-parse "HEAD^{tree}")"
if [[ "$BEFORE_TREE" != "$AFTER_TREE" ]]; then
  echo "File contents changed — refusing to go further. Restore with:" >&2
  echo "  git reset --hard refs/original/refs/heads/${BRANCH}" >&2
  exit 1
fi
echo "File contents verified unchanged."

echo
echo "Authors now:"
git log --format='%an <%ae>' | sort | uniq -c | sed 's/^/  /'

# The pre-rewrite history stays here until you delete it.
echo
echo "The original history is kept at refs/original/. To undo:"
echo "  git reset --hard refs/original/refs/heads/${BRANCH}"

if [[ "$PUSH" != "1" ]]; then
  echo
  echo "Not pushed. Re-run with --push, or: git push --force-with-lease origin ${BRANCH}"
  exit 0
fi

echo
echo "Force-pushing ${BRANCH}..."
git push --force-with-lease origin "${BRANCH}"

cat <<EOF

Done. Every other clone now has a history that no longer matches, including
your VPS. There, run:

  cd /opt/storm-panel
  git fetch origin
  git reset --hard origin/${BRANCH}

Then rebuild once, so the panel's version stamp refers to a commit that still
exists:

  ./scripts/update.sh
EOF
