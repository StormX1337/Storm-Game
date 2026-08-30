# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------- builder --
FROM node:22-bookworm-slim AS builder

# openssl is required by Prisma's query engine at generate and run time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

# Copy only the manifests first so a dependency install is cached across
# source-only changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
COPY packages/security/package.json packages/security/
COPY packages/database/package.json packages/database/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/node-agent/package.json apps/node-agent/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/node-agent/ apps/node-agent/
COPY scripts/ scripts/

RUN pnpm --filter @storm/types run build \
    && pnpm --filter @storm/config run build \
    && pnpm --filter @storm/security run build \
    && pnpm --filter @storm/database run build \
    && pnpm --filter @storm/api run build \
    && pnpm --filter @storm/node-agent run build

# Re-resolve the tree with dev dependencies left out. `pnpm prune --prod`
# is the obvious call here and the wrong one: in a workspace it strips the
# `@storm/*` links along with the dev packages, and the image then builds
# cleanly and dies on boot with ERR_MODULE_NOT_FOUND. CI=true because
# without a TTY pnpm otherwise refuses to touch the modules directory.
RUN CI=true pnpm install --prod --frozen-lockfile --ignore-scripts \
    && node node_modules/prisma/build/index.js generate \
        --schema packages/database/prisma/schema.prisma

# The panel serves this to nodes at /install/storm-agent.tar.gz, so a node
# always installs the agent build that matches the panel issuing its token.
# Built after the production install so the bundle carries no dev tooling.
RUN STORM_SKIP_BUILD=1 bash scripts/build-agent-bundle.sh /repo/dist/storm-agent.tar.gz

# ---------------------------------------------------------------- runtime --
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

ENV NODE_ENV=production
WORKDIR /repo

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/api ./apps/api

# Served at /install/node.sh and /install/storm-agent.tar.gz.
COPY --from=builder /repo/scripts ./scripts
COPY --from=builder /repo/dist/storm-agent.tar.gz ./dist/storm-agent.tar.gz

# The API runs unprivileged; only the backup volume needs to be writable.
RUN groupadd --system --gid 1001 storm \
    && useradd --system --uid 1001 --gid storm --home /repo storm \
    && mkdir -p /var/lib/storm/backups \
    && chown -R storm:storm /var/lib/storm

USER storm
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
