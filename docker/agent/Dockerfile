# syntax=docker/dockerfile:1.7
# Storm Node Agent.
#
# This image is for running the agent in a container on a node. It needs the
# Docker socket and the server data directory bind-mounted, and must run as
# root so it can chown files into the unprivileged uid game containers use.
FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

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

COPY packages/types/ packages/types/
COPY packages/config/ packages/config/
COPY packages/security/ packages/security/
COPY apps/node-agent/ apps/node-agent/

RUN pnpm --filter @storm/types run build \
    && pnpm --filter @storm/config run build \
    && pnpm --filter @storm/security run build \
    && pnpm --filter @storm/node-agent run build

# Re-resolve the tree with dev dependencies left out. `pnpm prune --prod`
# is the obvious call here and the wrong one: in a workspace it strips the
# `@storm/*` links along with the dev packages, and the image then builds
# cleanly and dies on boot with ERR_MODULE_NOT_FOUND. CI=true because
# without a TTY pnpm otherwise refuses to touch the modules directory.
RUN CI=true pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /repo

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/node-agent ./apps/node-agent

RUN mkdir -p /var/lib/storm/servers /var/lib/storm/backups /etc/storm

EXPOSE 8081 2022

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8081/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/node-agent/dist/main.js"]
