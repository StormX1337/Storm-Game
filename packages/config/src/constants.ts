/** Values shared by more than one app that are not user-configurable. */
export const STORM_VERSION = '1.0.0';

export const COOKIE_NAMES = {
  accessToken: 'storm_access',
  refreshToken: 'storm_refresh',
  csrf: 'storm_csrf',
} as const;

/** BullMQ forbids `:` in queue names, so these use dashes. */
export const QUEUE_NAMES = {
  backups: 'storm-backups',
  schedules: 'storm-schedules',
  installs: 'storm-installs',
  webhooks: 'storm-webhooks',
  mail: 'storm-mail',
  maintenance: 'storm-maintenance',
} as const;

export const REDIS_KEYS = {
  serverStatus: (uuid: string) => `storm:server:${uuid}:status`,
  serverStats: (uuid: string) => `storm:server:${uuid}:stats`,
  nodeStats: (uuid: string) => `storm:node:${uuid}:stats`,
  nodeOnline: (uuid: string) => `storm:node:${uuid}:online`,
  loginAttempts: (key: string) => `storm:login:${key}`,
  settings: 'storm:settings',
  onlineUsers: 'storm:users:online',
} as const;

/** Docker resource defaults applied when a template does not specify them. */
export const DEFAULT_LIMITS = {
  cpuLimit: 200,
  memoryLimit: 2048,
  diskLimit: 10240,
  swapLimit: 0,
  ioWeight: 500,
  networkLimitMbps: 0,
  pidsLimit: 512,
  oomKill: true,
} as const;

export const MAX_CONSOLE_HISTORY = 400;
