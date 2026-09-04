# Troubleshooting

Symptoms, in the order people actually hit them. Each entry says how to
confirm the cause before changing anything — the fastest fix is usually the
second thing you try, after you have stopped guessing.

- [First moves](#first-moves)
- [The panel will not start](#the-panel-will-not-start)
- [I pulled, but the panel looks the same](#i-pulled-but-the-panel-looks-the-same)
- [The update asks for a GitHub username](#the-update-asks-for-a-github-username)
- [Cannot sign in](#cannot-sign-in)
- [A node never comes online](#a-node-never-comes-online)
- [A server will not install](#a-server-will-not-install)
- [A server will not start](#a-server-will-not-start)
- [A server is online but unreachable](#a-server-is-online-but-unreachable)
- [The console is blank or disconnected](#the-console-is-blank-or-disconnected)
- [File manager problems](#file-manager-problems)
- [SFTP problems](#sftp-problems)
- [Backup problems](#backup-problems)
- [Database problems](#database-problems)
- [Schedules do not run](#schedules-do-not-run)
- ["Server is running out of memory"](#server-is-running-out-of-memory)
- [Slow panel](#slow-panel)
- [Emails never arrive](#emails-never-arrive)
- [Collecting diagnostics](#collecting-diagnostics)

---

## First moves

```bash
docker compose ps                                   # what is up
curl -s http://localhost/api/health | jq            # what it thinks of itself
docker compose exec api node apps/api/dist/cli/index.js doctor
docker compose logs --tail=100 api
```

`storm doctor` checks configuration, the database and its migration state,
Redis, secret lengths, whether an owner exists and whether any node has gone
quiet. It is the fastest way to rule out the boring causes.

Every API error response carries `x-request-id`, and every log line for that
request carries the same id:

```bash
docker compose logs api | grep <request-id>
```

---

## The panel will not start

**`api` exits immediately**

```bash
docker compose logs api | head -40
```

| Message                                     | Cause                                                      |
| ------------------------------------------- | ---------------------------------------------------------- |
| `JWT_SECRET must be at least 32 characters` | Secrets not generated. Run `./scripts/generate-secrets.sh` |
| `Can't reach database server`               | PostgreSQL not up, or `DATABASE_URL` wrong                 |
| `P1000: Authentication failed`              | `POSTGRES_PASSWORD` changed after the volume was created   |
| `ECONNREFUSED …:6379`                       | Redis not up                                               |

The password case catches people: PostgreSQL only reads `POSTGRES_PASSWORD` when
it initialises its data directory. Changing it later changes what the API
sends, not what the database expects. Either set it back, or:

```bash
docker compose exec postgres psql -U storm -c "ALTER USER storm PASSWORD 'new-password';"
```

**`migrate` fails**

```bash
docker compose logs migrate
```

A failed migration leaves the schema untouched. Read the error, fix the cause,
then `docker compose up -d migrate`. If a migration is recorded as failed and
you have restored the database from before it:

```bash
docker compose run --rm migrate npx prisma migrate resolve --rolled-back <migration>
```

**nginx restarts in a loop and nothing answers, on 80 either**

```bash
docker compose logs --tail=20 nginx
```

A line beginning `storm: serving HTTP only` names the reason and the panel
stays up on HTTP. If instead you see `cannot load certificate key`, the
container is from before that check existed — `git pull` and rebuild.

The usual cause is a certificate or key that did not survive being pasted into
an editor. Check the files themselves:

```bash
openssl pkey -in docker/nginx/certs/origin.key -noout && echo "key ok"
openssl x509 -in docker/nginx/certs/origin.pem -noout -subject -enddate

# And that the two actually belong together — these must print the same hash:
openssl x509 -in docker/nginx/certs/origin.pem -noout -pubkey | openssl sha256
openssl pkey -in docker/nginx/certs/origin.key -pubout | openssl sha256
```

An editor that indents pasted lines is the classic culprit: PEM does not
survive leading spaces. `grep -n '^ ' docker/nginx/certs/origin.key` finds it.
Write the files with a here-document instead of an editor and the problem goes
away.

**`web` builds but shows a blank page**

Check the browser console. A 502 from `/api` means nginx cannot reach the API —
`docker compose ps api`. Stale build output after an upgrade:
`docker compose build --no-cache web`.

---

## I pulled, but the panel looks the same

Almost always this: **`git pull` updates the files on disk, and the panel is
served from Docker images.** The frontend is compiled into the image by `next
build` when the image is built, so until you rebuild, the browser is showing the
code from whenever that image was made — however current the checkout is.

```bash
docker compose exec api printenv STORM_COMMIT   # what is actually running
git rev-parse HEAD                              # what is checked out
```

Different values, or an empty first one, mean a rebuild is due:

```bash
./scripts/update.sh
```

It handles this case explicitly — a current checkout with stale images makes it
rebuild rather than report nothing to do. By hand:

```bash
export STORM_COMMIT=$(git rev-parse HEAD)
export STORM_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose build && docker compose up -d
```

If the values match and the page is still old, it is the browser: hard-reload,
or open the panel in a private window. Next fingerprints its assets, so a stale
`/_next/static` file is unusual — but a service worker or an aggressive
Cloudflare rule can still hold an old HTML shell. Purge the Cloudflare cache for
the hostname before suspecting the panel.

Two things that are **not** the cause: the database (no migration changes what
the sidebar renders) and the API container (it serves data, not pages).

---

## The update asks for a GitHub username

```
==> Checking for changes
Username for 'https://github.com':
```

Git is being asked to authenticate and has nowhere to get a credential. Two
things cause it, and they need the same fix:

- **The repository is private.** Anonymous HTTPS access to it is refused.
- **GitHub is rate limiting anonymous requests from this address.** Unauthenticated
  git operations are capped per IP, and a host that checks often can hit the
  cap. This one is intermittent, which is the tell: the same command worked
  ten minutes ago.

Which one it is:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/OWNER/REPO
```

`200` means the repository is public, so it is the rate limit. `404` means it is
private, or does not exist under that name.

Either way, store a token once:

```bash
git config --global credential.helper store
git pull    # username, then a personal access token as the password
```

A token with `repo` scope for a private repository; any token lifts the
anonymous rate limit. Or use SSH, if the host has a deploy key:

```bash
git remote set-url origin git@github.com:OWNER/REPO.git
```

`scripts/update.sh` no longer waits at that prompt — it fails immediately and
says this instead. That matters most for the host-side updater, which runs it as
a service with no terminal: a prompt there would hang the update indefinitely
while the panel showed it as still running.

---

## Cannot sign in

**"Those credentials do not match our records"** is deliberately the same
answer for a wrong password, an unknown account and a suspended one. To find
out which:

```bash
docker compose exec api node apps/api/dist/cli/index.js admin list
```

Reset a password without email:

```bash
docker compose exec api node apps/api/dist/cli/index.js admin password you@example.com
```

**"Too many attempts."** The account is temporarily locked, or the IP bucket is
exhausted. Both clear on their own; the message says when. To clear it now:

```bash
docker compose exec redis redis-cli --scan --pattern 'storm:login:*' |
  xargs -r docker compose exec -T redis redis-cli DEL
```

**2FA code rejected.** Almost always clock drift on the phone or the server —
TOTP allows ±30 seconds. Check `timedatectl` on the host and enable NTP. Use a
backup code to get in, then:

```bash
docker compose exec api node apps/api/dist/cli/index.js admin disable-2fa you@example.com
```

**Signed in, then immediately signed out.** The session cookie is not coming
back. Either `COOKIE_SECURE=true` while serving plain HTTP — the browser
refuses to send it — or `APP_URL` does not match the address in the address
bar. Fix `.env` and `docker compose up -d`.

**Everyone was signed out at once.** Expected after `JWT_SECRET` changes, Redis
is flushed, or a refresh token was replayed and the session family was revoked.
The last one is a security event: check the audit log.

---

## A node never comes online

Work outward from the node.

```bash
# On the node
systemctl status storm-agent
journalctl -u storm-agent -n 100 --no-pager
curl -s localhost:8081/health
```

| Symptom                                              | Cause                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Unit not running                                     | Read the journal — usually a malformed `/etc/storm/agent.env`                                                                  |
| `Cannot connect to the Docker daemon`                | Docker is not running, or the socket path is wrong                                                                             |
| `401` from the panel                                 | Token mismatch. Rotate: `storm node token <name>` and update the agent                                                         |
| `ENOTFOUND panel.example.com`                        | The node cannot resolve the panel — check `PANEL_URL` and DNS                                                                  |
| Healthy locally, offline in the panel                | The **panel** cannot reach the node                                                                                            |
| `packet length too long` / TLS errors in the API log | The node is registered as `https` but the agent serves plain HTTP. Fix the scheme on the node, or give the agent a certificate |

That last one is the common case. From the panel host:

```bash
curl -v http://node.example.com:8081/health
```

A hang means a firewall. Port 8081 must be open from the panel to the node —
and only from the panel.

```bash
# On the node
ufw allow from <panel-ip> to any port 8081 proto tcp
```

**Signature errors** (`invalid signature`, `timestamp out of range`) mean the
clocks disagree. Enable NTP on both hosts. `AGENT_SECRET` must match exactly —
no trailing whitespace, no shell-mangled characters.

---

## A server will not install

Open the server's console: install output streams there and usually names the
problem outright.

| Message                      | Cause                                                   |
| ---------------------------- | ------------------------------------------------------- |
| `no space left on device`    | The node's disk. `df -h /var/lib/storm`                 |
| `curl: (22) … 404`           | The install script's download URL has moved             |
| `Unable to locate package …` | The install container lacks it — `apt-get update` first |
| `permission denied`          | Writing outside `/mnt/server`                           |
| Nothing at all               | The panel could not reach the node — see above          |

Reinstall from **Server → Settings → Reinstall**. It re-runs the install script
over the existing data directory, so worlds survive — but take a backup first
anyway.

If installs hang at "queued", the workers are not running:

```bash
docker compose logs api | grep -i worker
docker compose exec redis redis-cli LLEN bull:storm-installs:wait
```

**Stuck at "Installing" with nothing happening.** The panel retries a failed
install once and only reports it after the second attempt, so a server that
says "installing" for a few minutes after an error is normal — it is having
another go. A server still saying it four hours later is one whose worker went
away mid-run: the housekeeping job — which runs at 17 minutes past every
hour — marks it `INSTALL_FAILED` and notifies the owner, and the Reinstall
button works again from then on.

**"This server is being reinstalled" when pressing Start.** Expected: power
actions and backups are refused while an install, a reinstall or a move has
the data directory. Wait for it to finish, or reinstall if it failed.

---

## A server will not start

**Check the console first.** Games say why they will not start, and the answer
is usually in the first twenty lines.

| Symptom                                          | Cause                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Starts, exits at once                            | The startup command references a file the install did not produce                                |
| `Address already in use`                         | The game is binding its default port, not its allocation. Add a `configFiles` mapping            |
| `Could not reserve enough space for object heap` | Memory limit lower than the JVM's `-Xmx`                                                         |
| Killed after a few seconds                       | OOM. Raise the memory limit or lower the game's                                                  |
| `EULA` complaints                                | The install script did not write `eula.txt`                                                      |
| Stuck at `STARTING` forever                      | `startupDetection` never matches — see [GAME-TEMPLATES.md](GAME-TEMPLATES.md#detection-patterns) |

On the node:

```bash
docker ps -a --filter name=storm-<server-uuid>
docker logs --tail 100 storm-<server-uuid>
docker inspect storm-<server-uuid> --format '{{.State.OOMKilled}} {{.State.ExitCode}}'
```

`OOMKilled=true` is unambiguous: it ran out of memory.

---

## A server is online but unreachable

1. **Is the port allocated and primary?** Server → Network.
2. **Is the game bound to it?** `docker port storm-<uuid>` on the node.
3. **Is the firewall open?** `ufw allow 25565/tcp` — and UDP too, for games
   that need it. Ark, Valheim and Rust all use UDP.
4. **Is the game bound to 127.0.0.1?** Some games default to loopback. Pass
   `{{SERVER_IP}}` — which the panel sets to `0.0.0.0` — in the startup command.
5. **NAT?** The node's public address must be what the allocation says.

```bash
nc -zv node.example.com 25565            # TCP
nc -zuv node.example.com 27015           # UDP
```

---

## The console is blank or disconnected

**"Disconnected" straight away.** The websocket is not getting through. In the
browser's network tab, look for the `ws` request:

| Status                         | Cause                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------- |
| 400/426                        | The proxy is not upgrading the connection. Add the `Upgrade`/`Connection` headers |
| 401                            | Session expired — reload                                                          |
| 403                            | No `servers.console` permission                                                   |
| Connects then drops after ~60s | `proxy_read_timeout` too low. Set 3600s                                           |

**Connected but empty.** The server is stopped, or its output buffer is empty
because it only writes to a log file. Add `logConfig` to the template so the
agent tails the file.

**Commands do nothing.** The server is not running, the account lacks
`servers.console.send`, or the game does not read stdin (some do not — use RCON
instead). A command answered with `FORBIDDEN` on a console that was working a
minute ago means the permission was taken away since it opened, or the server
was suspended — permissions are resolved on every command, not once when the
tab was opened. A console that closes itself with `4403` means the access went
entirely: the share was removed, the account was suspended, or its session was
signed out somewhere else.

**"Lost the connection to the node. Reconnecting…"** is the panel's own socket
to the agent, not the browser's socket to the panel — the console reconnects
behind the scenes with backoff. If it gives up and asks for a reload, the node
has been unreachable for several minutes: check `systemctl status storm-agent`
on it.

---

## File manager problems

| Symptom                                | Cause                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| "Path is outside the server directory" | A `..` or a symlink escape. Working as intended                               |
| "Permission denied"                    | Files owned by the wrong uid. Reinstall re-chowns to 1000                     |
| Uploads fail near the end              | `client_max_body_size` in your proxy. Set it to 2G                            |
| Large file will not open in the editor | Editing is capped. Download it instead                                        |
| Listing is slow                        | Thousands of entries in one directory — that is the filesystem, not the panel |

Large uploads are better done over SFTP.

---

## SFTP problems

Username is `<username>.<serverShortId>` — the plain username alone will not
authenticate. The password is the SFTP password from **Server → Settings →
SFTP**, not the panel password.

| Symptom             | Cause                                                  |
| ------------------- | ------------------------------------------------------ |
| "Permission denied" | Wrong username format, or no access to that server     |
| Connection refused  | The agent's SFTP is not running, or 2022 is firewalled |
| Host key changed    | The node was rebuilt. Verify, then remove the old key  |
| Connects, no files  | Server not installed yet, or genuinely empty           |

```bash
sftp -P 2022 alice.a1b2c3d4@node.example.com
journalctl -u storm-agent | grep -i sftp
```

---

## Backup problems

Covered in [BACKUPS.md](BACKUPS.md#troubleshooting). The short version:
`PENDING` forever means the workers are not running; "access denied" means the
S3 key or endpoint is wrong — use **Test connection**; "no space" means the
node's disk.

---

## Database problems

**Provisioning fails.** The panel's account on the database host needs
`CREATE DATABASE` and `CREATE USER`. **Admin → Database hosts → Test
connection** proves it.

**Customers cannot connect.** The database host must allow connections from the
node's address, not just from the panel: MySQL's user host pattern,
PostgreSQL's `pg_hba.conf`.

**"Too many connections."** Raise `max_connections` on the host, or lower the
per-server database limit.

---

## Schedules do not run

1. Is the schedule enabled? Server → Schedules.
2. Is the cron expression what you think? The UI shows the next few runs in
   plain English — read them.
3. Is the timezone right? Schedules store one; the panel displays local time.
4. Are the workers running? `docker compose logs api | grep -i schedule`.
5. Is it marked **Running**? A schedule runs one at a time, so a run still in
   flight holds the next one. A run that ends any way at all gives that back,
   and a claim left behind by a restart is released on a later tick — after as
   long as the schedule's own task offsets could take, plus ten minutes.

Individual schedules are not Redis repeatables: one repeatable job ticks every
minute and dispatches whatever is due from the database. Flushing Redis loses
that tick until the API restarts, but no schedule is lost with it.

A schedule marked **Only when online** does nothing on a run where the server
is stopped — that is what it is for. It counts as a run: the panel books the
next one and waits for it.

---

## "Server is running out of memory"

The panel sends this while the server is still up, so there is time to act. It
means every reading over the last five minutes had the container using 90% or
more of its memory limit. A server that stays there is killed by the kernel,
and the crash notification that follows says exactly that.

```bash
# What it is actually using, from the node
docker stats --no-stream <container>
```

Either the server needs more memory, or it is being asked to hold more than it
was sold: view distance, a modpack, too many chunks loaded, a plugin leaking.
For Java, remember the heap is not the whole container — the JVM's own
overhead sits on top, so a 2 GiB limit does not mean `-Xmx2G`.

The disk version of the same warning fires on the high-water mark rather than
an average, because disk does not fall on its own and the write that fails is
the one at the peak. Backups and world saves are the first things to break.

Each warning is sent at most once per server per resource every six hours, so
one arriving does not mean it has just started.

---

## Slow panel

```bash
docker stats --no-stream
docker compose exec postgres psql -U storm -c \
  "SELECT count(*) FROM pg_stat_activity WHERE state = 'active';"
docker compose exec redis redis-cli INFO stats | grep instantaneous
```

| Cause                               | Fix                                                           |
| ----------------------------------- | ------------------------------------------------------------- |
| Too many open consoles              | Each is a websocket. Scale the API out                        |
| Database connection pool exhausted  | Raise `connection_limit`, or add PgBouncer                    |
| Backup jobs competing with requests | Split workers onto their own instance                         |
| A node not answering                | The panel waits on it. Take it out of rotation                |
| Audit log grown large               | It is indexed, but a huge table still costs. Archive old rows |

A single slow node makes the whole admin dashboard feel slow, because it
aggregates across nodes. The node health page will show which one.

---

## Emails never arrive

Without SMTP configured, the panel writes verification and reset links to the
API log instead — which is a working development setup, not a broken one:

```bash
docker compose logs api | grep -i 'verification\|reset'
```

With SMTP configured:

| Symptom                    | Cause                                             |
| -------------------------- | ------------------------------------------------- |
| `EAUTH`                    | Wrong credentials. Gmail needs an app password    |
| `ESOCKET` / timeout        | Port blocked, or `SMTP_SECURE` wrong for the port |
| Accepted but not delivered | SPF, DKIM and DMARC on your sending domain        |

`SMTP_SECURE=true` means implicit TLS on port 465. For 587, leave it false —
STARTTLS is negotiated.

---

## Collecting diagnostics

Before asking for help, gather:

```bash
curl -s http://localhost/api/health
docker compose ps
docker compose logs --tail=200 api > api.log
docker compose exec api node apps/api/dist/cli/index.js doctor

# On the affected node
journalctl -u storm-agent -n 200 --no-pager > agent.log
docker ps -a --filter name=storm-
```

Include the `x-request-id` from the failing request, what you expected, and
what happened. **Redact `.env` before sharing it** — it contains
`ENCRYPTION_KEY`, and that one is worth more than the rest of the file
together.
