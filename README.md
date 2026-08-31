# Storm Panel

A self-hosted control panel for running game servers. Storm Panel gives
customers a console, file manager, backups, databases and automation for the
servers they own, and gives operators a way to run that fleet across many
machines — on infrastructure you control.

Every game server runs in its own hardened Docker container on a node. The
panel never touches those containers directly; a small agent on each node does,
over an authenticated, signed channel.

---

## What it does

**For customers**

- Create a server from a game template, pick a location, set CPU/memory/disk
- Live console with ANSI colour, command history and log download
- File manager: browse, edit, upload, download, zip, unzip, chmod, search
- SFTP access with per-server credentials
- Backups to local disk or S3/R2/MinIO, with restore
- Cron-style schedules: restarts, backups, commands, notifications
- MySQL and PostgreSQL databases provisioned on demand
- Port allocations, startup variables, activity log, shared access for teammates
- Realtime resource charts fed by the container's own cgroup counters

**For operators**

- Node management with live CPU, memory, disk and container counts
- One-command node installer for Ubuntu and Debian
- Users, roles and 41 granular permissions
- Game template library — 12 games included, fully editable, importable/exportable
- IP and port allocation management
- Audit log of every privileged action
- Database hosts, backup storage targets, webhooks, panel settings

---

## Architecture

```
                    ┌────────────────────────────┐
   browser ────────▶│  nginx (one origin)        │
                    │  /  → web    /api → api    │
                    └───────┬─────────────┬──────┘
                            │             │
                  ┌─────────▼───┐   ┌─────▼──────────────┐
                  │ web         │   │ api                │
                  │ Next.js 15  │   │ Fastify 5          │
                  └─────────────┘   │ REST + WebSocket   │
                                    │ BullMQ workers     │
                                    └──┬──────────┬──────┘
                                       │          │
                            ┌──────────▼──┐  ┌────▼─────┐
                            │ PostgreSQL  │  │  Redis   │
                            └─────────────┘  └──────────┘
                                       │
                        signed HTTPS   │   heartbeat + events
                                       │
                     ┌─────────────────▼──────────────────┐
                     │  Storm Node Agent (one per node)   │
                     │  Docker API · files · backups      │
                     │  console streaming · SFTP          │
                     └──────────────┬─────────────────────┘
                                    │
                        ┌───────────▼────────────┐
                        │ game server containers │
                        └────────────────────────┘
```

The panel and the API are served from **one origin**, which is what lets the
session live in an httpOnly cookie the page cannot read, and lets console
websockets work without a second hostname or CORS.

**Panel → agent** names its credential in the Authorization header and proves
it with an HMAC over method, path, timestamp and body: the shared secret never
crosses the wire, and a captured request cannot be replayed elsewhere or later.
**Agent → panel** (heartbeat, SFTP credential checks) uses a token whose digest
the panel stores.

### Repository layout

```
apps/
  web/         Next.js 15 panel (App Router, Tailwind, Radix)
  api/         Fastify 5 API, WebSocket gateway, BullMQ workers, CLI
  node-agent/  Docker orchestration, files, backups, console, SFTP
packages/
  ui/          Design tokens and the shared component library
  types/       Enums, permissions, zod schemas, panel↔agent protocol
  config/      Zod-validated environment for each app
  security/    Argon2, AES-GCM, HMAC, path/SSRF guards, TOTP
  database/    Prisma schema, client, seed
docker/        Dockerfiles and nginx configuration
scripts/       Node installer, secret generation
tests/e2e/     Playwright browser tests
docs/          Full documentation
```

---

## Quick start

Requires Docker with the Compose plugin.

```bash
git clone <your-fork> storm-panel
cd storm-panel

cp .env.example .env
./scripts/generate-secrets.sh        # fills in the required secrets

# Set APP_URL to the address people will actually use, and choose the first
# owner account.
$EDITOR .env

docker compose up -d
```

Compose brings up PostgreSQL and Redis, runs migrations and the seed once, then
starts the API, the panel and nginx. Open `http://localhost` (or your
`APP_URL`) and sign in with the `ADMIN_*` credentials from `.env`.

