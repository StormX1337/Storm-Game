import type { NodeStatus, NotificationLevel, ServerStatus } from './enums.js';

/** Messages the panel pushes to a browser attached to a server socket. */
export type ServerSocketEvent =
  | { type: 'ready'; serverId: string; status: ServerStatus }
  | { type: 'console'; line: string; timestamp: string }
  | { type: 'console:history'; lines: string[] }
  | { type: 'status'; status: ServerStatus }
  | { type: 'stats'; stats: ServerLiveStats }
  | { type: 'install'; line: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

/** Messages a browser sends on a server socket. */
export type ServerSocketCommand =
  | { type: 'command'; command: string }
  | { type: 'power'; action: 'start' | 'stop' | 'restart' | 'kill' }
  | { type: 'logs' }
  | { type: 'ping' };

export interface ServerLiveStats {
  cpuPercent: number;
  cpuLimit: number;
  memoryBytes: number;
  memoryLimit: number;
  diskBytes: number;
  diskLimit: number;
  networkRx: number;
  networkTx: number;
  uptime: number;
  players?: { online: number; max: number } | null;
  timestamp: string;
}

/** Messages the panel pushes on the account-wide socket. */
export type AccountSocketEvent =
  | { type: 'ready'; userId: string }
  | {
      type: 'notification';
      notification: {
        id: string;
        title: string;
        message: string;
        level: NotificationLevel;
        link: string | null;
        createdAt: string;
      };
    }
  | { type: 'server:status'; serverId: string; status: ServerStatus }
  | { type: 'server:stats'; serverId: string; stats: ServerLiveStats }
  | { type: 'node:status'; nodeId: string; status: NodeStatus }
  | { type: 'pong' };

export const REDIS_CHANNELS = {
  serverStatus: 'storm:server:status',
  serverStats: 'storm:server:stats',
  nodeStatus: 'storm:node:status',
  notifications: 'storm:notifications',
} as const;
