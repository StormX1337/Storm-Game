# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------- builder --
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

COPY packages/ packages/
COPY apps/web/ apps/web/

RUN pnpm --filter @storm/types run build

# Next resolves `rewrites()` at build time into routes-manifest.json, so this
# has to be a build argument: setting it in the running container would have
# no effect. In the Compose deployment nginx routes /api to the API anyway,
# but baking the right target keeps the web container correct on its own.
ARG API_INTERNAL_URL=http://api:8080
ENV API_INTERNAL_URL=${API_INTERNAL_URL}

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @storm/web run build

# ---------------------------------------------------------------- runtime --
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends tini curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# Next's standalone output already contains a pruned node_modules tree.
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public

RUN groupadd --system --gid 1001 storm \
    && useradd --system --uid 1001 --gid storm --home /app storm \
    && chown -R storm:storm /app

USER storm
EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/login || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
