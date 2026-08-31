# Development

Setting up a working copy, how the repository is laid out, and the conventions
that keep it consistent.

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running everything](#running-everything)
- [Repository layout](#repository-layout)
- [How a request flows](#how-a-request-flows)
- [Conventions](#conventions)
- [Database work](#database-work)
- [Tests](#tests)
- [Adding a feature](#adding-a-feature)
- [Debugging](#debugging)

---

## Prerequisites

|            | Version      | Why                                                 |
| ---------- | ------------ | --------------------------------------------------- |
| Node       | 20.12+ or 22 | The API and agent target Node 20                    |
| pnpm       | 10           | Workspaces; `npm`/`yarn` will not resolve the links |
| PostgreSQL | 16           | Prisma schema targets 16                            |
| Redis      | 7            | Sessions, queues, rate limits                       |
| Docker     | 24+          | Only needed to run the node agent                   |

```bash
corepack enable && corepack prepare pnpm@10 --activate
```

---

## Setup

```bash
git clone https://github.com/your-org/storm-panel.git
cd storm-panel
pnpm install

cp .env.example .env
./scripts/generate-secrets.sh
```

Point the database and Redis at your local instances:

```dotenv
DATABASE_URL=postgresql://storm:storm@127.0.0.1:5432/storm
REDIS_URL=redis://127.0.0.1:6379
APP_URL=http://localhost:3000
COOKIE_SECURE=false
ADMIN_EMAIL=dev@storm.local
ADMIN_USERNAME=dev
ADMIN_PASSWORD=DevPassword123!
```

If you would rather not install either service:

```bash
docker run -d --name storm-pg  -e POSTGRES_USER=storm -e POSTGRES_PASSWORD=storm \
  -e POSTGRES_DB=storm -p 5432:5432 postgres:16-alpine
docker run -d --name storm-redis -p 6379:6379 redis:7-alpine
```

Then:

```bash
pnpm db:generate     # Prisma client
pnpm db:deploy       # apply migrations
pnpm db:seed         # roles, permissions, 12 templates, settings, owner
```

The seed is idempotent — re-run it whenever you like.

---

## Running everything

```bash
pnpm dev
```

Starts three processes:

|            | Port | Notes                                          |
| ---------- | ---- | ---------------------------------------------- |
| API        | 8080 | `tsx watch`, restarts on change                |
| Web        | 3000 | `next dev`, hot reload; proxies `/api` to 8080 |
| Node agent | 8081 | Only useful with Docker available              |

Sign in at `http://localhost:3000` with the `ADMIN_*` credentials.

To run one at a time:

```bash
pnpm --filter @storm/api dev
pnpm --filter @storm/web dev
pnpm --filter @storm/node-agent dev
```

The agent needs credentials from a registered node:

```bash
pnpm storm node create --name dev --location local \
  --hostname 127.0.0.1 --ip 127.0.0.1
```

Copy the printed values into `.env` as `AGENT_NODE_UUID`, `AGENT_TOKEN_ID`,
`AGENT_TOKEN` and `AGENT_SECRET`.

---

## Repository layout

```
apps/
  api/                    Fastify API
    src/
      routes/             HTTP endpoints, grouped by resource
      services/           Business logic — no Fastify types in here
      ws/                 Console and account websocket gateways
      workers/            BullMQ processors
      plugins/            Fastify plugins (auth, security, prisma, redis)
      lib/                Errors, responses, validation, transformers
      cli/                The storm CLI
    test/                 Unit and integration tests
  web/                    Next.js 15 panel
    src/
      app/(auth)/         Login, register, reset — no chrome
      app/(panel)/        Everything behind a session
      components/         Feature components
      lib/                API client, auth context, hooks
  node-agent/             The per-node daemon
    src/
      routes/             The agent's HTTP surface
      services/           Docker, files, backups, console, SFTP, system
packages/
  ui/                     Design tokens and shared components
  types/                  Enums, permissions, zod schemas, protocol types
  config/                 Zod-validated environment per app
  security/               Argon2, AES-GCM, HMAC, path guards, SSRF, TOTP
  database/               Prisma schema, client, seed data
docker/                   Dockerfiles and nginx config
scripts/                  Node installer, secret generation
tests/e2e/                Playwright
docs/                     This directory
```

Dependencies point one way: `apps/*` depend on `packages/*`, and packages never
depend on apps. `@storm/types` is the only thing both the API and the web app
import from, which is what keeps the wire contract honest.

---

## How a request flows

Take `POST /api/v1/servers/:id/power`:

1. **`plugins/security.ts`** — helmet headers, CORS, rate limit bucket.
2. **`plugins/auth.ts`** — reads the `storm_session` cookie or a bearer token,
   verifies the JWT with the algorithm pinned, loads the user and their
   effective permissions.
3. **`routes/servers.routes.ts`** — `params()`/`body()` run the zod schema from
   `@storm/types`. Invalid input becomes a 422 with per-field messages.
4. **`app.requirePermission(...)`** — checks the permission the route declares.
5. **`services/server.service.ts`** — resolves the server _for this user_
   (owner, sub-user or an admin with `servers.view.all`). A server the caller
   may not see is a 404, never a 403.
6. **`services/node-client.ts`** — signs the outbound call to the agent with
   HMAC-SHA256 over method, path, timestamp and body.
7. The agent acts on Docker and streams state back over its socket, which the
   API relays to the browser.

Every step is enforceable on its own; none of them trusts the one before it.

---

## Conventions

**TypeScript** is strict, with `noUncheckedIndexedAccess`. `any` needs a reason
next to it. Prefer a zod schema over a hand-written interface when the value
crosses a boundary — the schema is the type _and_ the validator.

**Imports** use the `.js` extension in the API and agent (NodeNext resolution)
and no extension in the web app and UI package (bundler resolution). Follow the
file you are editing.

**Errors** come from `lib/errors.ts`: `badRequest`, `unauthorized`,
`forbidden`, `notFound`, `conflict`, `unprocessable`, `tooManyRequests`,
`internal`. They serialise to one shape:

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "…", "details": null } }
```

Never build that object by hand — throwing the helper keeps the status, the
code and the log entry in step.

**Responses** come from `lib/response.ts`: `ok(data)` and
`paginated(items, meta)`.

**Services** hold the logic and take a `PrismaClient`; routes stay thin. That
is what lets the CLI reuse the same code paths without a running API.

**Comments** explain why. The code already says what.

**Formatting** — `pnpm format` (Prettier), `pnpm lint` (ESLint), `pnpm lint:fix`
for the fixable half. Both run in CI.

ESLint is one flat config at the repository root, `eslint.config.mjs`, covering
every package. Type-aware rules are deliberately off — `pnpm typecheck` already
runs tsc with `strict` and `noUncheckedIndexedAccess` over each project, so
repeating that work in the linter would only make it slow. What is left is the
class of mistake the compiler accepts: unused bindings, `==`, React hook
dependencies, Next-specific footguns.

Bindings intended to stay unused are prefixed with `_`. Where a rule is wrong
for a specific line — a regex that matches control characters on purpose, for
instance — disable it there with a `--` reason, not repo-wide.

---

## Database work

Change `packages/database/prisma/schema.prisma`, then:

```bash
pnpm db:migrate --name add_something   # creates and applies a migration
pnpm db:generate                       # regenerate the client
```

Migrations are committed. Never edit one that has been pushed — add another.

```bash
pnpm db:studio      # browse the data
pnpm db:reset       # drop, re-migrate, re-seed (development only)
```

Anything that must not half-happen goes in `prisma.$transaction`. Server
creation is the reference example: the server row, its allocation, its
variables and its audit entry either all land or none do.

---

## Tests

```bash
pnpm test           # unit + integration
pnpm test:e2e       # Playwright, needs a running stack
pnpm typecheck      # tsc across the workspace
```

**Unit** tests cover `packages/security` — hashing, path resolution, HMAC,
TOTP, SSRF — with no I/O.

**Integration** tests in `apps/api/test` build the real Fastify app against a
real database and drive it with `app.inject()`. They cover registration, login,
2FA, refresh rotation and reuse detection, permissions per role, server access
boundaries and validation.

They read the repository `.env` for `DATABASE_URL`, `JWT_SECRET`,
`ENCRYPTION_KEY` and `COOKIE_SECRET`, so `pnpm test` works straight after
installation. Anything already exported wins, which is how you point them at a
scratch database instead of the one you develop against:

```bash
DATABASE_URL=postgresql://storm:storm@127.0.0.1:5432/storm_test pnpm test
```

They write and delete their own rows under a per-run namespace, but they are
not read-only — do not aim them at a database with anything in it you want.

**Component** tests in `apps/web/test` run the real components in jsdom with
Testing Library, driven by Vitest:

```bash
pnpm --filter @storm/web test
pnpm --filter @storm/web test:watch
```

They cover what browser tests are too slow to cover exhaustively and unit tests
cannot reach: that `Field` binds a label to its control (this broke once and
made every form announce as unlabelled), that every server status renders as
prose rather than a raw enum, that the sidebar hides what a role may not use,
that the sign-in form reveals the 2FA field without discarding what was typed,
and that the API client refreshes an expired session exactly once instead of
rotating the refresh token per parallel request.

**End-to-end** tests drive a browser against a running stack:

```bash
pnpm dev                 # in one terminal
pnpm test:e2e            # in another
```

`STORM_BASE_URL` points them at another deployment;
`PLAYWRIGHT_CHROMIUM_PATH` points at a Chromium you already have instead of
downloading one.

A test that fails for a reason the code should have prevented is a bug report —
fix the code, not the assertion.

---

## Adding a feature

Adding an endpoint, end to end:

1. **Schema** — add the zod schema and any shared types to `@storm/types`.
2. **Permission** — if it needs a new one, add it to `permissions.ts`, put it
   in the right role defaults, and add a migration seeding the row.
3. **Service** — the logic, in `apps/api/src/services`.
4. **Route** — validate, check the permission, call the service, return `ok()`.
   Add `schema: { tags, summary }` so it appears in the OpenAPI document.
5. **Test** — an integration test for the success path and the denial path.
6. **Client** — a hook in `apps/web/src/lib`, then the UI.
7. **Docs** — [API.md](API.md) if the surface changed.

Adding a game template is different: no code, just a template. See
[GAME-TEMPLATES.md](GAME-TEMPLATES.md).

---

## Debugging

```bash
LOG_LEVEL=debug pnpm --filter @storm/api dev
```

Logs are JSON. Pipe them through `pino-pretty` when reading by eye.

Every response carries `x-request-id`; the same id is on every log line for
that request, including the error.

```bash
# Watch the queues
redis-cli --scan --pattern 'bull:*'

# What the agent thinks it is running
curl -s localhost:8081/health

# Configuration, database, Redis, secrets, nodes
pnpm storm doctor
```

`ENABLE_SWAGGER=true` publishes the OpenAPI browser at
`http://localhost:8080/api/docs`, which is the fastest way to try an endpoint
with a real session.
