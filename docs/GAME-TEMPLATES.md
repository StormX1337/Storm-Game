# Game templates

A template is everything the panel needs to run one kind of game server: which
image, how to install it, how to start it, how to know it started, and which
settings a customer may change. Twelve ship with the panel. Adding a thirteenth
takes no code.

- [Anatomy](#anatomy)
- [Variables](#variables)
- [Install scripts](#install-scripts)
- [Startup and stop](#startup-and-stop)
- [Detection patterns](#detection-patterns)
- [Config files](#config-files)
- [Building one](#building-one)
- [Versioning](#versioning)
- [Import and export](#import-and-export)
- [Included templates](#included-templates)
- [Troubleshooting](#troubleshooting)

---

## Anatomy

| Field               | What it is                                                       |
| ------------------- | ---------------------------------------------------------------- |
| `name`              | Shown to customers — "Minecraft: Java Edition"                   |
| `slug`              | Stable identifier — `minecraft-java`                             |
| `game`              | The game, for grouping                                           |
| `category`          | Minecraft, Survival, Sandbox, Shooter, Simulation, Other         |
| `description`       | One or two sentences in the creation wizard                      |
| `author`            | Who maintains it                                                 |
| `dockerImages`      | Display name → image reference. Customers pick one               |
| `defaultImage`      | Which of those is preselected                                    |
| `installContainer`  | Image the install script runs in                                 |
| `installEntrypoint` | Usually `bash`                                                   |
| `installScript`     | The script itself                                                |
| `startupCommand`    | The command the container runs, with `{{VARIABLE}}` placeholders |
| `stopCommand`       | What to write to stdin to stop it gracefully                     |
| `startupDetection`  | Regex that means "online"                                        |
| `crashDetection`    | Regex that means "this crashed"                                  |
| `configFiles`       | Files the panel keeps in step with allocations                   |
| `logConfig`         | Where the game writes logs, if not stdout                        |
| `defaultPorts`      | Ports a new server should get                                    |
| `supportedVersions` | Version strings offered in the wizard                            |
| `variables`         | The settings a customer may set                                  |

Install and runtime images are separate on purpose: installation often needs
`curl`, `tar` and a compiler, and none of that belongs in the image the game
runs in.

---

## Variables

Each variable becomes an environment variable in both the install container and
the game container, and can be interpolated into `startupCommand` as
`{{NAME}}`.

| Field          | Meaning                                     |
| -------------- | ------------------------------------------- |
| `name`         | Label in the UI — "Server jar file"         |
| `description`  | Help text under it                          |
| `envVariable`  | The environment variable — `SERVER_JARFILE` |
| `defaultValue` | Used when the customer does not set one     |
| `userViewable` | Whether the customer sees it at all         |
| `userEditable` | Whether they may change it                  |
| `rules`        | Validation, as a pipe-separated list        |
| `sortOrder`    | Display order                               |

| Rule              | Checks                                                       |
| ----------------- | ------------------------------------------------------------ |
| `required`        | Not empty. Without it, an empty value skips every other rule |
| `string`          | Documentation only — everything arrives as a string          |
| `integer`         | A whole number                                               |
| `numeric`         | A number                                                     |
| `boolean`         | `true`, `false`, `0` or `1`                                  |
| `min:n` / `max:n` | Length in characters                                         |
| `between:a,b`     | Numeric range, inclusive                                     |
| `in:a,b,c`        | One of these exact values                                    |
| `alpha_dash`      | Letters, numbers, dashes and underscores only                |
| `url`             | A valid `http` or `https` URL                                |
| `regex:…`         | Matches the pattern                                          |

Combine them with `|`. They are enforced server-side, so a variable marked
`userEditable: false` cannot be changed by a crafted request either.

```json
{
  "name": "Server jar file",
  "description": "Which jar to launch. Change this for Paper or Fabric.",
  "envVariable": "SERVER_JARFILE",
  "defaultValue": "server.jar",
  "userViewable": true,
  "userEditable": true,
  "rules": "required|string|regex:/^[\\w.-]+\\.jar$/",
  "sortOrder": 1
}
```

That regex is doing real work: `SERVER_JARFILE` lands in `startupCommand`, so
without it a customer could inject arguments into the command line.

**Never interpolate an unvalidated variable into `startupCommand`.** Constrain
every one that appears there.

---

## Install scripts

The script runs once, in `installContainer`, as root, with the server's data
directory mounted at `/mnt/server` and every variable in the environment. Its
output streams to the customer's console.

```bash
#!/bin/bash
set -euo pipefail

apt-get update -qq
apt-get install -y --no-install-recommends curl jq ca-certificates

mkdir -p /mnt/server
cd /mnt/server

VERSION="${MINECRAFT_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  VERSION=$(curl -fsSL https://launchermeta.mojang.com/mc/game/version_manifest.json \
            | jq -r '.latest.release')
fi

MANIFEST=$(curl -fsSL https://launchermeta.mojang.com/mc/game/version_manifest.json \
           | jq -r --arg v "$VERSION" '.versions[] | select(.id == $v) | .url')
curl -fsSL "$(curl -fsSL "$MANIFEST" | jq -r '.downloads.server.url')" -o "${SERVER_JARFILE:-server.jar}"

echo "eula=true" > eula.txt
echo "Installed Minecraft $VERSION"
```

Rules that save you grief:

- `set -euo pipefail`, always. A silent failure produces a server that starts
  and immediately dies, and the customer sees no reason why.
- Everything must land in `/mnt/server`. Nothing else survives.
- Be idempotent — reinstall runs the same script over existing data.
- Say what you did. That output is the customer's only view of the install.
- Pin versions where you can. "Latest" changes under you.
- Never `curl | bash` from a URL a variable controls.

### Upstream APIs move

Every script here depends on a service somebody else operates, and those change
on their own schedule. PaperMC retired its v2 API; the built-in Minecraft
template kept calling it and every install began failing with `curl: (22)` and
an exit code — which names neither the URL nor the status, so nobody could tell
what had broken.

Three habits make that survivable:

**Report what failed.** Wrap the fetching so a failure prints the URL and the
HTTP status. A 410 says the endpoint is gone; a 000 says the node has no
outbound network. Those need different fixes and look identical otherwise.

**Read the response loosely.** Pulling a download URL out with a path like
`.downloads."server:default".url` breaks the day upstream renames a field. Ask
for the shape you need instead:

```bash
jq -r '[.. | objects | select(has("url")) | .url]
       | map(select(endswith(".jar"))) | first // empty'
```

**Leave an escape hatch.** Give the template a variable holding a direct
download URL, checked before any API call. When an upstream changes, the
operator installs anyway instead of waiting for a template update. The built-in
Minecraft template calls it `SERVER_DOWNLOAD_URL`.

And check which service actually serves a project: Purpur is not a PaperMC
project and has its own API, which the built-in template got wrong for as long
as PaperMC answered 404 quietly.

The panel `chown`s the result to uid 1000 afterwards, so a root-owned install
still yields a directory the unprivileged game process can write.

---

## Startup and stop

```
java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui
```

`{{SERVER_MEMORY}}`, `{{SERVER_PORT}}`, `{{SERVER_IP}}` and
`{{SERVER_DISK}}` are provided by the panel from the server's real limits and
allocation. Everything else comes from your variables.

`stopCommand` is written to the container's stdin — `stop` for Minecraft,
`quit` for source engines, `^C` to send SIGINT for games without a console
command. The agent waits, then kills. Getting this right is the difference
between a clean save and a corrupted world.

---

## Detection patterns

`startupDetection` is a regex matched against console output. Until it matches,
the server shows as `STARTING`.

| Game      | Pattern                                  |
| --------- | ---------------------------------------- |
| Minecraft | `\)! For help, type`                     |
| CS2       | `Connection to Steam servers successful` |
| Rust      | `Server startup complete`                |
| Valheim   | `Game server connected`                  |
| Factorio  | `Hosting game at IP ADDR`                |

Leave it empty and the server is considered online as soon as the process is
up, which is usually a lie.

`crashDetection` marks output that means the process is dead even if it has not
exited — `java.lang.OutOfMemoryError`, for instance.

---

## Config files

The panel can keep a game's own configuration in step with the allocation it
was given, so a customer who is moved to a different port does not have to edit
anything.

```json
{
  "server.properties": {
    "parser": "properties",
    "find": {
      "server-port": "{{server.allocation.port}}",
      "server-ip": "{{server.allocation.ip}}",
      "query.port": "{{server.allocation.port}}"
    }
  }
}
```

Parsers: `properties`, `ini`, `json`, `yaml`. Substitutions available:
`{{server.allocation.ip}}`, `{{server.allocation.port}}`,
`{{server.build.memory}}`, `{{server.build.disk}}`, `{{server.uuid}}`,
`{{server.name}}` and any `{{env.VARIABLE}}`.

The agent applies these immediately before each start, so a customer moved to a
new port never has to edit anything, and a customer who edits one of these keys
back is corrected on the next boot — which is the point. Keys the mapping does
not name, comments and ordering are left exactly as they were, and a file the
game has not written yet is created.

A mapping that fails — an unparsable file, a path outside the server — is
logged and skipped rather than blocking the start: the game's own defaults are
a better outcome than a server that will not boot.

---

## Building one

**Admin → Game templates → New template**, or clone one that is close and edit.
Working from a clone is usually faster.

1. **Identity** — name, slug, game, category, description.
2. **Images** — the runtime images to offer, and the install image.
3. **Install script** — write it, then test it by hand first:
   ```bash
   docker run --rm -it -v /tmp/test-server:/mnt/server \
     -e MINECRAFT_VERSION=1.21.1 -e SERVER_JARFILE=server.jar \
     debian:bookworm-slim bash
   ```
   Paste the script. Fix it until it works, then paste it into the template.
4. **Startup** — command, stop command, detection patterns.
5. **Variables** — one per setting a customer should control. Validate each.
6. **Ports** — the game's defaults.
7. **Save**, then create a real server from it and watch the console through
   install, start and stop.

The last step is not optional. A template that has never run a server is a
guess.

---

## Versioning

Every template carries a version number, and editing one increments it. That
number is what makes a change visible: the template list shows it, and the
audit log records the version each edit produced, so "which revision was this
server installed from" has an answer.

An edit does **not** reach running servers. A server keeps the image, startup
command and variables it was created with until it is reinstalled — so fixing a
template cannot break servers that are working today, and a fix reaches a
server only when someone deliberately reinstalls it.

To try a change without touching what customers are using, **clone** the
template. The clone records its parent, so the lineage stays visible, and you
can point one test server at it before editing the original.

There is a second reason to work from a clone. Re-running the seed — `storm
seed`, or an upgrade that ships new reference data — resets the twelve built-in
templates to their shipped definitions and discards edits made to them in the
panel. A clone has its own slug and is never touched.

---

## Import and export

```
GET  /api/v1/admin/templates/:id/export
POST /api/v1/admin/templates/import
```

Export produces a JSON document with the template and its variables — no ids,
no server references, so it is portable between panels. The UI offers both as
buttons.

Imports are validated against the same schema the API uses. A template from an
untrusted source is code you are about to run as root during installation:
**read the install script before you import it.**

### Pterodactyl eggs

The same endpoint takes an egg. Nothing to convert first — paste the JSON or
pick the file, and the panel works out which format it is holding.

Most of the crossing is renaming: both formats describe a container, a startup
line, an install script and a set of variables. Four things are not renaming,
and the import reports whatever it could not carry in the same answer rather
than in a log nobody reads.

| Egg                             | Here                         |
| ------------------------------- | ---------------------------- |
| `{{server.build.default.port}}` | `{{server.allocation.port}}` |
| `{{server.build.default.ip}}`   | `{{server.allocation.ip}}`   |
| `{{server.build.env.VAR}}`      | `{{env.VAR}}`                |
| `regex:/^([\w.-]+)\.jar$/`      | `regex:^([\w.-]+)\.jar$`     |

A regex is the one that would have bitten quietly: an egg wraps its pattern in
PHP delimiters, and this panel hands the argument straight to `RegExp`, where a
leading slash is a character to match. Left alone, every value for that
variable would have been refused — an import that looks perfectly fine until
somebody builds on it.

A pattern containing `|` cannot be carried at all, because rules are separated
by `|` and the parser tears it in half. Those are dropped, the variable keeps
its other checks, and the import says which variable lost what.

Parsers this panel cannot write — `xml`, and Pterodactyl's own `file` — mean
that config file is not kept in step with the server. It is reported and left
out rather than stored as something that will silently do nothing.

An egg carries no slug, no game and no category, so those are asked for
alongside it and derived from its name when left blank. A slug already in use
gets a number appended, unless you typed it yourself — your own slug is yours,
and a clash there is a real answer. And an egg's own `features` (`eula`,
`java_version`) are **not** mapped onto this panel's optional panels: matching
them by name would hand a plugin manager to a game with no plugins.

---

## Included templates

| Template                   | Category   | Notes                                     |
| -------------------------- | ---------- | ----------------------------------------- |
| Minecraft: Java Edition    | Minecraft  | Vanilla, Paper, Purpur, Fabric            |
| Minecraft: Bedrock Edition | Minecraft  | Official Mojang server                    |
| Counter-Strike 2           | Shooter    | SteamCMD, needs a GSLT for public listing |
| Rust                       | Survival   | SteamCMD, wipes on major updates          |
| Terraria (TShock)          | Sandbox    | Plugins and permissions                   |
| ARK: Survival Evolved      | Survival   | Large; allow disk and RAM                 |
| Valheim                    | Survival   | BepInEx-compatible                        |
| Palworld                   | Survival   | SteamCMD                                  |
| Garry's Mod                | Sandbox    | Workshop collections                      |
| Team Fortress 2            | Shooter    | SteamCMD                                  |
| Factorio                   | Simulation | Headless, mod folder                      |
| Project Zomboid            | Survival   | SteamCMD                                  |

Each is editable. Change one and it becomes your template — the seed will not
overwrite it.

---

## Troubleshooting

**Install fails immediately.** Read the console output. Usually a missing
package in the install container, or a download URL that has moved.

**Server installs but will not start.** Check `startupCommand` against what the
install actually produced — `SERVER_JARFILE` naming a jar that is not there is
the classic. The file manager will show you.

**Server starts but the panel says `STARTING` forever.** `startupDetection`
does not match. Copy a line from the real console output and build the pattern
from it.

**Server is unreachable although it is online.** The game is binding to its own
default port rather than the allocation. Add a `configFiles` entry, or pass
`{{SERVER_PORT}}` on the command line.

**Stopping corrupts the world.** `stopCommand` is wrong, so the game is being
killed rather than asked to save. Use the game's own console command.
