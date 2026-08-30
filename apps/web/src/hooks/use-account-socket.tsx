'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@storm/ui';
import type { AccountSocketEvent, NotificationLevel, ServerLiveStats, ServerStatus } from '@storm/types';

export interface LiveServerState {
  status?: ServerStatus;
  stats?: ServerLiveStats;
}

interface AccountSocketValue {
  connected: boolean;
  /** Latest status and stats per server id, for live list and dashboard tiles. */
  servers: Record<string, LiveServerState>;
  unreadCount: number;
  setUnreadCount: (count: number | ((current: number) => number)) => void;
}

const AccountSocketContext = React.createContext<AccountSocketValue>({
  connected: false,
  servers: {},
  unreadCount: 0,
  setUnreadCount: () => undefined,
});

export function useAccountSocket(): AccountSocketValue {
  return React.useContext(AccountSocketContext);
}

const TOAST_LEVEL: Record<NotificationLevel, 'success' | 'error' | 'warning' | 'info'> = {
  SUCCESS: 'success',
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

/**
 * One account-wide socket for the whole session: notifications, plus status and
 * stats for every server the user can see. Opening a socket per card would not
 * scale past a handful of servers.
 */
export function AccountSocketProvider({
  children,
  enabled,
}: {
  children: React.ReactNode;
  enabled: boolean;
}): React.JSX.Element {
  const [connected, setConnected] = React.useState(false);
  const [servers, setServers] = React.useState<Record<string, LiveServerState>>({});
  const [unreadCount, setUnreadCount] = React.useState(0);

  const toast = useToast();
  const queryClient = useQueryClient();
  const socketRef = React.useRef<WebSocket | null>(null);
  const attemptRef = React.useRef(0);
  const stoppedRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled) return undefined;

    stoppedRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${window.location.host}/api/v1/ws`);
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        let message: AccountSocketEvent;
        try {
          message = JSON.parse(event.data) as AccountSocketEvent;
        } catch {
          return;
        }

        switch (message.type) {
          case 'notification': {
            const level = TOAST_LEVEL[message.notification.level] ?? 'info';
            toast[level](message.notification.title, message.notification.message);
            setUnreadCount((count) => count + 1);
            void queryClient.invalidateQueries({ queryKey: ['notifications'] });
            break;
          }
          case 'server:status': {
            setServers((current) => ({
              ...current,
              [message.serverId]: { ...current[message.serverId], status: message.status },
            }));
            // The list query holds the authoritative row; nudge it so badges,
            // action availability and counts stay in step.
            void queryClient.invalidateQueries({ queryKey: ['servers'] });
            break;
          }
          case 'server:stats': {
            setServers((current) => ({
              ...current,
              [message.serverId]: { ...current[message.serverId], stats: message.stats },
            }));
            break;
          }
          case 'node:status': {
            void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
            break;
          }
          default:
            break;
        }
      };

      socket.onclose = () => {
        setConnected(false);
        socketRef.current = null;
        if (stoppedRef.current) return;

        attemptRef.current += 1;
        const backoff = Math.min(1000 * 2 ** (attemptRef.current - 1), 15_000);
        timer = setTimeout(connect, backoff + Math.random() * 400);
      };
    };

    connect();

    const ping = setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25_000);

    return () => {
      stoppedRef.current = true;
      clearInterval(ping);
      if (timer) clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled, toast, queryClient]);

  const value = React.useMemo<AccountSocketValue>(
    () => ({ connected, servers, unreadCount, setUnreadCount }),
    [connected, servers, unreadCount],
  );

  return <AccountSocketContext.Provider value={value}>{children}</AccountSocketContext.Provider>;
}
