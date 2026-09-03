# API reference

Storm Panel's API is REST over JSON, with websockets for anything realtime.
Every endpoint lives under `/api/v1`.

An interactive browser is served at `/api/docs` when `ENABLE_SWAGGER=true` —
generated from the same schemas the API validates against, so it cannot drift
from the implementation. This document is the narrative version.

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Errors](#errors)
- [Pagination](#pagination)
- [Rate limits](#rate-limits)
- [Endpoints](#endpoints)
- [Websockets](#websockets)
- [Webhooks](#webhooks)
- [Email](#email)
- [Panel updates](#panel-updates)
- [Recipes](#recipes)

---

## Conventions

Base URL: `https://panel.example.com/api/v1`

Requests and responses are JSON, UTF-8. Send `Content-Type: application/json`
on anything with a body. Timestamps are ISO 8601 in UTC. Ids are opaque
strings — do not parse them.

Success:

```json
{ "success": true, "data": { "…": "…" } }
```

Failure:

```json
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "Server not found", "details": null }
}
```

Every response carries `x-request-id`. Quote it when reporting a problem; it
ties to the server logs.

---

## Authentication

Two mechanisms.

**Session cookies** are what the panel itself uses. `POST /auth/login` sets an
`httpOnly` access cookie and a refresh cookie. The browser sends them
automatically; JavaScript cannot read them.

**API keys** are what you should use for automation. Create one at **Account →
Security → API keys**; it is displayed once.

```bash
curl -H "Authorization: Bearer storm_ak_…" \
     https://panel.example.com/api/v1/servers
```

A key can never do more than the account that made it: its permissions are
intersected with that account's on every request, so demoting someone narrows
their keys with them. It cannot change that user's password, cannot manage
their 2FA, and cannot create other keys.

It can do **less**, and for anything running unattended it should. The create
dialog offers either everything the account can do, or a list you pick from,
plus an expiry:

```json
POST /account/api-keys
{ "name": "Deploy script", "permissions": ["servers.view", "servers.command"], "expiresInDays": 90 }
```

An empty (or absent) `permissions` is the full-access key — the panel labels
those in the listing, because a key with nothing ticked is the most powerful
one there is. `GET /account/permissions` returns the catalogue this account may
choose from, which is its own effective permissions and no more. A permission
that does not exist is a `400`: dropping it silently would leave a key narrower
than whoever made it believes.

An expired key stops authenticating on its own — no revocation needed.

### Sign in

```http
POST /auth/login
```

```json
{ "identifier": "you@example.com", "password": "…", "rememberMe": true }
```

`identifier` is an email address or a username. If the account has 2FA, the
response is `422` with code `TOTP_REQUIRED`; repeat the request with a `totp`
field holding a six-digit code or a backup code.

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "…",
      "email": "…",
      "username": "…",
      "role": "CUSTOMER",
      "permissions": ["servers.view", "…"]
    },
    "accessToken": "eyJ…",
    "expiresIn": 900
  }
}
```

### Refresh

```http
POST /auth/refresh
```

Rotates the refresh token and issues a new access token. **Presenting a token
that has already been rotated revokes the entire session family** — that is
reuse detection, not a bug. Store only the newest token.

### Everything else

|                                  |                                        |
| -------------------------------- | -------------------------------------- |
| `POST /auth/register`            | Create a customer account              |
| `POST /auth/logout`              | Revoke the current session             |
| `GET /auth/me`                   | The current user and their permissions |
| `POST /auth/forgot-password`     | Send a reset link                      |
| `POST /auth/reset-password`      | Consume a reset token                  |
| `POST /auth/verify-email`        | Consume a verification token           |
| `POST /auth/resend-verification` | Send another verification email        |

---

## Errors

| Status | Code                  | Meaning                                       |
| ------ | --------------------- | --------------------------------------------- |
| 400    | `BAD_REQUEST`         | Malformed request                             |
| 401    | `UNAUTHENTICATED`     | Missing, expired or invalid credentials       |
| 403    | `FORBIDDEN`           | Authenticated, but not permitted              |
| 404    | `NOT_FOUND`           | No such resource — **or one you may not see** |
| 409    | `CONFLICT`            | Already exists, or the state forbids it       |
| 422    | `VALIDATION_ERROR`    | Failed schema validation; see `details`       |
| 429    | `RATE_LIMITED`        | Too many requests; see `Retry-After`          |
| 500    | `INTERNAL_ERROR`      | Our fault; the id is in the logs              |
| 502    | `AGENT_UNREACHABLE`   | The node did not answer                       |
| 503    | `SERVICE_UNAVAILABLE` | Dependency down                               |
| 503    | `MAINTENANCE_MODE`    | The panel is in maintenance; see below        |

Validation failures name every bad field at once:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The submitted data is invalid",
    "details": {
      "email": ["Invalid email"],
      "password": ["Password must be at least 10 characters"]
    }
  }
}
```

A 404 for a server that exists but is not yours is deliberate — ids should not
be enumerable by watching status codes.

---

## Pagination

```http
GET /servers?page=2&perPage=25&search=survival&sort=createdAt&order=desc
```

`perPage` is capped at 100.

```json
{
  "success": true,
  "data": [ … ],
  "meta": { "page": 2, "perPage": 25, "total": 137, "totalPages": 6 }
}
```

---

## Rate limits

| Endpoint                     | Limit                                                         |
| ---------------------------- | ------------------------------------------------------------- |
| `POST /auth/login`           | 15 per 5 minutes                                              |
| `POST /auth/register`        | 5 per 10 minutes                                              |
| `POST /auth/forgot-password` | 5 per 15 minutes                                              |
| `POST /auth/reset-password`  | 10 per 15 minutes                                             |
| `POST /account/2fa/*`        | 3–10 per 15 minutes                                           |
| Everything else              | `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW` (300/min by default) |

Buckets key on the account when authenticated and on the IP otherwise. Every
response carries `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset`.

---

## Endpoints

### Dashboard

|                                  |                                                            |
| -------------------------------- | ---------------------------------------------------------- |
| `GET /overview`                  | Counts, resource totals and recent activity for the caller |
| `GET /nodes`                     | Nodes visible to the caller, for server creation           |
| `GET /nodes/:id/stats`           | Live stats for one node                                    |
| `GET /templates`                 | Game templates available to the caller                     |
| `GET /templates/:id`             | One template with its variables                            |
| `GET /templates/meta/categories` | Category list for filtering                                |

`POST /servers/:id/clone` makes another server from an existing one: the same
template, image, startup command, variables and limits, with a new name and
optionally a different node. It is a new server in every way that matters — its
own identifier, port, SFTP account and install run — and it goes through
everything `POST /servers` enforces, so a quota is still a quota and a node
still has to be one the caller may use. A suspended server cannot be copied,
and only somebody who may create servers for another account can make the copy
land on one.

`GET /nodes` shows an account without `nodes.manage` only the nodes that are
public, online and not in maintenance — and `POST /servers` accepts exactly
those. Hiding a node from a dropdown is not a boundary; the pair is. Someone
holding `nodes.manage` sees every node and may place a server on any of them,
which is what a private node is for. Maintenance is the one setting that stops
everybody, since it means "no new servers here" rather than "not for you".

### Servers

|                                  | Permission                               |
| -------------------------------- | ---------------------------------------- |
| `GET /servers`                   | `servers.view`                           |
| `POST /servers`                  | `servers.create`                         |
| `POST /servers/:id/clone`        | `servers.create`, and read on the source |
| `GET /servers/:id`               | `servers.view`                           |
| `PATCH /servers/:id`             | `servers.update`, or the server's owner  |
| `DELETE /servers/:id`            | `servers.delete`                         |
| `POST /servers/:id/power`        | `servers.power`                          |
| `POST /servers/:id/command`      | `servers.console.send`                   |
| `POST /servers/:id/reinstall`    | `servers.update`                         |
| `GET /servers/:id/stats`         | `servers.view`                           |
| `GET /servers/:id/stats/history` | `servers.view`                           |
| `PATCH /servers/:id/startup`     | `servers.startup`                        |
| `PUT /servers/:id/variables`     | `servers.startup`                        |
| `GET /servers/:id/activity`      | `servers.view`                           |

Creating a server takes its resource ceilings under `limits`, in MiB and
percent — `cpuLimit` is percent of one core, so `200` means two cores:

```json
{
  "name": "Survival",
  "nodeId": "…",
  "templateId": "…",
  "limits": { "cpuLimit": 200, "memoryLimit": 4096, "diskLimit": 10240 },
  "environment": { "SERVER_JARFILE": "server.jar" }
}
```

`dockerImage` and `startupCommand` are optional overrides, and both are checked
against the template — an image the template does not offer is rejected, so a
customer cannot name an arbitrary one.

`PATCH /servers/:id` takes the same `limits`, partially — send only what
changes. Raising memory is the fix for a server the host keeps killing, and it
does not touch the server's files. Two rules apply:

- **Only administrators.** A server's own owner may rename it and change
  everything else on that endpoint, but never its limits — the point of a limit
  is that whoever it constrains cannot move it. `servers.update` is not enough
  either; it takes the panel owner or `admin.servers`.
- **The node has to have the room.** The check excludes the server's own current
  allocation, so raising a limit is not blocked by the space that server already
  holds; asking for more than the node has left comes back 409
  `INSUFFICIENT_NODE_CAPACITY`, naming the node.

New limits are pushed to the node immediately but land in the container on its
next start, so restart the server to apply them.

**The disk limit is enforced by the panel, not by the container.** Docker's own
quota needs an xfs or btrfs filesystem with project quotas enabled, which most
hosts are not running, so the node agent cannot set one unconditionally. The
panel therefore refuses the operations it controls once a server is at or over
its limit — writing a file, uploading, copying, compressing, extracting, a
restore that does not truncate, and starting the server — with 409
`RESOURCE_LIMIT_REACHED` naming both numbers.

What stays open is deliberate: stopping, deleting files, and a truncating
restore are how a customer gets back under, and an administrator can always
raise the limit. Usage comes from the last stats sample rather than a fresh
measurement, so this stops sustained overuse rather than the instant of
crossing. A server writing from inside its own container is not covered — that
needs a filesystem quota on the host, which DEPLOYMENT.md covers.

Power actions:

```http
POST /servers/:id/power
{ "action": "start" }        // start · stop · restart · kill
```

`start` on a server that is already running is a no-op, not an error — safe to
retry.

### Allocations

|                                                       |                                        |
| ----------------------------------------------------- | -------------------------------------- |
| `GET /servers/:id/allocations`                        | The server's ports                     |
| `POST /servers/:id/allocations`                       | Attach a free allocation from its node |
| `POST /servers/:id/allocations/:allocationId/primary` | Make it primary                        |
| `DELETE /servers/:id/allocations/:allocationId`       | Detach (not the primary)               |

Customers may only attach allocations that are free on their server's node.
Ports are never named directly.

### Files

All paths are relative to the server's own directory. `..`, absolute paths,
symlink escapes and null bytes are rejected.

|                                            |                             |
| ------------------------------------------ | --------------------------- |
| `GET /servers/:id/files/list?path=/`       | Directory listing           |
| `GET /servers/:id/files/contents?path=…`   | Read a file                 |
| `GET /servers/:id/files/download?path=…`   | Download (streamed)         |
| `GET /servers/:id/files/search?query=…`    | Search names and contents   |
| `POST /servers/:id/files/write`            | Create or overwrite         |
| `POST /servers/:id/files/upload`           | Multipart upload            |
| `POST /servers/:id/files/rename`           | Rename or move              |
| `POST /servers/:id/files/copy`             | Copy                        |
| `POST /servers/:id/files/delete`           | Delete files or directories |
| `POST /servers/:id/files/create-directory` | mkdir -p                    |
| `POST /servers/:id/files/compress`         | Create an archive           |
| `POST /servers/:id/files/decompress`       | Extract one                 |
| `POST /servers/:id/files/chmod`            | Change mode                 |

### Backups

|                                               |                                           |
| --------------------------------------------- | ----------------------------------------- |
| `GET /servers/:id/backups`                    | List                                      |
| `POST /servers/:id/backups`                   | Create (queued; poll or watch the socket) |
| `GET /servers/:id/backups/:backupId`          | One backup and its state                  |
| `PATCH /servers/:id/backups/:backupId`        | Rename, or lock against pruning           |
| `GET /servers/:id/backups/:backupId/download` | A short-lived download URL                |
| `POST /servers/:id/backups/:backupId/restore` | Restore (stops the server)                |
| `DELETE /servers/:id/backups/:backupId`       | Delete                                    |

See [BACKUPS.md](BACKUPS.md).

### Schedules

|                                               |                 |
| --------------------------------------------- | --------------- |
| `GET /servers/:id/schedules`                  | List            |
| `POST /servers/:id/schedules`                 | Create          |
| `PATCH /servers/:id/schedules/:scheduleId`    | Update or pause |
| `POST /servers/:id/schedules/:scheduleId/run` | Run now         |
| `DELETE /servers/:id/schedules/:scheduleId`   | Delete          |

`Run now` answers `400` for a paused schedule and `409` for one already
running — a schedule runs one at a time. The listing carries `isRunning` so the
panel can say which that is.

```json
{
  "name": "Nightly restart",
  "cron": "0 5 * * *",
  "timezone": "Europe/Berlin",
  "tasks": [
    { "action": "command", "payload": "say Restarting in 60s" },
    { "action": "power", "payload": "restart", "offsetSeconds": 60 }
  ]
}
```

### Databases

|                                                      |                        |
| ---------------------------------------------------- | ---------------------- |
| `GET /servers/:id/databases`                         | List (no passwords)    |
| `POST /servers/:id/databases`                        | Provision              |
| `GET /servers/:id/databases/:databaseId/credentials` | Reveal credentials     |
| `POST /servers/:id/databases/:databaseId/rotate`     | New password           |
| `DELETE /servers/:id/databases/:databaseId`          | Drop database and user |

### SFTP and sub-users

|                                           |                                           |
| ----------------------------------------- | ----------------------------------------- |
| `GET /servers/:id/sftp`                   | Host, port and username                   |
| `POST /servers/:id/sftp/reset`            | New password, shown once                  |
| `GET /servers/:id/subusers`               | Who else has access                       |
| `POST /servers/:id/subusers`              | Invite, with a subset of your permissions |
| `DELETE /servers/:id/subusers/:subuserId` | Revoke                                    |

### Account

|                                                             |                          |
| ----------------------------------------------------------- | ------------------------ |
| `GET /account` · `PATCH /account`                           | Profile                  |
| `GET /account/sessions`                                     | Devices                  |
| `DELETE /account/sessions/:id` · `DELETE /account/sessions` | Revoke                   |
| `POST /account/2fa/setup` · `/enable` · `/disable`          | Two-factor               |
| `POST /account/2fa/backup-codes`                            | Regenerate backup codes  |
| `GET /account/permissions`                                  | What this account may do |
| `GET /account/api-keys` · `POST` · `DELETE /:id`            | API keys                 |
| `GET /account/notifications` · `POST /notifications/read`   | Notifications            |
| `GET /account/activity`                                     | Your own audit trail     |

### Administration

Everything below needs a staff role.

|                                                                      | Permission           |
| -------------------------------------------------------------------- | -------------------- |
| `GET/POST /admin/users`, `GET/PATCH/DELETE /admin/users/:id`         | `users.*`            |
| `POST /admin/users/:id/suspend` · `/unsuspend`                       | `users.suspend`      |
| `POST /admin/users/:id/reset-password` · `/disable-2fa`              | `users.update`       |
| `GET /admin/users/meta/roles` · `/meta/permissions`                  | `users.view`         |
| `GET/POST /admin/nodes`, `GET/PATCH/DELETE /admin/nodes/:id`         | `nodes.*`            |
| `GET/POST /admin/nodes/:id/tokens`, `DELETE …/:tokenId`              | `nodes.manage`       |
| `GET /admin/nodes/:id/configuration`                                 | `nodes.manage`       |
| `POST /admin/nodes/:id/bootstrap`                                    | `nodes.manage`       |
| `GET /admin/nodes/:id/health`                                        | `nodes.view`         |
| `GET/POST /admin/nodes/:id/allocations`, `DELETE …/:allocationId`    | `nodes.manage`       |
| `POST /admin/nodes/:id/allocations/prune`                            | `nodes.manage`       |
| `GET /admin/servers`                                                 | `servers.view.all`   |
| `POST /admin/servers/:id/transfer` · `/sync`                         | `servers.update.all` |
| `GET/POST /admin/templates`, `GET/PATCH/DELETE /admin/templates/:id` | `templates.*`        |
| `POST /admin/templates/:id/clone`, `GET …/export`, `POST /import`    | `templates.manage`   |

`POST /admin/templates/import` takes either this panel's own export or a
Pterodactyl egg, works out which, and answers with the template it created
plus a `warnings` list naming anything an egg could not carry across. See
[GAME-TEMPLATES.md](GAME-TEMPLATES.md).
| `GET /admin/overview` | `admin.dashboard` |
| `GET /admin/audit` | `audit.view` |
| `GET/PATCH /admin/settings` | `settings.manage` |
| `GET/POST /admin/backup-storages`, `PATCH/DELETE /admin/backup-storages/:id` | `settings.manage` |
| `GET/POST /admin/database-hosts`, `PATCH/DELETE /admin/database-hosts/:id` | `settings.manage` |
| `POST /admin/database-hosts/:id/test` | `settings.manage` |
| `POST /admin/settings/mail/test` | `settings.manage` |
| `GET/POST /admin/webhooks`, `PATCH/DELETE /admin/webhooks/:id` | `webhooks.manage` |
| `GET /admin/webhooks/events` · `/admin/webhooks/:id/deliveries` | `webhooks.manage` |
| `POST /admin/webhooks/:id/test` | `webhooks.manage` |
| `GET /admin/updates` · `POST /admin/updates/apply` | `panel.update` |

### Node installation

|                                   |                                                                |
| --------------------------------- | -------------------------------------------------------------- |
| `POST /admin/nodes/:id/bootstrap` | Mints a claim and returns the one-line install command         |
| `POST /install/claim`             | Unauthenticated. Exchanges a claim for that node's `agent.env` |

`POST /admin/nodes/:id/bootstrap` answers with a command to run on the node:

```json
{
  "command": "curl -fsSL https://panel.example.com/install/node.sh | sudo bash -s -- --panel-url https://panel.example.com --claim …",
  "expiresInSeconds": 900
}
```

The claim it carries is worth **one node's configuration, once, for fifteen
minutes**. The installer posts it to `/install/claim` — in the body, not the
path, so it is not written to the access log of every proxy in between — and
gets back the same file `GET /admin/nodes/:id/configuration` produces. Redeeming
mints the node's token; a replay is refused with 404, so a claim left in a
scrollback is not a way in. Only the digest is stored, in Redis, with the
expiry as its TTL.

`/install/claim` is unauthenticated because a bare node has no credentials yet.
What guards it is the claim itself, and a rate limit of ten attempts per ten
minutes.

---

### Panel settings

|                 |                                                        |
| --------------- | ------------------------------------------------------ |
| `GET /settings` | Branding and sign-in policy — no authentication needed |

The sign-in page has to know the panel's name and colour, whether registration
is open, and whether maintenance is on, all before anyone has a session. Only
those keys are returned:

```json
{
  "panelName": "Storm Panel",
  "panelUrl": "https://panel.example.com",
  "brandColor": "#2563eb",
  "announcement": "",
  "announcementLevel": "info",
  "registrationEnabled": true,
  "requireEmailVerification": false,
  "maintenanceMode": false,
  "maintenanceMessage": "…",
  "supportEmail": "support@example.com"
}
```

How the panel is _run_ — the default limits, backup retention — stays behind
`GET /admin/settings` and `settings.manage`.

The default limits apply to every new **customer** account, whichever way it
was made: signed up, created through `POST /admin/users`, or created with
`storm admin create`. A request that names limits of its own wins field by
field. Accounts in the other roles start with no ceiling anywhere, because
staff run the panel rather than buy from it, and none of this touches an
account that already exists — editing somebody does not re-provision them.

`brandColor` must be a six-digit hex. It becomes a CSS custom property in every
visitor's browser, so anything looser would let whoever holds `settings.manage`
inject declarations into pages other people are looking at. `announcement` is
capped at 500 characters and `announcementLevel` is one of `info`, `warning`,
`critical`.

Settings are read through a five-second cache, so a second API replica picks up
a change within that. Writing them through `PATCH /admin/settings` drops the
cache on the instance that served the write, which is why a rebrand shows up on
the very next request rather than five seconds later.

---

### Health

Unauthenticated, for load balancers and monitoring.

|                   |                                         |
| ----------------- | --------------------------------------- |
| `GET /health`     | Liveness — the process is up            |
| `GET /ready`      | Readiness — database and Redis answered |
| `GET /api/health` | Version, uptime and dependency states   |

---

## Optional panels per template

A `GameTemplate` carries `features`: the optional panels its servers get.
`PATCH /admin/templates/:id` accepts it, and **Admin → Game templates → ⋯ →
Optional panels** is where an operator sets it. It is not a sidebar entry —
it belongs to the template, and is adjusted about once per template.

Only names the panel actually implements are accepted; anything else is
refused rather than stored. A value nothing reads would be a switch an
operator could set and then wonder about, and a typo would look exactly like a
real setting.

| Feature   | What it adds                                          |
| --------- | ----------------------------------------------------- |
| `plugins` | The plugin browser below. Bukkit-family servers only. |
| `players` | Operators, whitelist and bans. Minecraft: Java only.  |

Turning one on takes effect immediately — the endpoints read the template row
on each request, and the server payload carries `template.features`, which is
what draws the tab.

---

## Minecraft plugins

|                                              |                                    |
| -------------------------------------------- | ---------------------------------- |
| `GET /servers/:id/plugins`                   | Jars in the server's `plugins` dir |
| `GET /servers/:id/plugins/search?q=`         | Search the registry                |
| `GET /servers/:id/plugins/:project/versions` | Downloadable builds                |
| `POST /servers/:id/plugins`                  | Install `{ "versionId": "…" }`     |
| `DELETE /servers/:id/plugins/:filename`      | Remove a jar                       |

Reading needs `servers.files`, installing and removing `servers.files.write`.

**Only where the template says so.** A `GameTemplate` carries a `features`
list, and these endpoints exist for a server whose template includes
`plugins` — everything else gets 404, including a caller who goes straight to
the URL. That is a column rather than a match on the slug, so an operator's
own Minecraft template keeps the browser and a renamed one does not lose it.

**A caller never supplies a URL.** The request body is one opaque version id.
The panel asks the registry what that resolves to, and checks the answer twice
before any node is told to fetch it: against `MODRINTH_DOWNLOAD_HOSTS`, and
against the addresses no outbound request should reach. Without that, "install
this plugin" would be a way to make a node request an arbitrary address — its
own metadata service, something on the operator's private network — and write
the reply into a directory the customer reads through the file manager.

The node verifies the sha512 the registry published, caps the transfer, and
writes to a temporary name first, so a truncated or substituted download fails
there instead of at the server's next start. Installing counts against the
server's disk limit like any other file.

Only builds for the Bukkit family — bukkit, spigot, paper, purpur, folia — are
offered, and installing one for another loader is refused rather than merely
hidden. A Fabric mod in `plugins/` is silently ignored by the server, which
looks exactly like a plugin that does not work.

**A node has to be new enough.** Installing calls an endpoint the agent gained
with this feature, so a node still running an older agent answers 404 and the
panel says so by name: update the agent on that node.

`MODRINTH_API_URL` points the browser elsewhere — a mirror, or nothing at all
on a panel without outbound internet, in which case searching answers 502 and
the rest of the panel is unaffected.

---

## Minecraft players

|                                               |                               |
| --------------------------------------------- | ----------------------------- |
| `GET /servers/:id/players`                    | Operators, whitelist and bans |
| `POST/DELETE /servers/:id/players/operators`  | Op and deop                   |
| `POST/DELETE /servers/:id/players/whitelist`  | Add and remove                |
| `POST /servers/:id/players/whitelist/enabled` | Enforce the whitelist or not  |
| `POST/DELETE /servers/:id/players/bans`       | Ban and pardon                |
| `POST/DELETE /servers/:id/players/ip-bans`    | Ban and pardon an address     |
| `POST /servers/:id/players/kick`              | Kick someone who is on now    |

Needs `servers.players`, and the template's `features` must include `players`.
The permission exists apart from `servers.command` so a sub-user can be trusted
with opping and banning without being handed the console.

**Reading comes from the files; changing goes through the console.** Minecraft
holds these lists in memory while it runs and rewrites `ops.json`,
`whitelist.json` and the ban files itself — so a panel that edited them
underneath would show a change the game never had, and lose it at shutdown.
Every change is therefore the command the game already understands, which means
**the server has to be running**; a change attempted while it is off comes back
409 saying so. Reading works either way, and the response carries `live` so the
panel can say whether it is showing live state or the last thing written.

`whitelistEnabled` comes from `white-list` in server.properties, not from the
list: the two are separate in Minecraft, and a whitelist that is never
consulted looks exactly like one that is.

Player names are validated as Mojang defines them — three to sixteen letters,
digits or underscores — and ban reasons may not contain a line break. That is
not tidiness: the agent submits a console command by writing it followed by a
newline, so a name containing one would run whatever came after it, and
`servers.players` would quietly become full console access.

---

## Moving a server to another node

```http
POST /admin/servers/:id/move
{ "nodeId": "…", "allocationId": "…", "keepBackup": false }
```

Requires `admin.servers`. The move runs on a queue and takes as long as the
files do, so this returns 200 once it is accepted, not once it is done. Watch
the server's status: `TRANSFERRING` while it runs, `OFFLINE` on the new node
when it lands.

**The archive is the route between the two hosts.** The source node uploads it
to backup storage and the destination downloads it, so a shared storage — S3 or
compatible — must exist. A `LOCAL` storage lives on one node's own disk, which
the other cannot read, and the endpoint refuses the move up front rather than
letting the worker discover it an hour in. That check sits with the others,
all of them made before anything is touched:

| Refused when                                     | Status                           |
| ------------------------------------------------ | -------------------------------- |
| The destination is the node it already runs on   | 400                              |
| The destination is offline or in maintenance     | 409                              |
| The destination lacks memory or disk             | 409 `INSUFFICIENT_NODE_CAPACITY` |
| The destination has no free port                 | 409 `NO_ALLOCATION_AVAILABLE`    |
| No shared backup storage exists                  | 409                              |
| The server is installing, reinstalling or moving | 409                              |

The order of the move is chosen so the point of no return comes last:

1. Stop the server and wait for the container to actually be down — an archive
   taken mid-write is a world saved half way through a tick.
2. Archive it from the source node into storage.
3. Claim a port on the destination.
4. Build the container there and unpack the archive into it. The specification
   is built from the destination's port, not the server's row: mid-move it holds
   ports on both nodes, and the old address would otherwise be written into
   `SERVER_IP`, the startup command and every config file the template renders.
5. Only now flip the row and release the old ports.
6. Delete the container and files from the old node.

Anything failing before step 5 leaves the source untouched and complete: the
destination's port is handed back, its half-built container removed, and the
server is still where it was. Step 6 failing costs disk on the old node and
nothing else, so it does not fail the move.

The archive is deleted afterwards unless `keepBackup` is set — it exists to
survive the move, not to spend the customer's backup allowance forever.

The server's address changes. Anything that connects to it needs the new one.

---

## Maintenance mode

`PATCH /admin/settings` with `maintenanceMode: true` closes the panel to
customers. Every request they make comes back **503 `MAINTENANCE_MODE`**, with
`maintenanceMessage` as the message so they read what the administrator wrote
rather than a generic failure.

Containers are untouched — game servers keep running throughout. This closes the
panel, not the platform.

Four things keep answering, each for a reason:

- **`/health`, `/ready`, `/api/health`** — otherwise an orchestrator drains the
  API in the middle of the maintenance window.
- **The whole `/auth` surface, refresh included** — locking sign-in would lock
  the administrator out of the switch they came to flip, and letting access
  tokens expire would sign everyone out instead of showing them the notice.
  Signing _up_ is the exception: `POST /auth/register` returns 503, because an
  account created now could not use the panel anyway.
- **`/internal/*`** — nodes keep reporting. Their servers are still running, and
  if that state stopped arriving the panel would come back with a wrong picture
  of the world.
- **`GET /settings`** — how a browser learns that maintenance is _why_ it is
  being turned away, and how it notices the panel coming back.

Anyone holding `admin.dashboard` works through maintenance normally — that is
the permission that reaches the admin area, so it is the one that can turn it
back off.

---

## Restarting after a crash

`PATCH /servers/:id` takes `autoRestart`. With it on, a crash brings the server
back on its own — but not indefinitely:

- A crash **less than a minute** after starting counts against a budget of three.
  Spend it and the server is left stopped, with one notification saying so.
  Repeating that message on every later crash would be noise, so it is sent once.
- A run that lasts **a minute or more** clears the budget. A server that runs for
  a week and then falls over gets its restart, however often it failed before.
- **Running out of memory is never retried.** It will happen again the moment it
  starts, and the fix is a limit only the owner can raise — restarting is just a
  louder failure.
- Starting or restarting it yourself clears the budget: that is the owner saying
  to try again. Automatic restarts do not go through that path, so they cannot
  clear their own.

`crashedAt`, `lastStartAt` and the attempt counter are what this is computed
from, so no timer runs and nothing is lost if the panel restarts.

## Websockets

Two sockets, both authenticated with the session cookie or `?token=`.

### Server console

```
wss://panel.example.com/api/v1/servers/:id/ws
```

The panel never hands a browser credentials for a node. It opens its own
authenticated socket to the agent and relays, filtered by what the user may
actually see.

Server → client:

| `type`            | Payload                                       |
| ----------------- | --------------------------------------------- |
| `ready`           | `serverId`, `status` — the connection is live |
| `console`         | `line`, `timestamp`                           |
| `console:history` | `lines[]` — the recent buffer, on connect     |
| `status`          | `status` — a state change                     |
| `stats`           | `stats` — CPU, memory, disk, network, uptime  |
| `install`         | `line` — installation output                  |
| `error`           | `code`, `message`                             |
| `pong`            | Reply to `ping`                               |

Client → server:

| `type`    | Payload   | Requires                   |
| --------- | --------- | -------------------------- |
| `command` | `command` | `servers.console.send`     |
| `power`   | `action`  | `servers.power`            |
| `logs`    | —         | Re-send the history buffer |
| `ping`    | —         | Keepalive                  |

```js
const socket = new WebSocket(`wss://panel.example.com/api/v1/servers/${id}/ws`);
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'console') console.log(message.line);
};
socket.send(JSON.stringify({ type: 'command', command: 'say hello' }));
```

Close codes: `4401` not authenticated, `4403` not permitted, `4404` no such
server.

### Account socket

```
wss://panel.example.com/api/v1/ws
```

Pushes server status changes, notifications and dashboard totals for the
current user. This is what makes the dashboard update without polling.

---

## Webhooks

Configure at **Admin → Webhooks**. Each delivery is a POST with:

```
x-storm-event: server.status.changed
x-storm-delivery: 018f…
x-storm-signature: sha256=…
```

The signature is HMAC-SHA256 of the raw body with the webhook's secret. Verify
it in constant time before trusting anything:

```js
const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(
  Buffer.from(`sha256=${expected}`),
  Buffer.from(request.headers['x-storm-signature']),
);
```

Events are `server.created`, `server.installed`, `server.started`,
`server.stopped`, `server.crashed`, `server.resource_warning`,
`server.deleted`, `server.suspended`, `server.unsuspended`, `backup.created`,
`backup.completed`, `backup.failed`, `backup.restored`, `node.online`,
`node.offline`, `user.created` and `user.deleted`. `GET
/admin/webhooks/events` returns the current list, which is the one the panel
actually dispatches.

`server.resource_warning` fires while a server is still running, not after it
has died: its payload carries `resource` (`memory` or `disk`), the bytes in
use and the limit in MiB. It is sent at most once per server per resource
every six hours, so it is a signal rather than a stream.

Non-2xx responses are retried with exponential backoff. Deliveries and their
outcomes are visible at `GET /admin/webhooks/:id/deliveries`.

### Testing an endpoint

`POST /admin/webhooks/:id/test` sends one real, signed delivery with the event
`panel.test`, and answers with what came back:

```json
{
  "ok": false,
  "status": 403,
  "error": "The endpoint responded with 403",
  "responseBody": "Forbidden",
  "tookMs": 214
}
```

The request goes out through the same SSRF guard as a scheduled delivery — the
URL is re-resolved at send time, so an endpoint that has since started pointing
at a private address is refused rather than called. Test deliveries are recorded
in the delivery list and audited as `admin.webhook_tested`, so a receiver that
logs by delivery id can find the one you sent.

---

## Email

`POST /admin/settings/mail/test` proves the SMTP configuration end to end: it
opens the connection, authenticates, and sends one message.

```json
{ "sentTo": "you@example.com", "tookMs": 1180 }
```

It always sends to **the calling administrator's own address** — there is no
recipient field, because one would turn an admin session into an open relay for
whatever the panel renders. A failure returns the SMTP server's own words
(`535 authentication failed`, `Connection timed out`), since that is the part
that says what to change. Rate limited to 5 per 10 minutes.

---

## Panel updates

`GET /admin/updates` compares the commit the running image was built from
against the branch head on GitHub:

```json
{
  "current": {
    "version": "1.0.0",
    "commit": "a1b2c3d…",
    "shortCommit": "a1b2c3d",
    "builtAt": "2026-08-12T09:31:00Z"
  },
  "available": {
    "checked": true,
    "upToDate": false,
    "commit": "f9e8d7c…",
    "shortCommit": "f9e8d7c",
    "behindBy": 14,
    "commits": [{ "sha": "f9e8d7c…", "message": "Fix …", "author": "…", "date": "…" }]
  },
  "canApply": true,
  "reason": null,
  "repository": "StormX1337/Storm-Game",
  "branch": "main",
  "lastCheckedAt": "2026-08-31T10:02:11Z",
  "job": null
}
```

The result is cached for 15 minutes, so polling it is cheap. `job` carries the
state of an update already in flight (`requested`, `running`, `succeeded`, `failed`).

`POST /admin/updates/apply` takes `{ "commit": "…" }` and accepts **only** the
commit `GET /admin/updates` just offered — an older or arbitrary commit is
rejected, so the endpoint cannot be used to run any revision the repository has
ever held. Rate limited to 5 per 10 minutes and gated on `panel.update`, which
`OWNER` and `ADMIN` hold and `STAFF` does not.

The API container has no Docker socket and cannot restart itself, by design.
Applying an update writes a request file into the update control directory; the
host-side watcher installed by `scripts/storm-updater.sh --install` picks it up,
runs `scripts/update.sh`, and reports back. Poll `GET /admin/updates` for the
job state. On a deployment without the watcher, `canApply` is `false` and
`reason` explains what to run by hand.

---

## Recipes

**Create a server and wait for it**

```bash
SERVER=$(curl -s -X POST https://panel.example.com/api/v1/servers \
  -H "Authorization: Bearer $STORM_KEY" -H 'content-type: application/json' \
  -d '{"name":"Survival","templateId":"…","nodeId":"…",
       "limits":{"cpuLimit":200,"memoryLimit":4096,"diskLimit":10240},
       "environment":{"SERVER_JARFILE":"server.jar"}}' | jq -r .data.id)

until [ "$(curl -s -H "Authorization: Bearer $STORM_KEY" \
  https://panel.example.com/api/v1/servers/$SERVER | jq -r .data.status)" != "INSTALLING" ]; do
  sleep 5
done
```

**Back up every server you own**

```bash
curl -s -H "Authorization: Bearer $STORM_KEY" \
  https://panel.example.com/api/v1/servers | jq -r '.data[].id' |
while read -r id; do
  curl -s -X POST -H "Authorization: Bearer $STORM_KEY" \
    -H 'content-type: application/json' \
    -d "{\"name\":\"nightly-$(date +%F)\"}" \
    "https://panel.example.com/api/v1/servers/$id/backups" > /dev/null
done
```

**Tail a console from a script**

```bash
npx wscat -c "wss://panel.example.com/api/v1/servers/$SERVER/ws?token=$STORM_KEY"
```
