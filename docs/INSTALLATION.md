# Installation

This is the production install: the panel on one machine, one or more nodes
running game servers on others. A node can share a machine with the panel for a
small deployment, but keeping them apart is the sane default — a node runs
untrusted game code.

- [Requirements](#requirements)
- [1. Install the panel](#1-install-the-panel)
- [2. Put TLS in front of it](#2-put-tls-in-front-of-it)
- [3. Register your first node](#3-register-your-first-node)
- [4. Install the agent on the node](#4-install-the-agent-on-the-node)
- [5. Give the node ports](#5-give-the-node-ports)
- [6. Create a server](#6-create-a-server)
- [Optional pieces](#optional-pieces)
- [Verifying the install](#verifying-the-install)

---

## Requirements

**Panel host**

| | Minimum | Comfortable |
| --- | --- | --- |
| CPU | 2 cores | 4 cores |
| Memory | 2 GB | 4 GB |
| Disk | 20 GB | 40 GB SSD |

Software: a 64-bit Linux with Docker Engine 24+ and the Compose plugin. The
panel itself is stateless; PostgreSQL and Redis run as containers beside it.

**Node host**

Sized for the servers you intend to run, plus roughly 1 GB and 10 GB of disk
for the host itself. Ubuntu 22.04+, Ubuntu 24.04+ or Debian 12+, with root
access. The installer handles Docker.

**Network**

| Port | Where | Purpose |
| --- | --- | --- |
| 80 / 443 | panel | The panel and its API |
| 8081 | node | Agent API — reachable from the panel |
| 2022 | node | SFTP — reachable from your customers |
| game ports | node | Whatever ranges you allocate |

The panel must reach each node on 8081, and each node must reach the panel on
443 (heartbeats and SFTP credential checks). Nothing needs to reach the
database or Redis from outside the panel host.

---

## 1. Install the panel

```bash
git clone https://github.com/your-org/storm-panel.git /opt/storm-panel
cd /opt/storm-panel

cp .env.example .env
./scripts/generate-secrets.sh
```

`generate-secrets.sh` fills in `POSTGRES_PASSWORD`, `JWT_SECRET`,
`ENCRYPTION_KEY` and `COOKIE_SECRET` with 48 bytes of randomness each. It never
overwrites a value that is already set, so it is safe to re-run.

Now edit `.env`. Three things matter:

```dotenv
# The address people actually use. Node agents call back on this, so it must
# resolve from your nodes as well as from your browser.
APP_URL=https://panel.example.com

# Once TLS is in front of the panel.
COOKIE_SECURE=true

# The first owner account, created on first boot.
ADMIN_EMAIL=you@example.com
ADMIN_USERNAME=you
ADMIN_PASSWORD=<a long password you have not used elsewhere>
```

Then start it:

```bash
docker compose up -d
```

Compose starts PostgreSQL and Redis, waits for both to pass their health
checks, runs `prisma migrate deploy` and the seed as a one-shot `migrate`
service, and only then starts the API, the panel and nginx. The seed is
idempotent: it creates the roles, the 41 permissions, the 12 game templates and
the default settings, and creates the owner account if `ADMIN_PASSWORD` is set.

Watch it come up:

```bash
docker compose logs -f migrate api
```

`Storm API listening` in the api log means it is ready. Open `APP_URL` and sign
in.

> **Leave `ADMIN_PASSWORD` blank** if you would rather not have a password in a
> file. Create the account afterwards instead:
> ```bash
> docker compose exec api node apps/api/dist/cli/index.js admin create --role OWNER
> ```
> Either way, delete or blank the value once the account exists — it is only
> read on first boot.

### What happens on `docker compose build`

Worth knowing, because it is where a private fork usually first goes wrong:

- The API image builds the panel **and** the agent, then re-resolves its
  dependency tree without dev packages. It does that with a production
  install rather than `pnpm prune --prod`, which in a workspace removes the
  `@storm/*` links too and leaves an image that starts and immediately exits.
- It then builds `dist/storm-agent.tar.gz` and ships it, which is what
  `/install/storm-agent.tar.gz` serves to your nodes.
- The seed is compiled rather than run through `tsx`, because `tsx` is a dev
  dependency the image does not carry.
- The web image bakes its API target at build time (Next resolves `rewrites()`
  when it builds), so it is a build argument, not a runtime variable. In this
  deployment nginx routes `/api` to the API regardless.

### What Compose brings up

| Service | Image | Notes |
| --- | --- | --- |
| `postgres` | postgres:16-alpine | Data in the `storm_postgres` volume |
| `redis` | redis:7-alpine | Sessions, queues, rate limits |
| `migrate` | built from `docker/api.Dockerfile` | Runs once, then exits 0 |
| `api` | built from `docker/api.Dockerfile` | Fastify + BullMQ workers |
| `web` | built from `docker/web.Dockerfile` | Next.js standalone |
| `nginx` | nginx:1.27-alpine | One origin for both |

Two optional profiles: `--profile storage` adds MinIO for S3-compatible
backups, `--profile agent` runs a node agent on the panel host.

---

## 2. Put TLS in front of it

The panel serves HTTP on `HTTP_PORT` (80 by default). Session cookies are
`httpOnly` and `sameSite=lax`; with `COOKIE_SECURE=true` they are also
`secure`, which means the panel stops working over plain HTTP. So terminate TLS
before you flip it.

The simplest route is a reverse proxy on the host in front of nginx.

**Caddy** — certificates handled for you:

```
panel.example.com {
    reverse_proxy 127.0.0.1:80
}
```

**nginx with certbot** — set `HTTP_PORT=8000` in `.env` first, so the host's
nginx can own 80 and 443:

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Console and dashboard websockets.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

`proxy_read_timeout` matters: without it an idle console drops after 60
seconds.

Then:

```bash
sed -i 's|^APP_URL=.*|APP_URL=https://panel.example.com|' .env
sed -i 's|^COOKIE_SECURE=.*|COOKIE_SECURE=true|'          .env
docker compose up -d
```

---

## 3. Register your first node

In the panel: **Admin → Nodes → Add node**.

| Field | Meaning |
| --- | --- |
| Name | How it appears in the panel, e.g. `fsn-1` |
| Location | Free text shown to customers when they pick a region |
| Hostname | The DNS name the panel connects to — **and** the address customers use for SFTP |
| IP address | The node's public address |
| Scheme | `https` if the agent has a certificate, `http` if it does not. Get this wrong and the panel reports the node unreachable |
| Daemon port | 8081 unless you changed it |
| SFTP port | 2022 unless you changed it |
| Memory / disk | What the node may allocate, in MB. Reserve room for the host |
| Overcommit | Percentage you allow beyond that — `0` for none, `25` to allow a quarter more than the node physically has |
| Maintenance mode | On means the node keeps running its servers but is not offered for new ones |

Saving it mints a token pair: a token id, a token, and an HMAC secret. The
token is stored as a digest and the secret encrypted at rest, so **the panel
shows the plaintext once**. Copy the configuration block it gives you.

### All on one machine

For a single box running both the panel and its servers, the panel reaches the
agent over the container network while customers still need a routable address
for SFTP. Register the node with both:

```bash
docker compose exec api node apps/api/dist/cli/index.js node create \
  --name main --location "Falkenstein" \
  --hostname agent --scheme http \
  --ip 10.0.0.2 --public-ip 203.0.113.10
```

`--hostname agent` is the Compose service name, so panel-to-agent traffic never
leaves the host and port 8081 needs no firewall hole at all. `--public-ip` is
what customers see for SFTP. Then bring the agent up with the credentials it
printed:

```bash
docker compose --profile agent up -d
```

Lost the token? `Admin → Nodes → <node> → Tokens → Rotate`, or from the CLI:

```bash
docker compose exec api node apps/api/dist/cli/index.js node token fsn-1
```

Rotating invalidates the old credentials, so update the agent afterwards.

---

## 4. Install the agent on the node

On the node, as root:

```bash
curl -fsSL https://panel.example.com/install/node.sh -o install-node.sh
less install-node.sh          # read it before you pipe anything to a shell
sudo bash install-node.sh
```

It refuses to run on anything but Ubuntu 22.04+/24.04+ or Debian 12+, then:

1. installs Docker Engine and Node 20 if they are missing;
2. creates the `storm_net` bridge with inter-container communication disabled,
   so servers cannot talk to each other;
3. creates `/etc/storm/agent.env` mode 0600, owned by root;
4. installs a hardened systemd unit (`NoNewPrivileges`, `ProtectSystem=strict`,
   `PrivateTmp`, a restricted syscall filter, and write access to only its own
   data directories);
5. starts `storm-agent` and waits for `/health` to answer.

It asks for the values from step 3, or takes them from the environment for an
unattended install:

```bash
sudo STORM_PANEL_URL=https://panel.example.com \
     STORM_NODE_UUID=... \
     STORM_TOKEN_ID=... \
     STORM_TOKEN=... \
     STORM_SECRET=... \
     bash install-node.sh
```

Check it:

```bash
systemctl status storm-agent
journalctl -u storm-agent -f
curl -s localhost:8081/health
```

The node should flip to **online** in the panel within 30 seconds, reporting
its real Docker version, core count and memory. If it does not, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#a-node-never-comes-online).

### Firewall

```bash
ufw allow 22/tcp
ufw allow from <panel-ip> to any port 8081 proto tcp
ufw allow 2022/tcp
ufw allow 25565:25665/tcp     # whatever ranges you allocate
ufw enable
```

Port 8081 only ever needs to be reachable from the panel. Do not open it to the
world.

---

## 5. Give the node ports

A server cannot be created without an allocation. **Admin → Nodes → <node> →
Allocations → Add range**: enter the node's public IP and a range such as
`25565-25665`. The panel refuses overlapping ranges, and an allocation already
assigned to a server can never be handed to another one.

---

## 6. Create a server

**Servers → Create server** walks through game, node, resources and startup
variables. On save the panel picks a free allocation, writes the server, and
queues an install job: the agent pulls the install image, runs the template's
install script against a fresh data directory, then creates the game container.

Watch it in the server's **Console** tab — install output streams live. When it
finishes the status moves to `OFFLINE`, and **Start** brings it up.

---

## Optional pieces

### SMTP

Without it the panel works fine; verification and password-reset links are
written to the API log instead of being sent. With it:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=panel@example.com
SMTP_PASSWORD=...
SMTP_SECURE=false           # true only for implicit TLS on 465
MAIL_FROM=Storm Panel <no-reply@example.com>
```

Then **Admin → Settings → Require email verification** if you want new accounts
to confirm their address.

### S3-compatible backup storage

**Admin → Backup storage → Add**: endpoint, region, bucket, access key, secret.
The secret is encrypted with `ENCRYPTION_KEY` before it is stored. Works with
AWS S3, Cloudflare R2, Backblaze B2 and MinIO. Details in
[BACKUPS.md](BACKUPS.md).

For a local MinIO:

```bash
docker compose --profile storage up -d
```

### Database hosts

**Admin → Database hosts → Add** registers a MySQL/MariaDB or PostgreSQL server
the panel may provision customer databases on. The panel needs an account there
that can `CREATE DATABASE` and `CREATE USER`. **Test connection** proves it
before you save. Each customer database gets its own user, restricted to that
one database.

---

## Verifying the install

```bash
# Every container healthy, `migrate` exited 0
docker compose ps

# Liveness and readiness
curl -s http://localhost/health
curl -s http://localhost/api/health

# Configuration, database and Redis, from inside the API container
docker compose exec api node apps/api/dist/cli/index.js doctor
```

`doctor` checks the database connection and migration state, Redis, the length
of every required secret, whether an owner account exists, and whether any node
has missed its heartbeat.

Then, in a browser: sign in, open a server's console and watch a line arrive,
and open its file manager. That exercises the API, the websocket relay and the
agent in turn — if those three work, the install is sound.

---

## Upgrading

```bash
cd /opt/storm-panel
docker compose exec postgres pg_dump -U storm storm | gzip > ~/storm-$(date +%F).sql.gz

git pull
docker compose build
docker compose up -d
```

The `migrate` service applies new migrations before the API restarts. Migrations
are forward-only; roll back by restoring the dump.
