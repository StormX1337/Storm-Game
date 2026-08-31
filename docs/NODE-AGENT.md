# Node agent

The agent is the only component that touches Docker or a game server's files.
The panel never does — it asks the agent, over an authenticated and signed
channel, and relays the answers.

One agent per node. It is deliberately small: no database, no user accounts, no
business logic. Everything it knows about a server arrives from the panel.

- [What it does](#what-it-does)
- [Installation](#installation)
- [Configuration](#configuration)
- [Protocol](#protocol)
- [HTTP surface](#http-surface)
- [Websocket](#websocket)
- [How a server runs](#how-a-server-runs)
- [SFTP](#sftp)
- [Operations](#operations)
- [Upgrading](#upgrading)

---

## What it does

- Creates, starts, stops, restarts, kills, recreates and destroys containers
- Streams console output and accepts commands on stdin
- Reports CPU, memory, disk, network and uptime from cgroup counters
- Runs install scripts in a throwaway container
- Serves the file manager: list, read, write, upload, download, search,
  rename, copy, delete, mkdir, compress, decompress, chmod
- Creates and restores backups, locally or to S3-compatible storage
- Runs an SFTP server, chrooted per server, authenticated against the panel
- Reports node health and its own resource picture on a heartbeat

---

## Installation

Add the node in the panel first — **Admin → Nodes → Add node** — then open its
**Agent configuration**.

### One command

Press **Create install command** and run what it gives you on the node:

```bash
curl -fsSL https://panel.example.com/install/node.sh | sudo bash -s -- \
  --panel-url https://panel.example.com --claim <claim>
```

The installer redeems the claim over HTTPS, writes `/etc/storm/agent.env`
itself, and asks nothing. Nothing has to be copied onto the machine, which makes
this the only workable route when the only thing you have is a phone and an SSH
app.

A claim is worth **one node's configuration, once, within fifteen minutes**.
Redeeming it mints the node's token; a second attempt with the same claim is
refused, so a claim left in a scrollback is not a way in. The panel stores only
its digest, exactly as it does for the node tokens themselves.

Piping a script into a shell is worth being deliberate about. To read it first:

```bash
curl -fsSL https://panel.example.com/install/node.sh -o install-node.sh
less install-node.sh
sudo bash install-node.sh --panel-url https://panel.example.com --claim <claim>
```

### Or with the file

Press **Download** instead, put it on the node, and run the installer:

```bash
install -d -m 700 /etc/storm
# from your laptop:  scp agent.env root@node:/etc/storm/agent.env
chmod 600 /etc/storm/agent.env

curl -fsSL https://panel.example.com/install/node.sh -o install-node.sh
sudo bash install-node.sh
```

The installer reads `/etc/storm/agent.env` if it is already there and asks
nothing. `--config <file>` points it at the file somewhere else. Without any of
the three it prompts for the five values, which is the fallback, not the
intended path.

Supported: Ubuntu 22.04+, Ubuntu 24.04+, Debian 12+, x86_64 or arm64. The
script refuses anything else rather than half-working.

It installs Docker Engine and Node 20 if missing, creates the `storm_net`
bridge with inter-container communication disabled, rewrites
`/etc/storm/agent.env` mode 0600 with the full set of settings, installs a
hardened systemd unit, starts it, and waits for `/health`.

Unattended, without a file:

```bash
sudo STORM_PANEL_URL=https://panel.example.com \
     STORM_NODE_UUID=… STORM_TOKEN_ID=… STORM_TOKEN=… STORM_SECRET=… \
     bash install-node.sh
```

Prefer the environment over flags for the secrets: a flag is readable in `ps`
by anyone on the box for as long as the installer runs.

### Reopening the configuration

Opening **Agent configuration** again issues a new token and revokes any earlier
one the node never used — so old screenshots and scrollbacks stop being a way
in. The token a running node is authenticating with is left alone, so looking at
the page cannot take a node offline. To deliberately replace the credential a
node is using, `storm node token <name>` on the panel host.

### By hand

```bash
git clone https://github.com/your-org/storm-panel.git /opt/storm-panel
cd /opt/storm-panel
pnpm install --frozen-lockfile
pnpm --filter @storm/node-agent build

install -d -m 700 /etc/storm
$EDITOR /etc/storm/agent.env && chmod 600 /etc/storm/agent.env
systemctl enable --now storm-agent
```

---

## Configuration

`/etc/storm/agent.env`:

```dotenv
# Where the panel lives. Must be reachable from this node.
PANEL_URL=https://panel.example.com

# From the panel when the node was registered.
NODE_UUID=…
AGENT_TOKEN_ID=…
AGENT_TOKEN=…
AGENT_SECRET=…

# Where the agent listens. Firewall this to the panel.
AGENT_HOST=0.0.0.0
AGENT_PORT=8081

# SFTP. This one is for customers.
SFTP_ENABLED=true
SFTP_PORT=2022
SFTP_HOST_KEY_PATH=/etc/storm/sftp_host_key

# Server data and backups. Both need space.
DATA_DIRECTORY=/var/lib/storm/servers
BACKUP_DIRECTORY=/var/lib/storm/backups

# Docker.
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_NETWORK=storm_net

# How often to report in, in seconds.
HEARTBEAT_INTERVAL=20
CONSOLE_BUFFER_LINES=400
LOG_LEVEL=info
```

Mode 0600, owned by root. `AGENT_TOKEN` and `AGENT_SECRET` are the node's
identity — anything holding them is that node.

For TLS on the agent itself, set `TLS_CERT_PATH` and `TLS_KEY_PATH` — and set
the node's **scheme** to `https` in the panel to match (`storm node create
--scheme http` for an agent without a certificate). A mismatch shows up as
"node is not reachable", because the panel is speaking TLS to a plain HTTP
port. If the
_panel_ uses a self-signed certificate, the agent needs
`PANEL_ALLOW_SELF_SIGNED=true` to call back to it — a lab setting, not a
production one. The panel has the mirror-image switch,
`AGENT_ALLOW_SELF_SIGNED`, for agents with self-signed certificates.

---

## Protocol

**Panel → agent.** Every request carries:

```
authorization:      Bearer <AGENT_TOKEN_ID>
x-storm-timestamp:  <unix seconds>
x-storm-signature:  <hex HMAC-SHA256>
```

The Authorization header names the credential; it does not prove anything on
its own. Possession of the secret is proven by the signature, which covers
`METHOD\nPATH\nTIMESTAMP\nHASH(body)` and is keyed with `AGENT_SECRET`. The secret never crosses the wire. A captured request cannot be
replayed against another node or another route, and a timestamp outside a tight
window is rejected. Comparison is constant-time.

**Agent → panel.** Heartbeats, state changes, stats and SFTP credential checks
use `Authorization: Bearer <AGENT_TOKEN>`; the panel stores only its digest.

The heartbeat runs every 15 seconds and carries the Docker version, core count,
total and free memory, disk usage, running container count, and the agent's own
version. Miss enough of them and the panel marks the node offline and stops
routing work to it.

---

## HTTP surface

Everything below is signed. There is no unauthenticated endpoint except
`/health`.

### Node

|                     |                                             |
| ------------------- | ------------------------------------------- |
| `GET /health`       | Liveness — Docker reachable, disk writable  |
| `GET /system`       | Docker version, kernel, cores, memory, disk |
| `GET /system/stats` | Live load, memory and disk                  |
| `GET /servers`      | Which servers this node believes it has     |

### Servers

|                               |                                             |
| ----------------------------- | ------------------------------------------- |
| `PUT /servers`                | Create or reconcile a container from a spec |
| `GET /servers/:uuid`          | State, container id, resource picture       |
| `DELETE /servers/:uuid`       | Destroy container, volumes and data         |
| `POST /servers/:uuid/power`   | `start` · `stop` · `restart` · `kill`       |
| `POST /servers/:uuid/command` | Write a line to stdin                       |
| `GET /servers/:uuid/stats`    | Current stats                               |
| `GET /servers/:uuid/logs`     | Recent console buffer                       |
| `POST /servers/:uuid/install` | Run the install script                      |

`PUT /servers` is idempotent: it compares the spec with what exists and
recreates the container only when something material changed. That makes
"re-sync this node" a safe thing to do at any time.

### Files

Relative paths only, all resolved inside the server's directory.

|                                              |                                       |
| -------------------------------------------- | ------------------------------------- |
| `GET /servers/:uuid/files/list`              | Listing with sizes, modes, timestamps |
| `GET /servers/:uuid/files/contents`          | Read a text file                      |
| `GET /servers/:uuid/files/download`          | Stream a file                         |
| `GET /servers/:uuid/files/search`            | Search names and contents             |
| `POST /servers/:uuid/files/write`            | Create or overwrite                   |
| `POST /servers/:uuid/files/upload`           | Multipart, streamed to disk           |
| `POST /servers/:uuid/files/rename`           | Rename or move                        |
| `POST /servers/:uuid/files/copy`             | Copy                                  |
| `POST /servers/:uuid/files/delete`           | Delete                                |
| `POST /servers/:uuid/files/create-directory` | mkdir -p                              |
| `POST /servers/:uuid/files/compress`         | tar.gz or zip                         |
| `POST /servers/:uuid/files/decompress`       | Extract, re-validating every entry    |
| `POST /servers/:uuid/files/chmod`            | Change mode                           |

### Backups

|                                                   |                          |
| ------------------------------------------------- | ------------------------ |
| `POST /servers/:uuid/backups`                     | Create; streams progress |
| `POST /servers/:uuid/backups/:backupUuid/restore` | Restore                  |
| `GET /servers/:uuid/backups/:backupUuid/download` | Stream an archive        |
| `DELETE /servers/:uuid/backups/:backupUuid`       | Delete                   |

---

## Websocket

```
wss://node.example.com:8081/servers/:uuid/socket
```

The panel connects with the same signature scheme in the query string.
Customers never connect here — they connect to the panel, which relays.

Agent → panel: `console`, `console:history`, `status`, `stats`, `install`,
`error`. Panel → agent: `command`, `power`, `logs`, `ping`.

Console output is demultiplexed from Docker's stream framing (stdout and
stderr are interleaved with an 8-byte header on non-TTY containers), buffered
per server, and trimmed so a chatty server cannot exhaust memory.

---

## How a server runs

**Install.** The agent creates the data directory, pulls the install image,
and runs the template's install script in a throwaway container with the data
directory mounted and the server's variables in the environment. Output streams
to the panel line by line. The install container is removed when it exits, and
its work is `chown`ed to uid 1000 so the unprivileged game process can use it.

**Create.** The agent creates the game container from the template's image with
the resource limits, port bindings, environment and hardening flags described
in [SECURITY.md](SECURITY.md#container-isolation). It attaches, but does not
start.

**Start.** First the agent rewrites any configuration files the template maps
(`server.properties` and friends) so the game's own settings agree with the
allocation the panel gave it — see
[GAME-TEMPLATES.md](GAME-TEMPLATES.md#config-files). Then the container starts
and the agent watches stdout for the template's `startupDetection` pattern. Until it matches, the server is `STARTING`; when it
matches, `ONLINE`. That is why a Minecraft server does not claim to be online
until it says `Done (…)`.

**Stop.** The template's `stopCommand` (usually `stop`, `quit` or `^C`) is
written to stdin, giving the game a chance to save. If it has not exited within
the grace period, the agent kills it.

**Crash.** If the container exits without a stop having been requested, or its
output matches the template's `crashDetection` pattern, the agent reports
`CRASHED`. The panel records it, notifies the owner and leaves the server
stopped — restarting a server that has just died usually produces a crash loop
rather than a working server. A schedule can restart it on a cadence if that is
what you want.

---

## SFTP

The agent runs its own SSH server on `SFTP_PORT`. It is not OpenSSH, it does
not read `/etc/passwd`, and it grants no shell.

Usernames are `<username>.<serverShortId>`. On login the agent asks the panel
whether that user may access that server; the panel answers against the same
ownership and sub-user rules the web file manager uses. There are no local
accounts on the node to compromise.

Each session is confined to its server's directory. The same path resolution
and symlink checks apply as everywhere else, so `cd /` in an SFTP client lands
at the server's root, not the host's.

The host key is generated on first start and persisted, so clients do not see a
changed-key warning after a restart.

---

## Operations

```bash
systemctl status storm-agent
systemctl restart storm-agent
journalctl -u storm-agent -f
journalctl -u storm-agent -p err --since '1 hour ago'

curl -s localhost:8081/health

docker ps --filter name=storm-
docker stats --no-stream --filter name=storm-
du -sh /var/lib/storm/servers/*
```

The agent's own logs are JSON. Game server output does not go to the journal —
it goes to the panel and to Docker's rotated json-file logs.

### Disk

Server data lives in `DATA_DIRECTORY/<server-uuid>`, backups in
`BACKUP_DIRECTORY`. Both grow. Watch them:

```bash
df -h /var/lib/storm
du -sh /var/lib/storm/backups/*
```

Backup retention is applied by the panel's hourly maintenance job, which
deletes the archive and its record together. A node that was offline when a
backup expired keeps its archive until the panel next reaches it — if a node
has been away for a long time, compare `BACKUP_DIRECTORY` against the backups
the panel lists for its servers before assuming the disk usage is real.

---

## Upgrading

Agents and panels talk a versioned protocol. The panel refuses an agent
reporting a major version it does not understand rather than guessing.

```bash
cd /opt/storm-panel
git pull
pnpm install --frozen-lockfile
pnpm --filter @storm/node-agent build
systemctl restart storm-agent
```

Restarting the agent does **not** stop running game servers — containers are
independent of it. The console reconnects when it comes back. Upgrade nodes one
at a time and watch the first one before moving on.
