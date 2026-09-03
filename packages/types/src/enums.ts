/**
 * Enumerations shared by the panel API, the web client and the node agent.
 * These mirror the Prisma enums one-to-one; the database package re-exports
 * Prisma's generated enums, while everything else consumes these plain objects
 * so that the browser bundle never pulls in the Prisma runtime.
 */

export const RoleName = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  STAFF: 'STAFF',
  SUPPORT: 'SUPPORT',
  CUSTOMER: 'CUSTOMER',
} as const;
export type RoleName = (typeof RoleName)[keyof typeof RoleName];

/** Ordered from most to least privileged. Used for "can this user act on that user" checks. */
export const ROLE_PRIORITY: Record<RoleName, number> = {
  OWNER: 100,
  ADMIN: 80,
  STAFF: 60,
  SUPPORT: 40,
  CUSTOMER: 10,
};

export const ServerStatus = {
  INSTALLING: 'INSTALLING',
  INSTALL_FAILED: 'INSTALL_FAILED',
  STARTING: 'STARTING',
  ONLINE: 'ONLINE',
  STOPPING: 'STOPPING',
  OFFLINE: 'OFFLINE',
  CRASHED: 'CRASHED',
  SUSPENDED: 'SUSPENDED',
  REINSTALLING: 'REINSTALLING',
  TRANSFERRING: 'TRANSFERRING',
} as const;
export type ServerStatus = (typeof ServerStatus)[keyof typeof ServerStatus];

/** Statuses in which the server is considered "reachable / doing something". */
export const ACTIVE_SERVER_STATUSES: ServerStatus[] = [
  ServerStatus.STARTING,
  ServerStatus.ONLINE,
  ServerStatus.STOPPING,
];

/**
 * Statuses in which the panel, not the customer, owns the server's files.
 *
 * An install script runs in its own throwaway container against the same data
 * directory, and a move copies that directory to another machine. Neither can
 * survive the game server writing underneath it, so nothing may power the
 * container up until the job is done. INSTALL_FAILED is in the list because a
 * reinstall that fell over may have wiped the directory on its way past:
 * `installedAt` still says the server was installed once, which was enough to
 * let a customer start it into whatever the failed run left behind.
 */
export const INSTALL_BUSY_STATUSES: ServerStatus[] = [
  ServerStatus.INSTALLING,
  ServerStatus.REINSTALLING,
  ServerStatus.INSTALL_FAILED,
  ServerStatus.TRANSFERRING,
];

/** True while an install, reinstall or move owns the server's data directory. */
export function isInstallBusy(status: ServerStatus): boolean {
  return INSTALL_BUSY_STATUSES.includes(status);
}

export const NodeStatus = {
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
  DEGRADED: 'DEGRADED',
  MAINTENANCE: 'MAINTENANCE',
} as const;
export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];

export const PowerAction = {
  START: 'start',
  STOP: 'stop',
  RESTART: 'restart',
  KILL: 'kill',
} as const;
export type PowerAction = (typeof PowerAction)[keyof typeof PowerAction];

export const BackupStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  RESTORING: 'RESTORING',
  DELETING: 'DELETING',
} as const;
export type BackupStatus = (typeof BackupStatus)[keyof typeof BackupStatus];

export const BackupDriver = {
  LOCAL: 'LOCAL',
  S3: 'S3',
  R2: 'R2',
  MINIO: 'MINIO',
} as const;
export type BackupDriver = (typeof BackupDriver)[keyof typeof BackupDriver];

export const ScheduleAction = {
  POWER_START: 'POWER_START',
  POWER_STOP: 'POWER_STOP',
  POWER_RESTART: 'POWER_RESTART',
  POWER_KILL: 'POWER_KILL',
  COMMAND: 'COMMAND',
  BACKUP: 'BACKUP',
  NOTIFY: 'NOTIFY',
} as const;
export type ScheduleAction = (typeof ScheduleAction)[keyof typeof ScheduleAction];

export const DatabaseEngine = {
  POSTGRES: 'POSTGRES',
  MYSQL: 'MYSQL',
} as const;
export type DatabaseEngine = (typeof DatabaseEngine)[keyof typeof DatabaseEngine];

export const Protocol = {
  TCP: 'TCP',
  UDP: 'UDP',
} as const;
export type Protocol = (typeof Protocol)[keyof typeof Protocol];

export const NotificationLevel = {
  INFO: 'INFO',
  SUCCESS: 'SUCCESS',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
} as const;
export type NotificationLevel = (typeof NotificationLevel)[keyof typeof NotificationLevel];

export const VerificationTokenType = {
  EMAIL_VERIFICATION: 'EMAIL_VERIFICATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
} as const;
export type VerificationTokenType =
  (typeof VerificationTokenType)[keyof typeof VerificationTokenType];

/** Events that can be delivered to configured webhooks. */
export const WebhookEvent = {
  SERVER_CREATED: 'server.created',
  SERVER_INSTALLED: 'server.installed',
  SERVER_STARTED: 'server.started',
  SERVER_STOPPED: 'server.stopped',
  SERVER_CRASHED: 'server.crashed',
  SERVER_RESOURCE_WARNING: 'server.resource_warning',
  SERVER_DELETED: 'server.deleted',
  SERVER_SUSPENDED: 'server.suspended',
  SERVER_UNSUSPENDED: 'server.unsuspended',
  BACKUP_CREATED: 'backup.created',
  BACKUP_COMPLETED: 'backup.completed',
  BACKUP_FAILED: 'backup.failed',
  BACKUP_RESTORED: 'backup.restored',
  NODE_ONLINE: 'node.online',
  NODE_OFFLINE: 'node.offline',
  USER_CREATED: 'user.created',
  USER_DELETED: 'user.deleted',
} as const;
export type WebhookEvent = (typeof WebhookEvent)[keyof typeof WebhookEvent];

export const WEBHOOK_EVENTS: WebhookEvent[] = Object.values(WebhookEvent);

/**
 * The share of its own limit at which a server is close enough to say so.
 *
 * Shared because two places act on it: the API warns the owner, and the panel
 * colours the card the notification links to. A percent of drift between them
 * is a support ticket — the mail says the server is running out and the page
 * it points at looks perfectly calm.
 */
export const RESOURCE_CEILING_RATIO = 0.9;

export const NotificationType = {
  SERVER_OFFLINE: 'SERVER_OFFLINE',
  SERVER_CRASHED: 'SERVER_CRASHED',
  SERVER_RESOURCE_WARNING: 'SERVER_RESOURCE_WARNING',
  SERVER_INSTALLED: 'SERVER_INSTALLED',
  SERVER_MOVED: 'SERVER_MOVED',
  BACKUP_COMPLETED: 'BACKUP_COMPLETED',
  BACKUP_FAILED: 'BACKUP_FAILED',
  BACKUP_RESTORED: 'BACKUP_RESTORED',
  NODE_OFFLINE: 'NODE_OFFLINE',
  NODE_ONLINE: 'NODE_ONLINE',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  NEW_LOGIN: 'NEW_LOGIN',
  SECURITY_EVENT: 'SECURITY_EVENT',
  SCHEDULE_FAILED: 'SCHEDULE_FAILED',
  GENERIC: 'GENERIC',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
