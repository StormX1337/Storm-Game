#!/usr/bin/env bash
#
# Proves the documented install produces a configuration the panel accepts.
#
# The specification asks that the whole application can be started on a fresh
# machine by following docs/INSTALLATION.md. Pulling images needs a Docker
# daemon and a registry, which not every environment has — but everything up to
# that point is checkable here, and it is where the failures actually live: a
# variable the compose file needs and .env.example never mentions, a generated
# secret the validator rejects, a documented service that was renamed.
#
# What this does NOT cover: the image build, the pull, and the containers
# actually talking to each other. Run `docker compose up -d --build` for that.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL %s\n    %s\n' "$1" "$2"; fail=$((fail + 1)); }

printf '\nA fresh checkout\n'

# What a new operator has: the repository, and nothing else.
cd "$WORK"
cp "$REPO/.env.example" . 2>/dev/null || { echo "  FAIL no .env.example to install from"; exit 1; }
cp "$REPO/docker-compose.yml" .
mkdir -p scripts && cp "$REPO/scripts/generate-secrets.sh" scripts/
[[ -f .env ]] && { bad "a fresh checkout must not ship a .env" "one was copied"; }

# ---------------------------------------------------- step 1 of the guide --

if bash scripts/generate-secrets.sh >/dev/null 2>&1; then
  ok "generate-secrets.sh runs on a checkout with no .env"
else
  bad "generate-secrets.sh runs on a checkout with no .env" "it exited non-zero"
fi

if [[ -f .env ]]; then
  ok ".env is created from the example"
else
  bad ".env is created from the example" "no .env afterwards"
fi

perms="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)"
if [[ "$perms" == "600" ]]; then
  ok ".env is not world readable — it holds ENCRYPTION_KEY"
else
  bad ".env is not world readable" "mode is $perms"
fi

# ------------------------------------- every variable compose asks for --

missing="$(python3 - "$WORK/docker-compose.yml" "$WORK/.env" <<'PY'
import re, sys
compose = open(sys.argv[1]).read()
env = open(sys.argv[2]).read()
# ${VAR} without a :- default has to be in .env or the container gets "".
required = {m.group(1) for m in re.finditer(r'\$\{([A-Z_][A-Z0-9_]*)(:?-)?', compose) if not m.group(2)}
declared = set(re.findall(r'^([A-Z_][A-Z0-9_]*)=', env, re.M))
print(' '.join(sorted(required - declared)))
PY
)"
if [[ -z "$missing" ]]; then
  ok "every variable compose has no default for is in .env"
else
  bad "every variable compose has no default for is in .env" "missing: $missing"
fi

# --------------------------------- the secrets the validator will see --

if node --input-type=module -e "
  import { loadApiEnv } from '${REPO}/packages/config/dist/index.js';
  import { readFileSync } from 'node:fs';
  const env = Object.fromEntries(
    readFileSync('.env', 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  // The API refuses to boot on a bad configuration, so this is the same gate
  // a real \`docker compose up\` would hit — just without the containers.
  loadApiEnv({ ...env, DATABASE_URL: 'postgresql://storm:pw@postgres:5432/storm', REDIS_URL: 'redis://redis:6379' });
" 2>"$WORK/env-error"; then
  ok "the generated .env satisfies the API's own validation"
else
  bad "the generated .env satisfies the API's own validation" "$(head -4 "$WORK/env-error" | tr '\n' ' ')"
fi

# ------------------------------------------------ the compose file itself --

if (cd "$WORK" && docker compose config --quiet 2>"$WORK/compose-error"); then
  ok "docker compose config parses with that .env"
else
  bad "docker compose config parses with that .env" "$(head -3 "$WORK/compose-error" | tr '\n' ' ')"
fi

# ------------------------------------------- what the guide tells you to run --

printf '\nWhat the guide tells you to run\n'
cd "$REPO"

# Read once, and check that reading worked.
#
# This used to run `docker compose config --services 2>/dev/null` inside the
# loop, so a run where that command failed for any reason produced an empty
# list and every service was reported as missing from compose. It fired about
# one run in ten and accused the wrong file: somebody would go looking through
# docker-compose.yml for a service defined plainly at the top of it. A check
# that cannot tell "the file is wrong" from "I could not read the file" is
# worse than no check.
if compose_services=$(docker compose config --services 2>&1); then
  # The service is the first token after the verb that is not a flag. Taking
  # the last token instead reads `docker compose exec api node` as a service
  # called "node", which is the command.
  for service in $(grep -ohE 'docker compose (exec|run|logs)( +-[A-Za-z]+)* +[a-z][a-z0-9-]*' \
                     docs/INSTALLATION.md docs/DEPLOYMENT.md \
                   | sed -E 's/.*(exec|run|logs)( +-[A-Za-z]+)* +//' | sort -u); do
    if printf '%s\n' "$compose_services" | grep -qx "$service"; then
      ok "service \"$service\" exists"
    else
      bad "service \"$service\" exists" "the guide runs it, compose does not define it"
    fi
  done
else
  # One true failure instead of one true one and four invented ones. Nothing
  # can be said about which services compose defines when compose could not be
  # read, and saying it anyway sends the reader to the wrong file.
  bad "docker compose config can be read" \
      "$(printf '%s' "$compose_services" | head -n 1)"
fi

for script in $(grep -oE '\./scripts/[a-z-]+\.sh' docs/INSTALLATION.md docs/DEPLOYMENT.md | cut -d: -f2- | sort -u); do
  if [[ -x "$script" ]]; then
    ok "$script exists and is executable"
  else
    bad "$script exists and is executable" "the docs tell an operator to run it"
  fi
done

# Every pnpm command the documentation tells someone to run. `install`,
# `dev` and `--filter` are pnpm's own, not ours, so they are skipped.
for target in $(grep -ohE 'pnpm [a-z][a-z0-9:-]*' docs/*.md README.md 2>/dev/null \
                | awk '{print $2}' | sort -u \
                | grep -vE '^(install|dev|add|remove|exec|run|store|prune|why|10)$'); do
  if node -e "process.exit(require('$REPO/package.json').scripts['$target'] ? 0 : 1)"; then
    ok "pnpm $target is a real script"
  else
    bad "pnpm $target is a real script" "the docs name it, package.json does not"
  fi
done


# ------------------------------------------------- installing a node --

printf '\nInstalling a node\n'

for script in "$REPO"/scripts/*.sh; do
  if bash -n "$script" 2>/dev/null; then
    ok "$(basename "$script") parses"
  else
    bad "$(basename "$script") parses" "bash -n rejects it"
  fi
done

if problems="$(node "$REPO/scripts/checks/installer-config.mjs")"; then
  ok "the node installer writes a configuration the agent accepts"
else
  bad "the node installer writes a configuration the agent accepts" "$problems"
fi

# The panel serves the installer and the agent bundle off its own disk, so a
# runtime image that does not carry them answers 404 to
# `curl <panel>/install/node.sh` — working in development, broken in production.
for needed in scripts dist/storm-agent.tar.gz pnpm-workspace.yaml; do
  if grep -qE "^COPY --from=builder /repo/${needed}" "$REPO/docker/api/Dockerfile"; then
    ok "the API image carries $needed"
  else
    bad "the API image carries $needed" "the install routes read it from disk at runtime"
  fi
done

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
