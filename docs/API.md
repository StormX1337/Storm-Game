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

An API key carries the permissions of the user who created it. It cannot change
that user's password, cannot manage their 2FA, and cannot create other keys.

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

### Servers

|                                  | Permission                              |
| -------------------------------- | --------------------------------------- |
| `GET /servers`                   | `servers.view`                          |
| `POST /servers`                  | `servers.create`                        |
| `GET /servers/:id`               | `servers.view`                          |
| `PATCH /servers/:id`             | `servers.update`, or the server's owner |
| `DELETE /servers/:id`            | `servers.delete`                        |
| `POST /servers/:id/power`        | `servers.power`                         |
| `POST /servers/:id/command`      | `servers.console.send`                  |
| `POST /servers/:id/reinstall`    | `servers.update`                        |
| `GET /servers/:id/stats`         | `servers.view`                          |
| `GET /servers/:id/stats/history` | `servers.view`                          |
| `PATCH /servers/:id/startup`     | `servers.startup`                       |
| `PUT /servers/:id/variables`     | `servers.startup`                       |
| `GET /servers/:id/activity`      | `servers.view`                          |

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

|                                                             |                         |
| ----------------------------------------------------------- | ----------------------- |
| `GET /account` · `PATCH /account`                           | Profile                 |
| `GET /account/sessions`                                     | Devices                 |
| `DELETE /account/sessions/:id` · `DELETE /account/sessions` | Revoke                  |
| `POST /account/2fa/setup` · `/enable` · `/disable`          | Two-factor              |
| `POST /account/2fa/backup-codes`                            | Regenerate backup codes |
| `GET /account/api-keys` · `POST` · `DELETE /:id`            | API keys                |
| `GET /account/notifications` · `POST /notifications/read`   | Notifications           |
| `GET /account/activity`                                     | Your own audit trail    |

### Administration

Everything below needs a staff role.

|                                                                              | Permission           |
| ---------------------------------------------------------------------------- | -------------------- |
| `GET/POST /admin/users`, `GET/PATCH/DELETE /admin/users/:id`                 | `users.*`            |
| `POST /admin/users/:id/suspend` · `/unsuspend`                               | `users.suspend`      |
| `POST /admin/users/:id/reset-password` · `/disable-2fa`                      | `users.update`       |
| `GET /admin/users/meta/roles` · `/meta/permissions`                          | `users.view`         |
| `GET/POST /admin/nodes`, `GET/PATCH/DELETE /admin/nodes/:id`                 | `nodes.*`            |
| `GET/POST /admin/nodes/:id/tokens`, `DELETE …/:tokenId`                      | `nodes.manage`       |
| `GET /admin/nodes/:id/configuration`                                         | `nodes.manage`       |
| `POST /admin/nodes/:id/bootstrap`                                            | `nodes.manage`       |
| `GET /admin/nodes/:id/health`                                                | `nodes.view`         |
| `GET/POST /admin/nodes/:id/allocations`, `DELETE …/:allocationId`            | `nodes.manage`       |
| `POST /admin/nodes/:id/allocations/prune`                                    | `nodes.manage`       |
| `GET /admin/servers`                                                         | `servers.view.all`   |
| `POST /admin/servers/:id/transfer` · `/sync`                                 | `servers.update.all` |
| `GET/POST /admin/templates`, `GET/PATCH/DELETE /admin/templates/:id`         | `templates.*`        |
| `POST /admin/templates/:id/clone`, `GET …/export`, `POST /import`            | `templates.manage`   |
| `GET /admin/overview`                                                        | `admin.dashboard`    |
| `GET /admin/audit`                                                           | `audit.view`         |
| `GET/PATCH /admin/settings`                                                  | `settings.manage`    |
| `GET/POST /admin/backup-storages`, `PATCH/DELETE /admin/backup-storages/:id` | `settings.manage`    |
| `GET/POST /admin/database-hosts`, `PATCH/DELETE /admin/database-hosts/:id`   | `settings.manage`    |
| `POST /admin/database-hosts/:id/test`                                        | `settings.manage`    |
| `POST /admin/settings/mail/test`                                             | `settings.manage`    |
| `GET/POST /admin/webhooks`, `PATCH/DELETE /admin/webhooks/:id`               | `webhooks.manage`    |
| `GET /admin/webhooks/events` · `/admin/webhooks/:id/deliveries`              | `webhooks.manage`    |
| `POST /admin/webhooks/:id/test`                                              | `webhooks.manage`    |
| `GET /admin/updates` · `POST /admin/updates/apply`                           | `panel.update`       |

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

### Health

Unauthenticated, for load balancers and monitoring.

|                   |                                         |
| ----------------- | --------------------------------------- |
| `GET /health`     | Liveness — the process is up            |
| `GET /ready`      | Readiness — database and Redis answered |
| `GET /api/health` | Version, uptime and dependency states   |

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

Events include `server.created`, `server.installed`, `server.status.changed`,
`server.deleted`, `backup.completed`, `backup.failed`, `node.online`,
`node.offline`, `user.registered` and `user.suspended`. `GET
/admin/webhooks/events` returns the current list.

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
