/**
 * Built-in game templates ("eggs").
 *
 * Every template is a complete, runnable definition: an install script that
 * provisions the game files into /mnt/server, a runtime image, a startup
 * command and the variables a customer may edit. Admins can clone any of these
 * from the UI to build their own.
 */

export interface SeedTemplateVariable {
  name: string;
  description: string;
  envVariable: string;
  defaultValue: string;
  userViewable: boolean;
  userEditable: boolean;
  rules: string;
  sortOrder: number;
}

export interface SeedTemplate {
  name: string;
  slug: string;
  game: string;
  category: string;
  description: string;
  dockerImages: Record<string, string>;
  defaultImage: string;
  startupCommand: string;
  stopCommand: string;
  installContainer: string;
  installEntrypoint: string;
  installScript: string;
  startupDetection: string;
  crashDetection: string;
  defaultPorts: number[];
  supportedVersions: string[];
  /** Optional panels this template's servers get. Most games have none. */
  features?: string[];
  configFiles: Record<string, unknown>;
  logConfig: Record<string, unknown>;
  variables: SeedTemplateVariable[];
}

const STEAMCMD_INSTALL = (appId: string, extra = '') => `#!/bin/bash
set -euo pipefail
mkdir -p /mnt/server
STEAM_USER="\${STEAM_USER:-anonymous}"
STEAM_PASS="\${STEAM_PASS:-}"
BETA_ARG=""
if [ -n "\${STEAM_BETA:-}" ]; then BETA_ARG="-beta \${STEAM_BETA}"; fi

echo "[storm] Installing SteamCMD app ${appId} ..."
if [ "\$STEAM_USER" = "anonymous" ]; then
  /home/steam/steamcmd/steamcmd.sh +force_install_dir /mnt/server +login anonymous \\
    +app_update ${appId} \$BETA_ARG validate +quit
else
  /home/steam/steamcmd/steamcmd.sh +force_install_dir /mnt/server +login "\$STEAM_USER" "\$STEAM_PASS" \\
    +app_update ${appId} \$BETA_ARG validate +quit
fi

mkdir -p /mnt/server/.steam/sdk64 /mnt/server/.steam/sdk32
cp -f /home/steam/steamcmd/linux64/steamclient.so /mnt/server/.steam/sdk64/ 2>/dev/null || true
cp -f /home/steam/steamcmd/linux32/steamclient.so /mnt/server/.steam/sdk32/ 2>/dev/null || true
${extra}
echo "[storm] Install complete."
`;

const PORT_VARIABLE = (defaultPort: number, sortOrder = 0): SeedTemplateVariable => ({
  name: 'Server Port',
  description: 'The port the game server binds to. Managed by the panel allocation.',
  envVariable: 'SERVER_PORT',
  defaultValue: String(defaultPort),
  userViewable: true,
  userEditable: false,
  rules: 'required|integer|between:1,65535',
  sortOrder,
});

