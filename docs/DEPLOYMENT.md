# Deployment

Running Storm Panel for real: what to size, how to scale it, what to monitor,
how to upgrade without dropping anyone's server, and what to do when something
breaks. [INSTALLATION.md](INSTALLATION.md) covers the first install; this is
what comes after.

- [Topologies](#topologies)
- [Sizing](#sizing)
- [Scaling the panel](#scaling-the-panel)
- [Scaling nodes](#scaling-nodes)
- [PostgreSQL](#postgresql)
- [Redis](#redis)
- [TLS and the proxy](#tls-and-the-proxy)
- [Monitoring](#monitoring)
- [Logging](#logging)
- [Upgrades](#upgrades)
- [Disaster recovery](#disaster-recovery)
- [Maintenance](#maintenance)

---

## Topologies

**Single host.** Panel, database and one node together. Fine for a handful of
servers and a lab. Every failure is a total failure, and the node's game
containers compete with the database for CPU.

```
one machine: nginx · web · api · postgres · redis · agent · containers
```

**Panel plus nodes** — the normal shape. The panel host runs the panel and its
data stores; each node runs an agent and its containers. Nodes are cattle: they
die, you replace them, the panel keeps the state.

```
panel host: nginx · web · api · postgres · redis
node 1..n:  agent · containers
```

**Highly available.** Two or more API instances behind a load balancer, managed
PostgreSQL with a replica, Redis with failover. The API is stateless — sessions
live in Redis, files live on nodes — so this is mostly a matter of running more
of it.

```
LB → api × n → managed postgres (primary + replica)
             → redis (primary + replica)
nodes unchanged
```

---

## Sizing

**Panel host**

| Servers under management | CPU                  | Memory | Disk  |
| ------------------------ | -------------------- | ------ | ----- |
| < 50                     | 2                    | 2 GB   | 20 GB |
| 50–250                   | 4                    | 4 GB   | 40 GB |
| 250–1000                 | 8                    | 8 GB   | 80 GB |
| 1000+                    | Scale out, see below |        |       |

The panel's load is roughly proportional to _concurrent websocket viewers_, not
to server count. A thousand idle servers cost almost nothing; a hundred open
consoles cost real memory.

**Node host**

Sum your servers' memory limits, add 1 GB for the host and the agent, and do
not overallocate memory unless you enjoy the OOM killer. Disk: sum the disk
limits, plus room for backups if they are stored locally.

CPU is the one to overallocate — game servers are bursty and mostly idle. Two
to four times is normal; watch steal time and cut back if it climbs.

---

## Scaling the panel

The API is stateless. To run more than one instance:

```yaml
# compose.override.yml
services:
  api:
    deploy:
      replicas: 3
```

Requirements:

- **One Redis** shared by all instances. Sessions, rate limits, BullMQ and the
  websocket fan-out all live there.
- **Sticky sessions are not needed** for HTTP. They are simpler for websockets,
  but the relay works without them.
- **Workers.** By default every API instance runs the BullMQ workers too. At
  scale, set `ENABLE_WORKERS=false` on the web-facing instances and run one or
  two dedicated worker instances with `ENABLE_WORKERS=true` and
  `WORKER_CONCURRENCY` raised, so a backup job cannot slow a console.

The `migrate` service must run once — never concurrently. Compose already gates
the API behind it; on Kubernetes make it an init job, not an init container on
every replica.

The Next.js app is static output plus a small server; put it behind a CDN if
you like, but it is rarely the bottleneck.

---

## Scaling nodes

Add a node whenever an existing one passes roughly 80% of memory or disk. **Do
not wait for 100%** — you want headroom to move servers.

Nodes need no coordination with each other. They do not share storage, do not
talk to each other, and have no quorum. That is deliberate: a node failure is
an outage for the servers on it, never for the panel.

**Moving a server to another node** is a backup and a restore: take a backup,
create the server on the target node from the same template, restore into it,
then delete the original. There is no one-click migration — moving gigabytes
between machines is not something to hide behind a button that might time out.
`Admin → Servers → <server> → Transfer` is a different thing: it changes a
server's _owner_, not its node.

**Draining a node** — turn on **maintenance mode** in the node's settings. The
panel stops offering it for new servers while everything already on it keeps
running, so you can move servers off at your own pace.

---

## PostgreSQL

The Compose PostgreSQL is fine to start with. Move to a managed instance when
the panel matters more than the convenience.

```dotenv
DATABASE_URL=postgresql://user:pass@db.example.com:5432/storm?sslmode=require&connection_limit=20
```

- **Connection limit.** Prisma opens a pool per API instance. `instances ×
connection_limit` must stay under the server's `max_connections`. Use PgBouncer
  in transaction mode above a handful of instances.
- **Backups.** Managed: enable point-in-time recovery. Self-hosted: `pg_dump`
  on a timer, off-host, and restore it somewhere occasionally.
- **Read replicas** are not used — the panel writes on most requests, and the
  consistency is worth more than the offload.

Reasonable starting points for a dedicated instance:

```
shared_buffers = 25% of RAM
effective_cache_size = 75% of RAM
work_mem = 16MB
max_connections = 200
```

---

## Redis

Redis holds sessions, rate limits, queues and the websocket fan-out. Losing it
signs everyone out and drops queued jobs; it does not lose servers or files.

```dotenv
REDIS_URL=redis://:password@redis.example.com:6379/0
```

- Set `maxmemory` and `maxmemory-policy noeviction`. Under `allkeys-lru` Redis
  will happily evict a queued job.
- Persistence (AOF) means a restart does not sign everyone out. Nice, not
  essential.
- Redis Sentinel or a managed offering for failover.

---

## TLS and the proxy

Terminate TLS in front of nginx and set `COOKIE_SECURE=true`. The proxy needs to:

- forward `X-Forwarded-For` and `X-Forwarded-Proto` — the API trusts these for
  client IPs in the audit log and for rate limiting;
- upgrade websockets (`Upgrade`, `Connection`);
- allow long-lived connections — `proxy_read_timeout 3600s` or consoles drop
  every minute;
- allow large uploads if customers upload world files —
  `client_max_body_size 2G`.

A sample vhost is in [INSTALLATION.md](INSTALLATION.md#2-put-tls-in-front-of-it).

---

## Monitoring

**Endpoints**

|                   | For                                                  |
| ----------------- | ---------------------------------------------------- |
| `GET /health`     | Load balancer liveness                               |
| `GET /ready`      | Readiness — fails when the database or Redis is down |
| `GET /api/health` | Version, uptime, dependency states                   |

Point your load balancer at `/ready`, not `/health`: a process that is up but
cannot reach its database should not receive traffic.

**Alert on**

| Signal                     | Threshold              |
| -------------------------- | ---------------------- |
| `/ready` failing           | 2 consecutive checks   |
| Node offline               | Any node, immediately  |
| Disk on a node             | > 85%                  |
| Memory allocated on a node | > 90%                  |
| Failed backups             | Any, in 24h            |
| 5xx rate                   | > 1% over 5 minutes    |
| Queue depth                | Growing for 15 minutes |
| PostgreSQL connections     | > 80% of max           |

A node going offline is the alert that matters most — every server on it is
unreachable, and the panel cannot tell customers why.

**Node health** is at `GET /api/v1/admin/nodes/:id/health` and in the admin UI.

---

## Logging

Everything logs JSON to stdout. Ship it with whatever you already use.

```yaml
services:
  api:
    logging:
      driver: json-file
      options: { max-size: '50m', max-file: '5' }
```

`LOG_LEVEL`: `info` normally, `debug` while chasing something, `warn` if the
volume is genuinely a problem.

Passwords, tokens, authorization headers and cookies are redacted before they
reach a log line. The audit log is separate, lives in the database, and is what
you want for "who deleted that server" — not the application log.

Every log line for a request carries the same `requestId` that the response's
`x-request-id` header returned.

---

## Upgrades

```bash
cd /opt/storm-panel

# 1. Back up first.
docker compose exec -T postgres pg_dump -U storm storm | gzip > ~/storm-$(date +%F).sql.gz
cp .env ~/storm-env-$(date +%F).bak

# 2. Read what changed.
git fetch && git log --oneline HEAD..origin/main

# 3. Upgrade.
git pull
docker compose build
docker compose up -d

# 4. Verify.
docker compose ps
curl -s https://panel.example.com/api/health
```

`scripts/update.sh` does all four steps, keeps ten dumps, and refuses to
continue if the checkout has local edits.

**`git pull` on its own changes nothing you can see.** The panel is served from
images, and the frontend is compiled into them by `next build` at image build
time — so a checkout at the newest commit and a browser showing last month's
sidebar is the normal outcome of pulling without rebuilding, not a caching
problem. `docker compose build` is the step that matters. `update.sh` notices
this case: if the source is current but the running API reports a different
`STORM_COMMIT`, it rebuilds rather than reporting nothing to do.

To see which commit is actually serving customers:

```bash
docker compose exec api printenv STORM_COMMIT
```

Empty or `unknown` means the image was built without the build argument — pass
it, or the **Admin → Updates** page cannot tell which version it runs:

```bash
export STORM_COMMIT=$(git rev-parse HEAD)
export STORM_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose build
```

Migrations run in the `migrate` service before the API starts. They are
forward-only: to go back, restore the dump.

**Game servers keep running throughout.** They are containers on nodes; the
panel restarting does not touch them. Consoles reconnect on their own.

**Agents** upgrade separately, one node at a time:

```bash
ssh node1 'cd /opt/storm-panel && git pull && pnpm install --frozen-lockfile \
  && pnpm --filter @storm/node-agent build && systemctl restart storm-agent'
```

Restarting an agent does not stop its containers. Do one, watch it, then
continue.

---

## Updating from the panel

**Admin → Updates** shows what the panel runs, what the repository has, and
every commit in between. Checking is always on and needs nothing: one outbound
HTTPS request, cached for fifteen minutes.

Pressing **Update now** is off until you install the host-side updater, and
that is the whole design. The API container has no Docker socket, no host
filesystem and runs unprivileged — giving it any of those to enable a button
would mean that one hole in one web endpoint becomes root on the machine that
runs every customer's server. So the panel writes a request into a directory
it shares with the host, and a service on the host decides whether to honour
it. The panel can ask; only the host can execute.

```bash
cd /opt/storm-panel
sudo ./scripts/storm-updater.sh --install
```

Then add to `.env`:

```dotenv
UPDATE_CONTROL_DIR=/var/lib/storm/control
```

uncomment the matching volume on the `api` service in `docker-compose.yml`, and
`docker compose up -d api`.

What the updater will and will not do:

- It applies **only** the commit the panel offered, checked against the branch
  head at the moment of the request. Anything else is refused.
- It validates the commit id as hexadecimal before it reaches a shell — a
  request naming `abc; rm -rf /` is written to the failure status and dropped.
- It runs `scripts/update.sh`, so the database is dumped first and the panel
  is checked afterwards, exactly as a manual update would be.
- It removes the request before starting, so a crash mid-update cannot leave
  one that retries forever.

`panel.update` is its own permission, held by OWNER and ADMIN and by nobody
else — including STAFF, who can otherwise manage most of the panel. Requests
are audited with who asked and which versions were involved.

Watch it work with `journalctl -u storm-updater -f`.

## Disaster recovery

**What matters**

|                  | Where           | Lose it and                       |
| ---------------- | --------------- | --------------------------------- |
| Database         | PostgreSQL      | The panel forgets everything      |
| `ENCRYPTION_KEY` | `.env`          | Every stored secret is unreadable |
| Server data      | Nodes           | Customers lose their worlds       |
| Backups          | Node disk or S3 | The safety net is gone            |

`ENCRYPTION_KEY` is the one people forget. A database backup without it cannot
decrypt node tokens, database host passwords, SFTP passwords or 2FA seeds.
Store it separately, and store it somewhere that is not the panel.

**Panel host lost**

1. New host, install Docker, clone the repository.
2. Restore `.env` — the same `ENCRYPTION_KEY`.
3. `docker compose up -d postgres redis`, restore the dump.
4. `docker compose up -d`.
5. Point DNS at the new host. Agents reconnect on their next heartbeat.

Game servers keep running the whole time. Customers lose the panel, not their
servers.

**Node lost**

1. Provision a replacement, run the installer.
2. Register it, or reuse the old node's record.
3. Restore each server from its most recent backup onto the new node.

This is exactly as good as your backups, which is why local-only backup storage
is not a plan.

**Database corrupted**

```bash
docker compose stop api web
gunzip -c ~/storm-2026-08-30.sql.gz | docker compose exec -T postgres psql -U storm storm
docker compose start api web
```

Servers created after the dump will exist on nodes but not in the database, and
the panel has no record to rebuild them from — this is why the dump schedule
matters. For servers the panel _does_ know about, `Admin → Servers → <server> →
Sync` re-pushes the container spec to its node, which repairs a node whose
containers have drifted from what the panel expects.

---

## Maintenance

**Weekly** — check node disk and memory headroom; review failed backups; skim
the audit log for surprises.

**Monthly** — apply host security updates; upgrade the panel; verify a restore
actually works; review staff accounts and their permissions.

**Quarterly** — rotate node tokens; review API keys and delete the forgotten
ones; test the full disaster recovery path on a scratch host; re-check that
`ENCRYPTION_KEY` is backed up where you think it is.

**Maintenance mode** — `Admin → Settings → Maintenance` shows customers a
notice and blocks non-staff sign-in. Game servers keep running; only the panel
is closed.
