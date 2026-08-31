# Command line

`storm` does the things a browser cannot: the first install, recovering an
account nobody can sign into any more, registering a node before the panel knows
it exists, and telling you which dependency is actually down.

Everything here reads the same `.env` the API does, and talks to Postgres and
Redis directly. It does not need the API to be running.

- [Running it](#running-it)
- [Installation](#installation)
- [Accounts](#accounts)
- [Nodes](#nodes)
- [Servers](#servers)
- [Diagnostics](#diagnostics)
- [Secrets and identifiers](#secrets-and-identifiers)
- [Recovery](#recovery)

---

## Running it

**Docker deployment** — inside the API container, which already has the
environment:

```bash
docker compose exec api node apps/api/dist/cli/index.js doctor
```

Worth an alias on a machine you administer often:

```bash
alias storm='docker compose -f /opt/storm/docker-compose.yml exec api node apps/api/dist/cli/index.js'
```

**From a checkout**:

```bash
pnpm storm doctor
```

Both accept `--help` at any depth — `storm node create --help` lists the flags
that command takes, and is more current than this page can be.

```
Commands:
  install [options]  Run migrations, seed reference data and create the first
                     owner account
  migrate            Apply pending database migrations
  seed               Re-run the idempotent seed (roles, permissions, templates,
                     settings)
  admin              Administrator account management
  node               Node management
  server             Server management
  doctor             Check that the panel can reach everything it depends on
  key:generate       Generate strong values for the required secrets
  id                 Generate a readable identifier (useful for scripting)
```

---

## Installation

### `storm install`

Migrates the schema, seeds reference data, and creates the first owner account —
the whole first-run sequence. Docker Compose runs the equivalent through its
`migrate` service, so this is for installs that are not using Compose.

```bash
storm install
storm install --skip-migrate     # schema is already current
```

### `storm migrate`

Applies pending migrations and nothing else. This is `prisma migrate deploy`
with the panel's own environment loading, which matters because a mistyped
`DATABASE_URL` fails here with a readable message rather than a Prisma stack
trace.

### `storm seed`

Re-runs the seed. It is idempotent — it upserts roles, permissions, game
templates and default settings, and leaves user data alone:

```
  permissions: 42
  roles: 5
  game templates: 12
  backup storage: ok
  settings: 14
```

Run it after an upgrade that adds a permission or a game template.

It **does** reset the twelve built-in templates to their shipped definitions —
startup command, install script, variables and all. Edits you made to one of
them in the panel are lost. Templates you created yourself have their own slugs
and are never touched, so clone a built-in before changing it if you want the
change to survive a seed.

---

## Accounts

### `storm admin create`

```bash
storm admin create --email you@example.com --username you --role OWNER
```

| Flag                        |                                                                      |
| --------------------------- | -------------------------------------------------------------------- |
| `-e, --email <email>`       |                                                                      |
| `-u, --username <username>` |                                                                      |
| `-p, --password <password>` | Omit it and a strong one is generated and printed                    |
| `-r, --role <role>`         | `OWNER`, `ADMIN`, `STAFF`, `SUPPORT` or `CUSTOMER` (default `ADMIN`) |

Omitting `--password` is the better habit: a password on the command line is in
your shell history and in `ps` output for as long as the process runs.

### `storm admin list`

```
6 account(s)
  ● jordan@example.com               jordan               OWNER     active
  ● sam@example.com                  sam                  ADMIN     active
```

`-r, --role <role>` filters by role, `-q, --search <term>` matches an email or
username.

### `storm admin password <email>`

Generates a new password, prints it, and revokes every session that account has
open — a stolen session must not survive the reset that was meant to end it.
There is no flag to supply the password: what you would type is what an attacker
reads out of your shell history.

### `storm admin disable-2fa <email>`

Removes two-factor authentication from an account that cannot get past it —
authenticator app gone, backup codes gone. Verify who you are talking to first;
this is the step that turns "I lost my phone" into "I am in your panel".

---

## Nodes

### `storm node create`

Registers a node and prints the agent configuration to put on it. See
[NODE-AGENT.md](NODE-AGENT.md) for what to do with that output.

```bash
storm node create \
  --name frankfurt-1 \
  --location "Frankfurt, DE" \
  --hostname node1.example.com \
  --ip 203.0.113.10
```

| Flag                        | Default                                     |
| --------------------------- | ------------------------------------------- |
| `-n, --name <name>`         | required                                    |
| `-l, --location <location>` | required                                    |
| `-H, --hostname <hostname>` | required — what the panel connects to       |
| `-i, --ip <ip>`             | required                                    |
| `--public-ip <ip>`          | `--ip` — the address customers see for SFTP |
| `--scheme <scheme>`         | `https`                                     |
| `--agent-port <port>`       | `8081`                                      |
| `--sftp-port <port>`        | `2022`                                      |
| `--cpu <cores>`             | `4`                                         |
| `--memory <mib>`            | `16384`                                     |
| `--disk <mib>`              | `204800`                                    |

`--public-ip` matters behind NAT: the panel may reach the node on a private
address while customers need the public one.

The agent token is printed **once**. It is stored encrypted, so it cannot be
shown again — issue a new one instead.

### `storm node token <name>`

Issues a fresh token and revokes every previous one for that node. The node
stops answering until its configuration carries the new values and the agent has
restarted — which is the behaviour you want when a token has leaked, and the
reason to schedule it rather than run it at random.

`--keep-existing` leaves the old tokens valid, for handing a second credential
to a replacement host before retiring the first.

### `storm node list`

```
2 node(s)
  ● frankfurt-1            Frankfurt, DE        7 servers    24 ports  203.0.113.10
  ● helsinki-1             Helsinki, FI         0 servers     0 ports  203.0.113.11
```

Green is `ONLINE`, red `OFFLINE`, yellow anything in between — a node
provisioning, or one the panel has not heard from yet.

---

## Servers

### `storm server list`

```
2 server(s)
  ● PHTfYqzK  Community Survival         RUNNING        frankfurt-1      jordan
  ● Zf5VAVE7  Test box                   INSTALL_FAILED frankfurt-1      sam
```

`--node <name>` limits it to one node — useful before taking that node down.

### `storm server suspend <shortId>` / `unsuspend <shortId>`

Suspending stops the container and blocks the owner from starting it, without
touching their files. This is the billing lever, and it is scriptable:

```bash
storm server suspend PHTfYqzK
```

---

## Diagnostics

### `storm doctor`

The first thing to run when something is wrong.

```
Storm Panel diagnostics
✔ Environment configuration is valid
✔ Database reachable
  Users           6
  Nodes           2
  Servers         2
  Templates       13
✔ Redis reachable
✔ Secrets are long enough and distinct
✔ Schema is up to date (2 migrations)
✔ Every node has checked in recently
```

It checks that:

- the environment parses, and the three secrets are long enough **and different
  from each other** — reusing one value for all three passes validation and
  quietly ties three unrelated compromises together;
- Postgres answers, and every migration on disk is applied and finished. A
  half-applied migration is behind a whole family of confusing "column does not
  exist" errors and shows up nowhere else;
- Redis answers;
- an owner account exists;
- every node has sent a heartbeat in the last five minutes. A node the panel has
  stopped hearing from still looks fine in a server list — the servers on it are
  what stop responding.

A failing check exits non-zero, so it works as a deployment gate:

```bash
storm doctor || exit 1
```

Missing nodes and a missing owner are warnings, not failures: a panel with no
nodes yet is a panel mid-installation, not a broken one.

Each failure names the dependency and repeats the underlying error, which is
usually enough to tell a wrong password from an unreachable host.

---

## Secrets and identifiers

### `storm key:generate`

```
Generated secrets — copy into your .env
JWT_SECRET=...
ENCRYPTION_KEY=...
COOKIE_SECRET=...
```

The same values `scripts/generate-secrets.sh` produces, for when you have the
panel but not the repository.

**`ENCRYPTION_KEY` cannot be rotated by generating a new one.** Node tokens,
database host passwords, SFTP passwords and 2FA seeds are all encrypted with it;
changing it makes every one of them permanently unreadable.

### `storm id`

Prints one readable identifier in the same alphabet the panel uses for servers
(`uANgY2uQ`) — for scripts that need a name nothing else will collide with.

---

## Recovery

**Nobody can sign in.** `storm admin list` to see which accounts exist and what
role each has, then `storm admin password <email>`. If no `OWNER` is left,
`storm admin create --role OWNER`.

**Locked out by 2FA.** `storm admin disable-2fa <email>`.

**The panel loads but nothing works.** `storm doctor`. It separates "the
database is down" from "the panel cannot parse its own configuration", which
look identical from a browser.

**A node stopped responding.** `storm node list` for the panel's view, then
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the agent side. If the token is the
suspect, `storm node token <name>` and update the agent config.

**A template or permission is missing after an upgrade.** `storm seed`.