Then, to run your first game server:

1. **Admin → Nodes → Add node** — register the machine that will host servers
2. Copy its agent configuration and run the installer on that machine:
   ```bash
   curl -fsSL https://panel.example.com/install/node.sh | sudo bash
   ```
3. Wait for the node to report **online**, then add a port range to it
4. **Servers → Create server** — pick a game, a location and its resources

`docs/INSTALLATION.md` covers this in full, including TLS and production
hardening.

---

## Development

Requires Node 20+, pnpm 10, PostgreSQL 16, Redis 7 and Docker.

```bash
pnpm install
cp .env.example .env && ./scripts/generate-secrets.sh

# Point DATABASE_URL and REDIS_URL at your local instances, then:
pnpm db:deploy      # apply migrations
pnpm db:seed        # roles, permissions, templates, settings

pnpm dev            # api :8080, web :3000, agent :8081
```

| Command            | What it does                                     |
| ------------------ | ------------------------------------------------ |
| `pnpm dev`         | Run the API, panel and agent together            |
| `pnpm build`       | Build every package and app                      |
| `pnpm typecheck`   | TypeScript across the whole workspace            |
| `pnpm test`        | Unit, component and integration tests            |
| `pnpm test:e2e`    | Playwright browser tests against a running stack |
| `pnpm db:migrate`  | Create a migration from schema changes           |
| `pnpm db:studio`   | Prisma Studio                                    |
| `pnpm storm <cmd>` | The panel CLI                                    |

`docs/DEVELOPMENT.md` has the details.

---

## CLI

The CLI talks to the database directly, so it works when the API is down —
which is exactly when you need it.

```bash
storm install                 # migrate, seed and create the first owner
storm doctor                  # check database, Redis and configuration
storm admin create --role OWNER
storm admin password user@example.com
storm admin disable-2fa user@example.com
storm node create --name fsn-1 --location Falkenstein \
  --hostname node1.example.com --ip 203.0.113.10
storm node token fsn-1        # rotate a node's credentials
storm server list
storm key:generate            # strong values for the required secrets
```

---

## Security

- Argon2id password hashing (OWASP parameters), transparent rehash on login
- HS256 JWTs with the algorithm pinned at both ends; refresh tokens rotate, and
  replaying a rotated token revokes the whole session family
- TOTP two-factor: QR enrolment, password confirmation, single-use backup codes
- 41 granular permissions; server access is resolved per request against
  ownership or an explicit sub-user grant
- Servers a caller cannot see answer 404, not 403, so ids are not enumerable
- Path traversal, zip-slip and symlink escapes rejected at the agent, which is
  the only component with filesystem access
- SSRF guard on every outbound URL, re-checked at delivery time
- Containers: non-root uid, no-new-privileges, all capabilities dropped except
  five, isolated bridge, CPU/memory/pids/IO limits, bounded logs
- Secrets encrypted at rest with AES-256-GCM; tokens stored only as digests
- Rate limiting per account (not per IP) so shared NAT is not collectively
  punished, with a tighter bucket on authentication

Full detail and the threat model: `docs/SECURITY.md`.

---

## Documentation

| Document                                      | Contents                               |
| --------------------------------------------- | -------------------------------------- |
| [INSTALLATION.md](docs/INSTALLATION.md)       | Production install, TLS, first node    |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)         | Local setup, layout, conventions       |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md)           | Scaling, backups, upgrades, monitoring |
| [SECURITY.md](docs/SECURITY.md)               | Threat model and controls              |
| [API.md](docs/API.md)                         | REST API reference and examples        |
| [NODE-AGENT.md](docs/NODE-AGENT.md)           | Agent protocol and operations          |
| [GAME-TEMPLATES.md](docs/GAME-TEMPLATES.md)   | Writing and editing templates          |
| [BACKUPS.md](docs/BACKUPS.md)                 | Storage drivers, retention, restores   |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Diagnosing common problems             |

An OpenAPI browser is served at `/api/docs` when `ENABLE_SWAGGER` is on.

---

## Licence

MIT.
