# Security

What Storm Panel defends against, how, and what it deliberately does not try to
do. A game panel hands strangers a shell-adjacent surface on your hardware —
the interesting question is never "is the login page safe", it is "what happens
when a customer is hostile".

- [Threat model](#threat-model)
- [Authentication](#authentication)
- [Sessions and tokens](#sessions-and-tokens)
- [Authorisation](#authorisation)
- [Container isolation](#container-isolation)
- [Filesystem access](#filesystem-access)
- [Panel ↔ agent](#panel--agent)
- [Databases](#databases)
- [Network allocations](#network-allocations)
- [Secrets](#secrets)
- [Input validation](#input-validation)
- [Rate limiting](#rate-limiting)
- [Outbound requests](#outbound-requests)
- [Audit](#audit)
- [What is out of scope](#what-is-out-of-scope)
- [Hardening checklist](#hardening-checklist)
- [Reporting a vulnerability](#reporting-a-vulnerability)

---

## Threat model

Four adversaries, in descending order of likelihood:

1. **A hostile customer.** Has a legitimate account and a server. Wants other
   customers' servers, the host, or the panel's database. This is the one the
   design is built around.
2. **An unauthenticated attacker.** Wants an account, or a way through the
   login.
3. **A hostile game plugin.** Runs as the customer's server process — assume the
   customer and their server code are the same adversary.
4. **A compromised node.** Serious, and the blast radius is bounded rather than
   eliminated: see [What is out of scope](#what-is-out-of-scope).

Trust boundaries, from least to most trusted: game container → node agent →
panel API → database.

---

## Authentication

**Passwords** are hashed with **Argon2id** at OWASP-recommended parameters
(19 MiB, 2 iterations, 1 lane). Verification is constant-time. When the
parameters change, a successful login transparently rehashes.

Minimum ten characters, maximum 256, no composition rules. Length beats
character classes, and a maximum stops long-string DoS against the hasher.

**Two-factor** is TOTP (RFC 6238, SHA-1, 6 digits, 30-second step) with a
±1-step window. Enrolment shows a QR code rendered in the browser from the
`otpauth://` URI the panel issued — the secret is already on that page, so
drawing it there sends it nowhere new — with the Base32 key beside it for
anyone who would rather type it. Enabling requires the account password _and_
a working code, so an unattended session cannot add a second factor, and
nobody locks themselves out by mis-scanning. Ten single-use backup codes are issued, stored as Argon2
hashes, and burned atomically on use. Seeds are encrypted at rest with
AES-256-GCM; the panel never displays a seed after setup.

A code is spent when it is accepted (RFC 6238 §5.2). The ±1-step window makes
each six digits valid for ninety seconds, and being read off the screen — over
a shoulder, on a shared call, through a phishing page — is most of what a
second factor defends against, so the same digits are not accepted twice.
Every use counts: signing in, turning two-factor off, and the code that
switched it on. Spent codes are held as digests for as long as they could
still have worked and no longer, keyed per account so one person signing in
never locks out the next. "Already used" is answered separately from "not
valid", because to the person holding the phone those mean different things.

**Enumeration** is avoided by giving one answer to every failed login — "Those
credentials do not match our records" — whether the account exists, the
password is wrong, or the account is suspended. Password reset always reports
success. Registration is the exception: it must say an email is taken, so it is
rate limited harder.

**Brute force** is handled in two places: a per-account failure counter that
locks the account temporarily after repeated failures, and a per-IP bucket on
the auth routes. Both are Redis-backed, so they hold across API replicas.

---

## Sessions and tokens

An access token is a short-lived HS256 JWT. A refresh token is 256 bits of
randomness, stored only as a SHA-256 digest.

Both live in `httpOnly`, `sameSite=lax` cookies, `secure` when
`COOKIE_SECURE=true`. The browser never reads them, so an XSS bug cannot
exfiltrate a session. The panel and API share one origin, which is what makes
this possible without CORS credentials or a second cookie domain.

**Algorithm confusion** is prevented by pinning `HS256` when signing _and_ when
verifying. An `alg: none` or `alg: RS256` token is rejected before its
signature is examined.

**Refresh rotation with reuse detection.** Every refresh issues a new token and
records the digest of the one it replaced. Presenting a superseded token means
it leaked, so the entire session family is revoked and every device for that
account must sign in again. That converts a stolen refresh token from
indefinite access into one use, followed by a loud failure the real user
notices.

Sessions are listed in the account area with device, IP and last-seen time, and
can be revoked individually or all at once. Changing a password revokes every
other session.

**API keys** are for automation: shown once, stored as a digest, revocable, and
never accepted for privileged account operations such as changing a password or
disabling 2FA. A key is intersected with its owner's live permissions on every
request, so it narrows when they do and can never be a promotion — and it can
be narrowed further when it is made, to a list picked from what that account
holds, with an expiry after which it simply stops authenticating. Prefer both
for anything running unattended: a full-access key on a deployment box is the
password you did not want to put there.

---

## Authorisation

Five roles — `OWNER`, `ADMIN`, `STAFF`, `SUPPORT`, `CUSTOMER` — over 41
permissions. A user's effective set is their role's permissions plus explicit
grants minus explicit denials, resolved on every request, cached only for the
life of that request. Change someone's role and the next request reflects it.

Every check is server-side. The UI hides what you cannot do because showing it
would be rude, not because that is the control. Removing `hidden` from a
sidebar entry gets you a 403.

Server access resolves through one function, used by every server route:

- the owner of the server, or
- a sub-user with an explicit grant on that server, or
- a staff account holding `servers.view.all`.

A server you cannot see returns **404, not 403**, so ids are not enumerable.
Sub-user grants are a subset of the granter's own permissions — you cannot
delegate what you do not hold.

---

## Container isolation

Each game server is one container, created by the agent with:

| Setting                 | Value                    | Why                                              |
| ----------------------- | ------------------------ | ------------------------------------------------ |
| `User`                  | `1000:1000`              | Never root inside the container                  |
| `no-new-privileges`     | on                       | setuid binaries cannot escalate                  |
| `CapDrop`               | `ALL`                    | Then only what a game server needs is added back |
| Network                 | isolated bridge, ICC off | Containers cannot reach each other               |
| `Memory` / `MemorySwap` | equal                    | No swap escape from the memory limit             |
| `CpuQuota`              | per server               | Cannot starve neighbours                         |
| `PidsLimit`             | bounded                  | Fork bombs hit a wall                            |
| `BlkioWeight`           | bounded                  | Disk I/O cannot be monopolised                   |
| Log driver              | `json-file`, rotated     | Logs cannot fill the disk                        |
| `ReadonlyRootfs`        | where the game allows    | Only the data volume is writable                 |

The Docker socket is never mounted into a game container. The agent is the only
process holding it, and it never passes user input to the Docker CLI — it uses
the Engine API with structured parameters, so there is no argument to inject
into.

Container names and volume paths derive from the server's UUID, generated by
the panel, never from anything a user types.

---

## Filesystem access

Each server owns exactly one directory. Every path a user supplies is resolved
against it, and the result must still be inside it — checked after
normalisation, not before, so `..%2f`, `....//`, absolute paths and null bytes
all fail the same way.

Symlinks are checked separately: after resolution, every component is
`lstat`ed, and a link pointing outside the root is refused. Otherwise a
customer could create `link -> /` inside their own directory and read the host
through their own file manager.

Archive extraction ("zip slip") re-validates every entry path before writing,
and refuses entries that are symlinks or absolute.

Uploads stream to disk with a size cap and a per-server disk quota. Downloads
stream too — the panel never buffers a file in memory.

The file manager runs entirely on the agent. The panel has no filesystem access
to server data at all, which means a bug in the panel's path handling cannot
reach a file: there is nothing there to reach.

---

## Panel ↔ agent

**Panel → agent** carries a token id in the header and an HMAC-SHA256 signature
over the method, the path, a timestamp and the body. The shared secret never
crosses the wire. A captured request cannot be replayed against a different
node or a different route, and timestamps outside a tight window are rejected.
Signatures are compared in constant time.

**Agent → panel** (heartbeats, state, SFTP credential checks) uses a bearer
token whose digest the panel stores.

Agent credentials are per node. Compromising one node yields nothing about any
other. Rotating them from the panel invalidates the old pair immediately.

The agent binds its API to the port you configure and expects to be firewalled
to the panel. It is not a public service.

---

## Databases

A customer database gets its own database _and_ its own user on the host,
granted rights to that one database only. Credentials are generated with a CSPRNG
and stored encrypted with `ENCRYPTION_KEY`.

Names are derived from the server's id and a counter, never from user input, so
there is no identifier to inject into the `CREATE DATABASE` statement.

Deleting a server drops its databases and users. Rotating a password does not
disturb the grants.

Nothing in the panel exposes another customer's database: the credential
endpoint resolves the database through the same server-access function every
other server route uses.

---

## Network allocations

An allocation is one `ip:port` on one node, and it is unique — a database
constraint, not a check-then-write in application code. Assigning it to a
server is a transaction that fails if it was taken in the meantime, so two
concurrent creations cannot collide on the same port.

Customers pick from allocations already attached to their server. They cannot
name a port, cannot ask for one belonging to another server, and cannot create
allocations at all: only staff with `nodes.manage` can, and only within ranges
the operator has defined.

Deleting a server frees its allocations. A primary allocation cannot be removed
while the server exists.

---

## Node placement

A node can be marked not public — capacity an operator keeps for themselves —
put into maintenance, or be offline because its agent stopped answering. An
account without `nodes.manage` is shown none of the three in the deployment
list, and creating a server refuses all three by the same rule: the list and
the boundary read the same predicate, so hiding a node and refusing it cannot
drift apart. A private node answers "not found" rather than "forbidden",
because which nodes exist is what it is keeping to itself.

Someone holding `nodes.manage` sees and may use every node. Maintenance is the
exception that stops them too: it means "no new servers here", not "not for
you".

---

## Secrets

`JWT_SECRET`, `ENCRYPTION_KEY` and `COOKIE_SECRET` are required, must each be
at least 32 characters, and the API refuses to start without them. There are no
defaults — a panel with a default signing key is a panel anyone can sign
tokens for.

At rest, AES-256-GCM protects node secrets, database host passwords, SFTP
passwords, 2FA seeds and backup storage credentials. Authenticated encryption
means tampering is detected, not just decryption failure.

Tokens are stored as digests: refresh tokens, API keys, node tokens, password
reset tokens, email verification tokens. A database dump cannot be replayed as
a session.

Nothing secret reaches the browser. The web app has no `NEXT_PUBLIC_*` secret,
because it has no secrets — it talks to the API with a cookie it cannot read.
Log output is redacted for passwords, tokens, authorization headers and cookies.

---

## Input validation

Every request body, query string and path parameter is parsed by a zod schema
before a handler runs. Unknown keys are stripped, so a client cannot smuggle a
field the handler forgot to ignore — mass assignment is structurally
impossible rather than merely avoided.

Failures return 422 with per-field messages, which is a usability win, not an
information leak: the schema is public in the OpenAPI document anyway.

Database access is exclusively through Prisma with parameterised queries. The
only raw SQL is in database provisioning, where identifiers are generated by
the panel and never taken from a user.

---

## Rate limiting

Buckets are keyed by account when authenticated and by IP otherwise, which
matters for customers behind carrier NAT: one abusive account should not lock
out a whole region.

Authentication routes get a much tighter bucket than the rest of the API.
nginx applies a coarse limit in front, which absorbs volumetric floods before
they reach Node.

Limits are Redis-backed, so they hold across API replicas. Exceeding one
returns 429 with `Retry-After`.

---

## Outbound requests

Webhooks and remote template imports let users supply URLs, which is an SSRF
primitive if left alone. Every outbound URL is checked: scheme must be HTTP or
HTTPS, the resolved address must not be private, loopback, link-local or
multicast, and the check is repeated at connection time so a DNS record cannot
change between validation and use. Redirects are re-validated per hop, and
capped.

Webhook payloads are signed with HMAC-SHA256 so receivers can verify origin.

---

## Audit

Every privileged action is recorded with the actor, the target, the IP, the
user agent and a timestamp: sign-ins, permission changes, power actions,
file writes and deletes, backup restores, node and template changes, database
provisioning, credential rotations.

The log is append-only through the API — there is no endpoint that edits or
deletes an entry, at any role. Entries survive the deletion of the user who
caused them.

---

## What is out of scope

Stated plainly, because a security document that claims everything is covered
is not useful.

- **A compromised node agent** is trusted for the servers on that node. It can
  read those servers' files and see their console. It cannot read another
  node's data, cannot authenticate as a user, and cannot read the panel's
  database. Nodes run untrusted game code — treat them as semi-trusted and
  segment your network accordingly.
- **A malicious operator** — `OWNER` and `ADMIN` are trusted by design. The
  audit log records what they do; it does not stop them.
- **Kernel escapes** from a container are the kernel's problem. Keep hosts
  patched; consider gVisor or Kata for hostile multi-tenancy.
- **Game-server vulnerabilities.** A vulnerable plugin runs with the
  customer's own privileges inside their own container — which is why that
  container is unprivileged and isolated.
- **Denial of service** beyond resource limits and rate limiting. Volumetric
  attacks need upstream filtering.

---

## Hardening checklist

Before you take real customers:

- [ ] TLS in front of the panel, `COOKIE_SECURE=true`
- [ ] `JWT_SECRET`, `ENCRYPTION_KEY`, `COOKIE_SECRET` freshly generated, 48+ bytes
- [ ] `ADMIN_PASSWORD` removed from `.env` after the owner account exists
- [ ] Node port 8081 firewalled to the panel only
- [ ] SFTP (2022) open to customers, node SSH (22) restricted to you
- [ ] `AGENT_ALLOW_SELF_SIGNED=false` with real certificates on agents
- [ ] 2FA enabled on every staff account
- [ ] Database and Redis not published to the host network
- [ ] Automated backups configured and a restore actually tested
- [ ] Hosts on unattended security upgrades
- [ ] Alerting on nodes that stop sending heartbeats

---

## Reporting a vulnerability

Please report privately, not as a public issue. Include what you did, what you
expected, and what happened, with enough detail to reproduce. We will confirm
receipt, keep you informed while we fix it, and credit you in the release
notes unless you would rather we did not.
