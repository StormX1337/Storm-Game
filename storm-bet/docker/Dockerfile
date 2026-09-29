# syntax=docker/dockerfile:1.7
#
# STORM BET — one Dockerfile, three runtime targets:
#   docker build -f docker/Dockerfile --target api    -t storm-bet/api .
#   docker build -f docker/Dockerfile --target worker -t storm-bet/worker .
#   docker build -f docker/Dockerfile --target web    -t storm-bet/web .
#
# Behind a TLS-intercepting proxy, hand the proxy's CA to the build:
#   --secret id=ca,src=/path/to/ca.pem   (optional; nothing is stored in the image)

ARG NODE_IMAGE=node:22-bookworm-slim

# ─── OS layer: Prisma's query engine links against OpenSSL ──────────────────
FROM ${NODE_IMAGE} AS os
RUN if ! command -v openssl >/dev/null 2>&1; then \
      apt-get update \
      && apt-get install -y --no-install-recommends openssl ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# ─── Build: install, generate, compile, then assemble per-service bundles ───
FROM os AS build
ENV CI=true NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
ARG APP_URL=http://localhost:3000
ENV APP_URL=${APP_URL}

RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm install -g pnpm@10.33.0 >/dev/null

# Manifests first, so dependency layers are cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/betting-engine/package.json packages/betting-engine/
COPY packages/casino/package.json packages/casino/
COPY packages/compliance/package.json packages/compliance/
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
COPY packages/odds-engine/package.json packages/odds-engine/
COPY packages/redis/package.json packages/redis/
COPY packages/security/package.json packages/security/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
COPY packages/validation/package.json packages/validation/
RUN --mount=type=secret,id=ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm db:generate \
 && pnpm --filter @storm-bet/api build \
 && pnpm --filter @storm-bet/worker build \
 && pnpm --filter @storm-bet/web build

# Self-contained production trees for the Node services (only their runtime
# dependencies), each with its own generated Prisma client.
RUN --mount=type=secret,id=ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    for svc in api worker; do \
      pnpm --filter @storm-bet/$svc deploy --prod --legacy /out/$svc \
      && (cd /out/$svc && node node_modules/@storm-bet/database/scripts/prisma.mjs generate) || exit 1; \
    done

# ─── Runtime base ───────────────────────────────────────────────────────────
FROM os AS runtime
ENV NODE_ENV=production
WORKDIR /app

# ─── API ────────────────────────────────────────────────────────────────────
FROM runtime AS api
COPY --from=build --chown=node:node /out/api /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ─── Worker (also runs migrations and the seed as one-off commands) ─────────
FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker /app
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ─── Web (Next.js standalone server) ────────────────────────────────────────
FROM runtime AS web
ENV PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone /app
COPY --from=build --chown=node:node /repo/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public /app/apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