export const SEED_TEMPLATES: SeedTemplate[] = [
  {
    name: 'Minecraft: Java Edition',
    slug: 'minecraft-java',
    game: 'Minecraft Java',
    // Paper, Spigot and Bukkit share a plugin ecosystem the panel can browse.
    features: ['plugins'],
    category: 'Minecraft',
    description:
      'Vanilla, Paper, Purpur and Fabric compatible Minecraft Java Edition server running on Temurin JRE.',
    // Minecraft raises its minimum Java with the game version, and the server
    // refuses to start on anything older — 26.1 wants 25. Old versions are the
    // mirror image: 1.16 and earlier will not run on a modern JRE. So the whole
    // range stays on offer and the newest is the default, since "latest" is
    // what most people install.
    dockerImages: {
      'Java 25': 'eclipse-temurin:25-jre',
      'Java 21': 'eclipse-temurin:21-jre',
      'Java 17': 'eclipse-temurin:17-jre',
      'Java 11': 'eclipse-temurin:11-jre',
      'Java 8': 'eclipse-temurin:8-jre',
    },
    defaultImage: 'eclipse-temurin:25-jre',
    startupCommand:
      'java -Xms128M -Xmx{{SERVER_MEMORY}}M -Dterminal.jline=false -Dterminal.ansi=true -jar {{SERVER_JARFILE}} nogui',
    stopCommand: 'stop',
    installContainer: 'debian:bookworm-slim',
    installEntrypoint: 'bash',
    installScript: `#!/bin/bash
set -euo pipefail
apt-get update -qq && apt-get install -y -qq curl jq ca-certificates >/dev/null
mkdir -p /mnt/server && cd /mnt/server

PROJECT="\${PROJECT:-paper}"
VERSION="\${MINECRAFT_VERSION:-latest}"
JARFILE="\${SERVER_JARFILE:-server.jar}"

# Every fetch says which URL failed and what came back. The old script let a
# bare "curl: (22)" and an exit code stand for "the upstream API changed",
# which is not something anyone can act on.
fetch() {
  _url="\$1"
  _body=\$(curl -fsSL --retry 3 --retry-delay 2 -w '\n%{http_code}' "\$_url" 2>/dev/null) || {
    # curl already prints 000 when it never connected, and exits non-zero while
    # doing it — so a fallback here appends a second 000 and reports "HTTP
    # 000000", which reads like a bug in the panel rather than an unreachable
    # host.
    _code=\$(curl -s -o /dev/null -w '%{http_code}' "\$_url" 2>/dev/null)
    echo "[storm] Request failed: \$_url" >&2
    echo "[storm] HTTP \$_code — if this is 404 or 410, the upstream API has moved." >&2
    echo "[storm] Work around it by setting SERVER_DOWNLOAD_URL on this server." >&2
    exit 1
  }
  printf '%s' "\$_body" | sed '\$d'
}

# The escape hatch. Upstream APIs change on their own schedule; nobody should be
# stuck waiting for a template update to install a server.
if [ -n "\${SERVER_DOWNLOAD_URL:-}" ]; then
  DOWNLOAD="\$SERVER_DOWNLOAD_URL"
  echo "[storm] Using the download URL set on this server."

elif [ "\$PROJECT" = "vanilla" ]; then
  echo "[storm] Resolving vanilla \$VERSION from Mojang ..."
  MANIFEST=\$(fetch https://launchermeta.mojang.com/mc/game/version_manifest_v2.json)
  if [ "\$VERSION" = "latest" ]; then
    VERSION=\$(echo "\$MANIFEST" | jq -r '.latest.release')
  fi
  URL=\$(echo "\$MANIFEST" | jq -r --arg V "\$VERSION" '.versions[] | select(.id==\$V) | .url')
  [ -n "\$URL" ] && [ "\$URL" != "null" ] || {
    echo "[storm] Mojang lists no version \$VERSION." >&2; exit 1;
  }
  DOWNLOAD=\$(fetch "\$URL" | jq -r '.downloads.server.url')

elif [ "\$PROJECT" = "purpur" ]; then
  # Purpur is its own project with its own API. Asking PaperMC for it never
  # worked, and stopped failing quietly once PaperMC's v2 API was retired.
  echo "[storm] Resolving purpur \$VERSION from the Purpur API ..."
  if [ "\$VERSION" = "latest" ]; then
    VERSION=\$(fetch https://api.purpurmc.org/v2/purpur | jq -r '.versions[-1]')
  fi
  BUILD=\$(fetch "https://api.purpurmc.org/v2/purpur/\$VERSION" | jq -r '.builds.latest')
  [ -n "\$BUILD" ] && [ "\$BUILD" != "null" ] || {
    echo "[storm] Purpur has no build for \$VERSION." >&2; exit 1;
  }
  DOWNLOAD="https://api.purpurmc.org/v2/purpur/\$VERSION/\$BUILD/download"

else
  # PaperMC's v2 API answers 410 Gone; v3 is served from fill.papermc.io.
  echo "[storm] Resolving \$PROJECT \$VERSION from the PaperMC API ..."
  API="https://fill.papermc.io/v3/projects/\$PROJECT"

  if [ "\$VERSION" = "latest" ]; then
    # Versions come back as bare strings in some responses and as objects in
    # others; take whichever this one is rather than assuming.
    VERSION=\$(fetch "\$API" | jq -r '
      [.. | objects | select(has("version")) | .version] as \$objs
      | (if (\$objs | length) > 0 then \$objs
         else [.. | arrays | .[] | select(type=="string")] end)
      | last // empty')
    [ -n "\$VERSION" ] || {
      echo "[storm] Could not read a version list from \$API." >&2; exit 1;
    }
    echo "[storm] Latest is \$VERSION"
  fi

  BUILDS=\$(fetch "\$API/versions/\$VERSION/builds")

  # Deliberately shape-agnostic: take the newest build entry by whatever
  # numeric id it carries, then the first .jar URL anywhere inside it. A field
  # rename upstream should not break installing a server.
  DOWNLOAD=\$(echo "\$BUILDS" | jq -r '
    (if type=="array" then . else (.builds // []) end)
    | map(select(type=="object"))
    | sort_by((.id // .build // 0) | tonumber? // 0)
    | last
    | [.. | objects | select(has("url")) | .url]
    | map(select(endswith(".jar")))
    | first // empty')

  [ -n "\$DOWNLOAD" ] || {
    echo "[storm] No download found for \$PROJECT \$VERSION." >&2
    echo "[storm] The API answered:" >&2
    echo "\$BUILDS" | head -c 400 >&2
    echo >&2
    echo "[storm] Set SERVER_DOWNLOAD_URL on this server to install it anyway." >&2
    exit 1
  }
fi

echo "[storm] Downloading \$DOWNLOAD"
curl -fsSL -o "\$JARFILE" "\$DOWNLOAD"

if [ ! -f eula.txt ]; then echo "eula=\${EULA:-true}" > eula.txt; fi
if [ ! -f server.properties ]; then
  cat > server.properties <<PROPS
server-port=\${SERVER_PORT:-25565}
motd=A Storm Panel Minecraft Server
max-players=\${MAX_PLAYERS:-20}
enable-rcon=false
online-mode=\${ONLINE_MODE:-true}
difficulty=\${DIFFICULTY:-normal}
PROPS
fi
echo "[storm] Install complete."
`,
    startupDetection: '\\)! For help, type',
    crashDetection: 'Exception in server tick loop|Failed to start the minecraft server',
    defaultPorts: [25565],
    supportedVersions: [
      '1.21.4',
      '1.21.1',
      '1.20.6',
      '1.20.4',
      '1.19.4',
      '1.18.2',
      '1.16.5',
      '1.12.2',
    ],
    configFiles: {
      'server.properties': {
        parser: 'properties',
        find: { 'server-port': '{{server.allocation.port}}' },
      },
    },
    logConfig: { custom: false, location: 'logs/latest.log' },
    variables: [
      {
        name: 'Server Jar File',
        description: 'The jar file the server starts from.',
        envVariable: 'SERVER_JARFILE',
        defaultValue: 'server.jar',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:64|regex:^[A-Za-z0-9_.-]+\\.jar$',
        sortOrder: 1,
      },
      {
        name: 'Project',
        description: 'paper, purpur, folia or vanilla.',
        envVariable: 'PROJECT',
        defaultValue: 'paper',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|in:paper,purpur,folia,velocity,vanilla',
        sortOrder: 2,
      },
      {
        name: 'Minecraft Version',
        description: 'Game version to install, or "latest".',
        envVariable: 'MINECRAFT_VERSION',
        defaultValue: 'latest',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:32',
        sortOrder: 3,
      },
      {
        name: 'Download URL',
        description:
          'Optional. A direct link to the server jar, used instead of asking the project API. Upstream APIs change on their own schedule; this is how you install anyway.',
        envVariable: 'SERVER_DOWNLOAD_URL',
        defaultValue: '',
        userViewable: true,
        userEditable: true,
        rules: 'nullable|string|max:512',
        sortOrder: 4,
      },
      {
        name: 'Max Players',
        description: 'Maximum concurrent players.',
        envVariable: 'MAX_PLAYERS',
        defaultValue: '20',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,1000',
        sortOrder: 5,
      },
      {
        name: 'Online Mode',
        description: 'Verify players against Mojang authentication servers.',
        envVariable: 'ONLINE_MODE',
        defaultValue: 'true',
        userViewable: true,
        userEditable: true,
        rules: 'required|boolean',
        sortOrder: 6,
      },
      {
        name: 'Accept EULA',
        description: 'You must accept the Minecraft EULA to run a server.',
        envVariable: 'EULA',
        defaultValue: 'true',
        userViewable: true,
        userEditable: true,
        rules: 'required|boolean',
        sortOrder: 7,
      },
      PORT_VARIABLE(25565, 7),
    ],
  },
  {
    name: 'Minecraft: Bedrock Edition',
    slug: 'minecraft-bedrock',
    game: 'Minecraft Bedrock',
    category: 'Minecraft',
    description:
      'Official Mojang Bedrock dedicated server for console, mobile and Windows 10 players.',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand: 'LD_LIBRARY_PATH=. ./bedrock_server',
    stopCommand: 'stop',
    installContainer: 'debian:bookworm-slim',
    installEntrypoint: 'bash',
    installScript: `#!/bin/bash
set -euo pipefail
apt-get update -qq && apt-get install -y -qq curl unzip jq ca-certificates >/dev/null
mkdir -p /mnt/server && cd /mnt/server

VERSION="\${BEDROCK_VERSION:-latest}"
echo "[storm] Resolving Bedrock server download ..."
if [ "\$VERSION" = "latest" ]; then
  URL=\$(curl -fsSL -A "Mozilla/5.0 (StormPanel)" https://net-secondary.web.minecraft-services.net/api/v1.0/download/links \\
    | jq -r '.result.links[] | select(.downloadType=="serverBedrockLinux") | .downloadUrl')
else
  URL="https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-\${VERSION}.zip"
fi

echo "[storm] Downloading \$URL"
curl -fsSL -A "Mozilla/5.0 (StormPanel)" -o server.zip "\$URL"

# Preserve operator-edited configuration across reinstalls.
for f in server.properties permissions.json allowlist.json whitelist.json; do
  [ -f "\$f" ] && cp "\$f" "\$f.storm-backup"
done

unzip -o -q server.zip && rm -f server.zip
for f in server.properties permissions.json allowlist.json whitelist.json; do
  [ -f "\$f.storm-backup" ] && mv "\$f.storm-backup" "\$f"
done

chmod +x bedrock_server
sed -i "s/^server-port=.*/server-port=\${SERVER_PORT:-19132}/" server.properties || true
sed -i "s/^max-players=.*/max-players=\${MAX_PLAYERS:-10}/" server.properties || true
sed -i "s/^gamemode=.*/gamemode=\${GAMEMODE:-survival}/" server.properties || true
echo "[storm] Install complete."
`,
    startupDetection: 'Server started',
    crashDetection: 'Quit correctly|std::bad_alloc',
    defaultPorts: [19132],
    supportedVersions: ['latest'],
    configFiles: {},
    logConfig: { custom: true, location: 'logs/console.log' },
    variables: [
      {
        name: 'Bedrock Version',
        description: 'Server build to install, or "latest".',
        envVariable: 'BEDROCK_VERSION',
        defaultValue: 'latest',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:32',
        sortOrder: 1,
      },
      {
        name: 'Max Players',
        description: 'Maximum concurrent players.',
        envVariable: 'MAX_PLAYERS',
        defaultValue: '10',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,100',
        sortOrder: 2,
      },
      {
        name: 'Game Mode',
        description: 'survival, creative or adventure.',
        envVariable: 'GAMEMODE',
        defaultValue: 'survival',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|in:survival,creative,adventure',
        sortOrder: 3,
      },
      PORT_VARIABLE(19132, 4),
    ],
  },
  {
    name: 'Counter-Strike 2',
    slug: 'counter-strike-2',
    game: 'Counter-Strike 2',
    category: 'Valve',
    description:
      'Counter-Strike 2 dedicated server (SteamCMD app 730). Requires a Game Server Login Token.',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './game/bin/linuxsteamrt64/cs2 -dedicated -console -usercon -port {{SERVER_PORT}} +map {{MAP}} +game_type {{GAME_TYPE}} +game_mode {{GAME_MODE}} +sv_setsteamaccount {{STEAM_ACC}} -maxplayers_override {{MAX_PLAYERS}}',
    stopCommand: 'quit',
    installContainer: 'cm2network/steamcmd:root',
    installEntrypoint: 'bash',
    installScript: STEAMCMD_INSTALL('730'),
    startupDetection: 'Connection to Steam servers successful|GC Connection established',
    crashDetection: 'Segmentation fault|Fatal error',
    defaultPorts: [27015],
    supportedVersions: ['public'],
    configFiles: {},
    logConfig: { custom: false, location: 'game/csgo/console.log' },
    variables: [
      {
        name: 'Game Server Login Token',
        description: 'Steam GSLT from https://steamcommunity.com/dev/managegameservers',
        envVariable: 'STEAM_ACC',
        defaultValue: '',
        userViewable: true,
        userEditable: true,
        rules: 'string|max:64',
        sortOrder: 1,
      },
      {
        name: 'Starting Map',
        description: 'Map loaded on boot.',
        envVariable: 'MAP',
        defaultValue: 'de_dust2',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:64',
        sortOrder: 2,
      },
      {
        name: 'Game Type',
        description: '0 = classic, 1 = gungame, 2 = custom, 3 = cooperative.',
        envVariable: 'GAME_TYPE',
        defaultValue: '0',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:0,4',
        sortOrder: 3,
      },
      {
        name: 'Game Mode',
        description: '0 = casual, 1 = competitive, 2 = wingman.',
        envVariable: 'GAME_MODE',
        defaultValue: '1',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:0,3',
        sortOrder: 4,
      },
      {
        name: 'Max Players',
        description: 'Player slot count.',
        envVariable: 'MAX_PLAYERS',
        defaultValue: '12',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:2,64',
        sortOrder: 5,
      },
      PORT_VARIABLE(27015, 6),
    ],
  },
  {
    name: 'Rust',
    slug: 'rust',
    game: 'Rust',
    category: 'Survival',
    description: 'Rust dedicated server (SteamCMD app 258550) with Oxide/uMod support.',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './RustDedicated -batchmode +server.port {{SERVER_PORT}} +server.identity storm +rcon.port {{RCON_PORT}} +rcon.password "{{RCON_PASS}}" +rcon.web true +server.hostname "{{HOSTNAME}}" +server.level "{{LEVEL}}" +server.seed {{WORLD_SEED}} +server.worldsize {{WORLD_SIZE}} +server.maxplayers {{MAX_PLAYERS}} +server.description "{{DESCRIPTION}}" +server.saveinterval 300',
    stopCommand: 'quit',
    installContainer: 'cm2network/steamcmd:root',
    installEntrypoint: 'bash',
    installScript: STEAMCMD_INSTALL(
      '258550',
      `
if [ "\${OXIDE:-false}" = "true" ]; then
  echo "[storm] Installing Oxide/uMod ..."
  apt-get update -qq && apt-get install -y -qq curl unzip >/dev/null
  curl -fsSL -o /tmp/oxide.zip https://umod.org/games/rust/download/develop
  unzip -o -q /tmp/oxide.zip -d /mnt/server && rm -f /tmp/oxide.zip
fi`,
    ),
    startupDetection: 'Server startup complete|SteamServer Initialized',
    crashDetection: 'Segmentation fault|Killed',
    defaultPorts: [28015, 28016],
    supportedVersions: ['public'],
    configFiles: {},
    logConfig: { custom: false, location: '' },
    variables: [
      {
        name: 'Server Hostname',
        description: 'Name shown in the Rust server browser.',
        envVariable: 'HOSTNAME',
        defaultValue: 'A Storm Panel Rust Server',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:120',
        sortOrder: 1,
      },
      {
        name: 'Description',
        description: 'Server browser description.',
        envVariable: 'DESCRIPTION',
        defaultValue: 'Powered by Storm Panel',
        userViewable: true,
        userEditable: true,
        rules: 'string|max:255',
        sortOrder: 2,
      },
      {
        name: 'World Seed',
        description: 'Procedural map seed.',
        envVariable: 'WORLD_SEED',
        defaultValue: '12345',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer',
        sortOrder: 3,
      },
      {
        name: 'World Size',
        description: 'Map size in metres (1000-6000).',
        envVariable: 'WORLD_SIZE',
        defaultValue: '3500',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1000,6000',
        sortOrder: 4,
      },
      {
        name: 'Level',
        description: 'World generator.',
        envVariable: 'LEVEL',
        defaultValue: 'Procedural Map',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:64',
        sortOrder: 5,
      },
      {
        name: 'Max Players',
        description: 'Player slot count.',
        envVariable: 'MAX_PLAYERS',
        defaultValue: '50',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,500',
        sortOrder: 6,
      },
      {
        name: 'RCON Port',
        description: 'Remote console port (must be an allocated port).',
        envVariable: 'RCON_PORT',
        defaultValue: '28016',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,65535',
        sortOrder: 7,
      },
      {
        name: 'RCON Password',
        description: 'Remote console password.',
        envVariable: 'RCON_PASS',
        defaultValue: '',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|min:8|max:64',
        sortOrder: 8,
      },
      {
        name: 'Install Oxide',
        description: 'Install the Oxide/uMod modding framework.',
        envVariable: 'OXIDE',
        defaultValue: 'false',
        userViewable: true,
        userEditable: true,
        rules: 'required|boolean',
        sortOrder: 9,
      },
      PORT_VARIABLE(28015, 10),
    ],
  },
  {
    name: 'Terraria (TShock)',
    slug: 'terraria-tshock',
    game: 'Terraria',
    category: 'Sandbox',
    description: 'Terraria dedicated server powered by TShock, with plugin and permission support.',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './TShock.Server -port {{SERVER_PORT}} -maxplayers {{MAX_PLAYERS}} -world "/home/container/world/{{WORLD_NAME}}.wld" -autocreate {{WORLD_SIZE}} -worldname "{{WORLD_NAME}}" -nouseasyncsocket',
    stopCommand: 'exit',
    installContainer: 'debian:bookworm-slim',
    installEntrypoint: 'bash',
    installScript: `#!/bin/bash
set -euo pipefail
apt-get update -qq && apt-get install -y -qq curl unzip jq ca-certificates >/dev/null
mkdir -p /mnt/server/world && cd /mnt/server

VERSION="\${TSHOCK_VERSION:-latest}"
if [ "\$VERSION" = "latest" ]; then
  URL=\$(curl -fsSL https://api.github.com/repos/Pryaxis/TShock/releases/latest \\
    | jq -r '.assets[] | select(.name | test("linux-x64.*\\\\.zip$")) | .browser_download_url' | head -n1)
else
  URL=\$(curl -fsSL "https://api.github.com/repos/Pryaxis/TShock/releases/tags/\$VERSION" \\
    | jq -r '.assets[] | select(.name | test("linux-x64.*\\\\.zip$")) | .browser_download_url' | head -n1)
fi

echo "[storm] Downloading \$URL"
curl -fsSL -o tshock.zip "\$URL"
unzip -o -q tshock.zip && rm -f tshock.zip
chmod +x TShock.Server 2>/dev/null || true
echo "[storm] Install complete."
`,
    startupDetection: 'Server started|Type .help for a list of commands',
    crashDetection: 'Unhandled Exception',
    defaultPorts: [7777],
    supportedVersions: ['latest'],
    configFiles: {},
    logConfig: { custom: false, location: '' },
    variables: [
      {
        name: 'TShock Version',
        description: 'Release tag to install, or "latest".',
        envVariable: 'TSHOCK_VERSION',
        defaultValue: 'latest',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:32',
        sortOrder: 1,
      },
      {
        name: 'World Name',
        description: 'World file name (without extension).',
        envVariable: 'WORLD_NAME',
        defaultValue: 'storm',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:32|regex:^[A-Za-z0-9_-]+$',
        sortOrder: 2,
      },
      {
        name: 'World Size',
        description: '1 = small, 2 = medium, 3 = large.',
        envVariable: 'WORLD_SIZE',
        defaultValue: '2',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,3',
        sortOrder: 3,
      },
      {
        name: 'Max Players',
        description: 'Player slot count.',
        envVariable: 'MAX_PLAYERS',
        defaultValue: '16',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,255',
        sortOrder: 4,
      },
      PORT_VARIABLE(7777, 5),
    ],
  },
  {
    name: 'ARK: Survival Evolved',
    slug: 'ark-survival-evolved',
    game: 'ARK: Survival Evolved',
    category: 'Survival',
    description: 'ARK: Survival Evolved dedicated server (SteamCMD app 376030).',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './ShooterGame/Binaries/Linux/ShooterGameServer {{MAP}}?listen?SessionName="{{SESSION_NAME}}"?ServerPassword={{SERVER_PASSWORD}}?ServerAdminPassword={{ADMIN_PASSWORD}}?Port={{SERVER_PORT}}?QueryPort={{QUERY_PORT}}?MaxPlayers={{MAX_PLAYERS}} -server -log',
    stopCommand: '^C',
    installContainer: 'cm2network/steamcmd:root',
    installEntrypoint: 'bash',
    installScript: STEAMCMD_INSTALL('376030'),
    startupDetection: 'Full Startup:|Setting breakpad minidump',
    crashDetection: 'Fatal error|Segmentation fault',
    defaultPorts: [7777, 27015],
    supportedVersions: ['public'],
    configFiles: {},
    logConfig: { custom: false, location: 'ShooterGame/Saved/Logs/ShooterGame.log' },
    variables: [
      {
        name: 'Map',
        description: 'Map to load (TheIsland, Ragnarok, ...).',
        envVariable: 'MAP',
        defaultValue: 'TheIsland',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:64',
        sortOrder: 1,
      },
      {
        name: 'Session Name',
        description: 'Name shown in the server browser.',
        envVariable: 'SESSION_NAME',
        defaultValue: 'Storm ARK Server',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:120',
        sortOrder: 2,
      },
      {
        name: 'Server Password',
        description: 'Password required to join. Leave empty for a public server.',
        envVariable: 'SERVER_PASSWORD',
        defaultValue: '',
        userViewable: true,
        userEditable: true,
        rules: 'string|max:64',
        sortOrder: 3,
      },
      {
        name: 'Admin Password',
        description: 'Password for in-game admin commands.',
        envVariable: 'ADMIN_PASSWORD',
        defaultValue: '',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|min:8|max:64',
        sortOrder: 4,
      },
      {
        name: 'Query Port',
        description: 'Steam query port (must be an allocated port).',
        envVariable: 'QUERY_PORT',
        defaultValue: '27015',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,65535',
        sortOrder: 5,
      },
      {
        name: 'Max Players',
        description: 'Player slot count.',
        envVariable: 'MAX_PLAYERS',
        defaultValue: '30',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,255',
        sortOrder: 6,
      },
      PORT_VARIABLE(7777, 7),
    ],
  },
  {
    name: 'Valheim',
    slug: 'valheim',
    game: 'Valheim',
    category: 'Survival',
    description: 'Valheim dedicated server (SteamCMD app 896660) with optional BepInEx support.',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './valheim_server.x86_64 -nographics -batchmode -name "{{SERVER_NAME}}" -port {{SERVER_PORT}} -world "{{WORLD_NAME}}" -password "{{SERVER_PASSWORD}}" -public {{PUBLIC}} -savedir /home/container/saves',
    stopCommand: '^C',
    installContainer: 'cm2network/steamcmd:root',
    installEntrypoint: 'bash',
    installScript: STEAMCMD_INSTALL('896660', '\nmkdir -p /mnt/server/saves'),
    startupDetection: 'Game server connected|DungeonDB Start',
    crashDetection: 'Segmentation fault',
    defaultPorts: [2456, 2457],
    supportedVersions: ['public'],
    configFiles: {},
    logConfig: { custom: false, location: '' },
    variables: [
      {
        name: 'Server Name',
        description: 'Name shown in the server browser.',
        envVariable: 'SERVER_NAME',
        defaultValue: 'Storm Valheim Server',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:64',
        sortOrder: 1,
      },
      {
        name: 'World Name',
        description: 'World save name.',
        envVariable: 'WORLD_NAME',
        defaultValue: 'Dedicated',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:32|regex:^[A-Za-z0-9_-]+$',
        sortOrder: 2,
      },
      {
        name: 'Server Password',
        description: 'Join password — Valheim requires at least 5 characters.',
        envVariable: 'SERVER_PASSWORD',
        defaultValue: '',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|min:5|max:64',
        sortOrder: 3,
      },
      {
        name: 'Public',
        description: '1 to list in the community browser, 0 to hide.',
        envVariable: 'PUBLIC',
        defaultValue: '1',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:0,1',
        sortOrder: 4,
      },
      PORT_VARIABLE(2456, 5),
    ],
  },
  {
    name: 'Palworld',
    slug: 'palworld',
    game: 'Palworld',
    category: 'Survival',
    description: 'Palworld dedicated server (SteamCMD app 2394010).',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './PalServer.sh -port={{SERVER_PORT}} -players={{MAX_PLAYERS}} -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS',
    stopCommand: '^C',
    installContainer: 'cm2network/steamcmd:root',
    installEntrypoint: 'bash',
    installScript: STEAMCMD_INSTALL(
      '2394010',
      `
mkdir -p /mnt/server/Pal/Saved/Config/LinuxServer
if [ ! -f /mnt/server/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini ]; then
  cat > /mnt/server/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini <<'INI'
[/Script/Pal.PalGameWorldSettings]
OptionSettings=(ServerName="Storm Palworld Server",ServerDescription="Powered by Storm Panel",ServerPlayerMaxNum=16,bIsPvP=False)
INI
fi`,
    ),
    startupDetection: 'Setting breakpad minidump|Running Palworld dedicated server',
    crashDetection: 'Fatal error|Segmentation fault',
    defaultPorts: [8211],
    supportedVersions: ['public'],
    configFiles: {},
    logConfig: { custom: false, location: '' },
    variables: [
      {
        name: 'Max Players',
        description: 'Player slot count (Palworld recommends 32 or fewer).',
        envVariable: 'MAX_PLAYERS',
        defaultValue: '16',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,32',
        sortOrder: 1,
      },
      PORT_VARIABLE(8211, 2),
    ],
  },
  {
    name: "Garry's Mod",
    slug: 'garrys-mod',
    game: "Garry's Mod",
    category: 'Valve',
    description:
      "Garry's Mod dedicated server (SteamCMD app 4020) with workshop collection support.",
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './srcds_run -game garrysmod -console -port {{SERVER_PORT}} +maxplayers {{MAX_PLAYERS}} +map {{MAP}} +gamemode {{GAMEMODE}} +host_workshop_collection {{WORKSHOP_ID}} -tickrate {{TICKRATE}} +sv_setsteamaccount {{STEAM_ACC}}',
    stopCommand: 'quit',
    installContainer: 'cm2network/steamcmd:root',
    installEntrypoint: 'bash',
    installScript: STEAMCMD_INSTALL('4020'),
    startupDetection: 'Server is hibernating|gameserver Steam ID',
    crashDetection: 'Segmentation fault|Engine Error',
    defaultPorts: [27015],
    supportedVersions: ['public'],
    configFiles: {},
    logConfig: { custom: false, location: '' },
    variables: [
      {
        name: 'Game Mode',
        description: 'Gamemode folder name (sandbox, darkrp, ttt, ...).',
        envVariable: 'GAMEMODE',
        defaultValue: 'sandbox',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:64',
        sortOrder: 1,
      },
      {
        name: 'Starting Map',
        description: 'Map loaded on boot.',
        envVariable: 'MAP',
        defaultValue: 'gm_construct',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:64',
        sortOrder: 2,
      },
      {
        name: 'Workshop Collection ID',
        description: 'Steam workshop collection to load. 0 disables workshop content.',
        envVariable: 'WORKSHOP_ID',
        defaultValue: '0',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer',
        sortOrder: 3,
      },
      {
        name: 'Tickrate',
        description: 'Server tickrate.',
        envVariable: 'TICKRATE',
        defaultValue: '66',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:33,128',
        sortOrder: 4,
      },
      {
        name: 'Game Server Login Token',
        description: 'Steam GSLT (app id 4020).',
        envVariable: 'STEAM_ACC',
        defaultValue: '',
        userViewable: true,
        userEditable: true,
        rules: 'string|max:64',
        sortOrder: 5,
      },
      {
        name: 'Max Players',
        description: 'Player slot count.',
        envVariable: 'MAX_PLAYERS',
        defaultValue: '24',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,128',
        sortOrder: 6,
      },
      PORT_VARIABLE(27015, 7),
    ],
  },
  {
    name: 'Team Fortress 2',
    slug: 'team-fortress-2',
    game: 'Team Fortress 2',
    category: 'Valve',
    description: 'Team Fortress 2 dedicated server (SteamCMD app 232250).',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './srcds_run -game tf -console -port {{SERVER_PORT}} +maxplayers {{MAX_PLAYERS}} +map {{MAP}} +sv_setsteamaccount {{STEAM_ACC}} -tickrate {{TICKRATE}}',
    stopCommand: 'quit',
    installContainer: 'cm2network/steamcmd:root',
    installEntrypoint: 'bash',
    installScript: STEAMCMD_INSTALL('232250'),
    startupDetection: 'gameserver Steam ID|Connection to Steam servers successful',
    crashDetection: 'Segmentation fault|Engine Error',
    defaultPorts: [27015],
    supportedVersions: ['public'],
    configFiles: {},
    logConfig: { custom: false, location: '' },
    variables: [
      {
        name: 'Starting Map',
        description: 'Map loaded on boot.',
        envVariable: 'MAP',
        defaultValue: 'ctf_2fort',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:64',
        sortOrder: 1,
      },
      {
        name: 'Game Server Login Token',
        description: 'Steam GSLT (app id 232250).',
        envVariable: 'STEAM_ACC',
        defaultValue: '',
        userViewable: true,
        userEditable: true,
        rules: 'string|max:64',
        sortOrder: 2,
      },
      {
        name: 'Tickrate',
        description: 'Server tickrate.',
        envVariable: 'TICKRATE',
        defaultValue: '66',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:33,128',
        sortOrder: 3,
      },
      {
        name: 'Max Players',
        description: 'Player slot count.',
        envVariable: 'MAX_PLAYERS',
        defaultValue: '24',
        userViewable: true,
        userEditable: true,
        rules: 'required|integer|between:1,101',
        sortOrder: 4,
      },
      PORT_VARIABLE(27015, 5),
    ],
  },
  {
    name: 'Factorio',
    slug: 'factorio',
    game: 'Factorio',
    category: 'Simulation',
    description: 'Factorio headless server with automatic save creation and mod folder support.',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './bin/x64/factorio --start-server /home/container/saves/{{SAVE_NAME}}.zip --server-settings /home/container/data/server-settings.json --port {{SERVER_PORT}}',
    stopCommand: '^C',
    installContainer: 'debian:bookworm-slim',
    installEntrypoint: 'bash',
    installScript: `#!/bin/bash
set -euo pipefail
apt-get update -qq && apt-get install -y -qq curl xz-utils ca-certificates >/dev/null
mkdir -p /mnt/server && cd /mnt/server

VERSION="\${FACTORIO_VERSION:-stable}"
echo "[storm] Downloading Factorio headless (\$VERSION) ..."
curl -fsSL -o factorio.tar.xz "https://factorio.com/get-download/\${VERSION}/headless/linux64"
tar -xJf factorio.tar.xz --strip-components=1 && rm -f factorio.tar.xz

mkdir -p saves data mods
if [ ! -f "saves/\${SAVE_NAME:-storm}.zip" ]; then
  ./bin/x64/factorio --create "saves/\${SAVE_NAME:-storm}.zip"
fi
if [ ! -f data/server-settings.json ]; then
  cp data/server-settings.example.json data/server-settings.json 2>/dev/null || \\
  cat > data/server-settings.json <<'JSON'
{
  "name": "Storm Factorio Server",
  "description": "Powered by Storm Panel",
  "max_players": 0,
  "visibility": { "public": false, "lan": true },
  "require_user_verification": false,
  "autosave_interval": 10,
  "autosave_slots": 5
}
JSON
fi
echo "[storm] Install complete."
`,
    startupDetection: 'Hosting game at|Factorio initialised',
    crashDetection: 'Error ServerMultiplayerManager|Segmentation fault',
    defaultPorts: [34197],
    supportedVersions: ['stable', 'latest'],
    configFiles: {},
    logConfig: { custom: false, location: '' },
    variables: [
      {
        name: 'Factorio Version',
        description: '"stable", "latest" or an explicit version such as 2.0.28.',
        envVariable: 'FACTORIO_VERSION',
        defaultValue: 'stable',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:32',
        sortOrder: 1,
      },
      {
        name: 'Save Name',
        description: 'Save file used when the server boots.',
        envVariable: 'SAVE_NAME',
        defaultValue: 'storm',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:32|regex:^[A-Za-z0-9_-]+$',
        sortOrder: 2,
      },
      PORT_VARIABLE(34197, 3),
    ],
  },
  {
    name: 'Project Zomboid',
    slug: 'project-zomboid',
    game: 'Project Zomboid',
    category: 'Survival',
    description: 'Project Zomboid dedicated server (SteamCMD app 380870).',
    dockerImages: { 'Debian Bookworm': 'debian:bookworm-slim' },
    defaultImage: 'debian:bookworm-slim',
    startupCommand:
      './start-server.sh -servername {{SERVER_NAME}} -adminpassword "{{ADMIN_PASSWORD}}" -port {{SERVER_PORT}} -cachedir=/home/container/zomboid',
    stopCommand: 'quit',
    installContainer: 'cm2network/steamcmd:root',
    installEntrypoint: 'bash',
    installScript: STEAMCMD_INSTALL('380870', '\nmkdir -p /mnt/server/zomboid'),
    startupDetection: 'SERVER STARTED|Server Steam ID',
    crashDetection: 'Segmentation fault|java.lang.OutOfMemoryError',
    defaultPorts: [16261, 16262],
    supportedVersions: ['public'],
    configFiles: {},
    logConfig: { custom: false, location: '' },
    variables: [
      {
        name: 'Server Name',
        description: 'Config/save name used by the server.',
        envVariable: 'SERVER_NAME',
        defaultValue: 'storm',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|max:32|regex:^[A-Za-z0-9_-]+$',
        sortOrder: 1,
      },
      {
        name: 'Admin Password',
        description: 'Password for the in-game admin account.',
        envVariable: 'ADMIN_PASSWORD',
        defaultValue: '',
        userViewable: true,
        userEditable: true,
        rules: 'required|string|min:8|max:64',
        sortOrder: 2,
      },
      PORT_VARIABLE(16261, 3),
    ],
  },
];
