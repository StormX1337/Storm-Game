import type { PowerAction, ServerStatus } from './enums.js';

/**
 * Wire protocol between the panel and a Storm Node Agent.
 *
 * The panel is always the client: it authenticates with the node's token
 * (`Authorization: Bearer <tokenId>.<token>`) and signs the request body with
 * the node secret (`X-Storm-Signature`). The agent never dials back into the
 * panel except for the heartbeat and SFTP credential validation endpoints,
 * which use the same token pair in reverse.
 */

export const AGENT_API_PREFIX = '/api/v1';

export interface AgentSystemInfo {
  agentVersion: string;
  dockerVersion: string;
  kernel: string;
  os: string;
  architecture: string;
  cpuCores: number;
  cpuModel: string;
  memoryTotal: number; // bytes
  diskTotal: number; // bytes
}

export interface AgentSystemStats {
  cpuPercent: number;
  memoryTotal: number;
  memoryUsed: number;
  diskTotal: number;
  diskUsed: number;
  networkRx: number;
  networkTx: number;
  containers: number;
  containersRunning: number;
  loadAverage: [number, number, number];
  uptime: number;
  timestamp: string;
}

export interface AgentPortBinding {
  ip: string;
  port: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface AgentMount {
  source: string;
  target: string;
  readOnly: boolean;
}

/** Formats the agent can rewrite in place. */
export type ConfigFileParser = 'properties' | 'ini' | 'json' | 'yaml';

/**
 * One of the game's own configuration files, kept in step with the server's
 * allocation and limits. The panel resolves every placeholder before sending
 * this, so the agent only ever writes literal values.
 */
export interface AgentConfigFile {
  /** Path relative to the server's data directory. */
  path: string;
  parser: ConfigFileParser;
  /** Key (dotted path for structured formats) -> literal value. */
  find: Record<string, string>;
}

/** Everything the agent needs to materialise a container. */
export interface AgentServerSpec {
  uuid: string;
  name: string;
  image: string;
  startupCommand: string;
  stopCommand: string;
  environment: Record<string, string>;
  limits: {
    cpuPercent: number; // 0 = unlimited
    memoryMb: number;
    swapMb: number; // -1 = unlimited
    diskMb: number;
    ioWeight: number; // 10..1000
    pidsLimit: number;
    oomKill: boolean;
  };
  ports: AgentPortBinding[];
  mounts: AgentMount[];
  /** Regex matched against console output to detect a fully booted server. */
  startupDetection?: string;
  /** Regex matched against console output to detect a crash loop. */
  crashDetection?: string;
  /** Rewritten immediately before each start, so ports always match. */
  configFiles?: AgentConfigFile[];
  labels: Record<string, string>;
}

export interface AgentInstallSpec {
  uuid: string;
  container: string;
  entrypoint: string;
  script: string;
  environment: Record<string, string>;
  serverImage: string;
}

export interface AgentServerState {
  uuid: string;
  status: ServerStatus;
  containerId?: string;
  installing: boolean;
  exists: boolean;
}

export interface AgentServerStats {
  uuid: string;
  status: ServerStatus;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimit: number;
  diskBytes: number;
  networkRx: number;
  networkTx: number;
  uptime: number;
  timestamp: string;
}

export interface AgentPowerRequest {
  action: PowerAction;
  /** Wait for the container to reach the target state before responding. */
  wait?: boolean;
}

export interface AgentFileEntry {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  mimeType: string;
  mode: string;
  modifiedAt: string;
  createdAt: string;
}

export interface AgentBackupRequest {
  uuid: string;
  backupUuid: string;
  ignore: string[];
  /** Where the agent should hand the finished archive to. */
  upload?: AgentUploadTarget;
}

export interface AgentUploadTarget {
  driver: 'LOCAL' | 'S3' | 'R2' | 'MINIO';
  /** Pre-signed PUT URL for object storage drivers. */
  url?: string;
  headers?: Record<string, string>;
  /** Object key, used for logging and local paths. */
  key: string;
}

export interface AgentBackupResult {
  backupUuid: string;
  bytes: number;
  checksum: string;
  checksumType: 'sha256';
  completedAt: string;
}

export interface AgentRestoreRequest {
  uuid: string;
  backupUuid: string;
  /** Wipe the server directory before unpacking. */
  truncate: boolean;
  download?: AgentDownloadSource;
  /**
   * The sha256 the panel recorded when the archive was made.
   *
   * Optional, because backups taken before this was sent have none on record
   * and an older panel does not send one. When it is here the agent proves the
   * bytes match it before unpacking them over a live server.
   */
  checksum?: string;
}

/**
 * Where a node fetches an archive from during a restore.
 *
 * `LOCAL` means "already on this node's own disk"; every other value means
 * "download it from `url`". `PANEL` is that second case with the panel as the
 * source: it is how a server moves between two nodes on a deployment with no
 * object storage, with the panel streaming the archive from the old node to
 * the new one.
 */
export interface AgentDownloadSource {
  driver: 'LOCAL' | 'S3' | 'R2' | 'MINIO' | 'PANEL';
  url?: string;
  headers?: Record<string, string>;
  key: string;
}

/** Messages streamed over the agent's per-server WebSocket. */
export type AgentSocketMessage =
  | { type: 'auth:success'; uuid: string }
  | { type: 'console:line'; line: string; timestamp: string }
  | { type: 'console:history'; lines: string[] }
  | { type: 'status'; status: ServerStatus }
  | { type: 'stats'; stats: AgentServerStats }
  | { type: 'install:output'; line: string }
  | { type: 'error'; message: string };

export type AgentSocketCommand =
  | { type: 'auth'; token: string }
  | { type: 'command'; command: string }
  | { type: 'power'; action: PowerAction }
  | { type: 'logs'; lines?: number }
  | { type: 'ping' };

/** Heartbeat the agent pushes to the panel every `heartbeatInterval` seconds. */
export interface AgentHeartbeat {
  agentVersion: string;
  system: AgentSystemInfo;
  stats: AgentSystemStats;
  servers: AgentServerState[];
}
