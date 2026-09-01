import type {
  BackupStatus,
  DatabaseEngine,
  NodeStatus,
  NotificationLevel,
  Protocol,
  RoleName,
  ScheduleAction,
  ServerStatus,
} from './enums.js';
import type { Permission } from './permissions.js';

/**
 * Serialised representations returned by the REST API. These are deliberately
 * narrower than the Prisma models: secrets, hashes and internal columns never
 * cross the wire.
 */

export interface UserSummary {
  id: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  role: RoleName;
  avatarUrl: string | null;
  emailVerified: boolean;
  suspended: boolean;
  twoFactorEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserDetail extends UserSummary {
  permissions: Permission[];
  limits: UserLimits;
  serverCount: number;
  updatedAt: string;
}

export interface UserLimits {
  serverLimit: number;
  cpuLimit: number;
  memoryLimit: number;
  diskLimit: number;
  backupLimit: number;
  databaseLimit: number;
  allocationLimit: number;
}

export interface SessionSummary {
  id: string;
  ip: string | null;
  userAgent: string | null;
  deviceLabel: string | null;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface AllocationSummary {
  id: string;
  ip: string;
  port: number;
  protocol: Protocol;
  alias: string | null;
  isPrimary: boolean;
  serverId: string | null;
  nodeId: string;
}

/** Optional panels a game template can turn on for its servers. */
export const TemplateFeature = {
  /** Browse and install plugins from Modrinth. Minecraft: Java only. */
  PLUGINS: 'plugins',
  /** Operators, whitelist and bans. Minecraft: Java only. */
  PLAYERS: 'players',
} as const;
export type TemplateFeature = (typeof TemplateFeature)[keyof typeof TemplateFeature];

export interface ServerSummary {
  id: string;
  uuid: string;
  shortId: string;
  name: string;
  description: string | null;
  status: ServerStatus;
  suspended: boolean;
  installed: boolean;
  /** Whether the panel restarts this server on its own after a crash. */
  autoRestart: boolean;
  node: { id: string; name: string; location: string; status: NodeStatus };
  template: {
    id: string;
    name: string;
    slug: string;
    game: string;
    category: string;
    /**
     * Label to image, e.g. { 'Java 25': 'eclipse-temurin:25-jre' }. The startup
     * tab offers these and the API accepts only these, so a customer cannot
     * point their container at an arbitrary registry.
     */
    dockerImages: Record<string, string>;
    /**
     * Optional panels this server gets, e.g. `['plugins']`. The template says
     * so rather than the panel matching on a slug, so an operator's own
     * Minecraft template keeps the plugin browser and a renamed one does not
     * lose it.
     */
    features: TemplateFeature[];
  } | null;
  owner: { id: string; username: string; email: string } | null;
  primaryAllocation: AllocationSummary | null;
  limits: ServerLimits;
  createdAt: string;
}

export interface ServerLimits {
  cpuLimit: number;
  memoryLimit: number;
  diskLimit: number;
  swapLimit: number;
  ioWeight: number;
  pidsLimit: number;
  oomKill: boolean;
}

export interface ServerDetail extends ServerSummary {
  dockerImage: string;
  startupCommand: string;
  allocations: AllocationSummary[];
  variables: ServerVariableView[];
  permissions: Permission[];
  sftp: { host: string; port: number; username: string } | null;
  installedAt: string | null;
  updatedAt: string;
}

export interface ServerVariableView {
  key: string;
  value: string;
  name: string;
  description: string;
  editable: boolean;
  viewable: boolean;
  rules: string;
  defaultValue: string;
}

export interface NodeSummary {
  id: string;
  uuid: string;
  name: string;
  location: string;
  region: string | null;
  hostname: string;
  ip: string;
  status: NodeStatus;
  maintenanceMode: boolean;
  cpuCores: number;
  memoryTotal: number;
  diskTotal: number;
  dockerVersion: string | null;
  agentVersion: string | null;
  lastHeartbeatAt: string | null;
  serverCount: number;
  allocationCount: number;
  allocatedMemory: number;
  allocatedDisk: number;
}

export interface NodeDetail extends NodeSummary {
  description: string | null;
  os: string | null;
  kernel: string | null;
  cpuModel: string | null;
  scheme: 'http' | 'https';
  agentPort: number;
  sftpPort: number;
  publicIp: string | null;
  dataDirectory: string;
  backupDirectory: string;
  memoryOvercommit: number;
  diskOvercommit: number;
  isPublic: boolean;
  liveStats: NodeLiveStats | null;
  createdAt: string;
}

export interface NodeLiveStats {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  networkRx: number;
  networkTx: number;
  containers: number;
  containersRunning: number;
  uptime: number;
  timestamp: string;
}

export interface BackupSummary {
  id: string;
  uuid: string;
  name: string;
  status: BackupStatus;
  bytes: number;
  checksum: string | null;
  isLocked: boolean;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  cron: {
    minute: string;
    hour: string;
    dayOfMonth: string;
    month: string;
    dayOfWeek: string;
  };
  timezone: string;
  isActive: boolean;
  onlyWhenOnline: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  tasks: ScheduleTaskView[];
}

export interface ScheduleTaskView {
  id: string;
  action: ScheduleAction;
  payload: string;
  timeOffsetSec: number;
  sequence: number;
  continueOnFailure: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface ServerDatabaseView {
  id: string;
  name: string;
  username: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  remoteAccess: string;
  connectionString: string | null;
  password?: string;
  createdAt: string;
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  message: string;
  level: NotificationLevel;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface AuditLogView {
  id: string;
  action: string;
  actor: { id: string; username: string; email: string } | null;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ActivityLogView {
  id: string;
  event: string;
  user: { id: string; username: string } | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardOverview {
  servers: {
    total: number;
    online: number;
    offline: number;
    suspended: number;
    installing: number;
  };
  resources: {
    cpuAllocated: number;
    memoryAllocated: number;
    memoryUsed: number;
    diskAllocated: number;
    diskUsed: number;
    networkRx: number;
    networkTx: number;
  };
  recentActivity: ActivityLogView[];
  notifications: NotificationView[];
}

export interface AdminOverview {
  users: { total: number; online: number; suspended: number; newThisWeek: number };
  servers: { total: number; online: number; offline: number; suspended: number };
  nodes: { total: number; online: number; offline: number; degraded: number; maintenance: number };
  resources: {
    cpuPercent: number;
    memoryUsed: number;
    memoryTotal: number;
    diskUsed: number;
    diskTotal: number;
    networkRx: number;
    networkTx: number;
  };
  recentEvents: AuditLogView[];
}

export interface TemplateSummary {
  id: string;
  uuid: string;
  name: string;
  slug: string;
  game: string;
  category: string;
  description: string;
  author: string;
  defaultImage: string;
  dockerImages: Record<string, string>;
  defaultPorts: number[];
  supportedVersions: string[];
  version: number;
  isActive: boolean;
  serverCount: number;
  createdAt: string;
}

export interface TemplateDetail extends TemplateSummary {
  startupCommand: string;
  stopCommand: string;
  installScript: string;
  installContainer: string;
  installEntrypoint: string;
  startupDetection: string;
  crashDetection: string;
  configFiles: Record<string, unknown>;
  logConfig: Record<string, unknown>;
  variables: TemplateVariableView[];
  updatedAt: string;
}

export interface TemplateVariableView {
  id: string;
  name: string;
  description: string;
  envVariable: string;
  defaultValue: string;
  userViewable: boolean;
  userEditable: boolean;
  rules: string;
  sortOrder: number;
}
