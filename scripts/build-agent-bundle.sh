#!/usr/bin/env bash
#
# Builds the node-agent bundle the panel serves at /install/storm-agent.tar.gz.
#
# A node runs `install-node.sh`, which downloads this archive and unpacks it
# into /opt/storm-agent. It carries its own production dependencies, so a node
# needs no npm registry access — and the agent it gets is always the one that
# matches the panel that issued its token.
#
#   ./scripts/build-agent-bundle.sh [output-path]
#
# Set STORM_SKIP_BUILD=1 to package an existing build instead of compiling.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-${REPO_ROOT}/dist/storm-agent.tar.gz}"

cd "$REPO_ROOT"

# The Docker build compiles first and prunes dev dependencies before calling
# this, so it sets STORM_SKIP_BUILD=1: TypeScript is gone by then, and the
# point of the prune is that the bundle carries production dependencies only.
if [[ "${STORM_SKIP_BUILD:-0}" != "1" ]]; then
  echo "Building the agent…"
  pnpm --filter @storm/types build
  pnpm --filter @storm/config build
  pnpm --filter @storm/security build
  pnpm --filter @storm/node-agent build
fi

[[ -f apps/node-agent/dist/main.js ]] || {
  echo "No apps/node-agent/dist/main.js — build the agent first." >&2
  exit 1
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "Staging…"
mkdir -p "$STAGE/apps/node-agent" "$STAGE/packages"

cp package.json pnpm-workspace.yaml "$STAGE/"

# -a throughout: pnpm's trees are symlinks, and the links are relative, so
# preserving them keeps the layout resolvable once it is unpacked elsewhere.
# Dereferencing instead would both break `@storm/*` resolution and multiply the
# size of the archive.
cp -a node_modules "$STAGE/node_modules"
cp -a apps/node-agent/dist apps/node-agent/package.json "$STAGE/apps/node-agent/"
[[ -d apps/node-agent/node_modules ]] && cp -a apps/node-agent/node_modules "$STAGE/apps/node-agent/"

# Only the packages the agent actually imports at runtime.
for name in types config security; do
  mkdir -p "$STAGE/packages/$name"
  cp -a "packages/$name/dist" "packages/$name/package.json" "$STAGE/packages/$name/"
  [[ -d "packages/$name/node_modules" ]] && cp -a "packages/$name/node_modules" "$STAGE/packages/$name/"
done

mkdir -p "$(dirname "$OUTPUT")"
echo "Writing ${OUTPUT}…"
tar -czf "$OUTPUT" -C "$STAGE" .

printf 'Done: %s (%s)\n' "$OUTPUT" "$(du -h "$OUTPUT" | cut -f1)"
