'use client';

import * as React from 'react';
import type {
  ServerLiveStats,
  ServerSocketCommand,
  ServerSocketEvent,
  ServerStatus,
} from '@storm/types';

export type SocketState = 'connecting' | 'open' | 'closed' | 'error';

export interface ServerSocket {
  state: SocketState;
  status: ServerStatus | null;
  stats: ServerLiveStats | null;
  /** Console lines in arrival order, capped to keep the DOM light. */
  lines: ConsoleLine[];
  send: (command: ServerSocketCommand) => void;
  clear: () => void;
  reconnect: () => void;
}

export interface ConsoleLine {
  id: number;
  text: string;
  at: string;
  kind: 'output' | 'install' | 'system';
}

const MAX_LINES = 2000;
const MAX_BACKOFF = 15_000;

/**
 * Live connection to one server: console output, status transitions and
 * resource samples all arrive on the same socket.
 *
 * Reconnects with exponential backoff and jitter — when a node restarts, every
 * open browser tab would otherwise stampede the panel at the same instant.
 */
export function useServerSocket(serverId: string | null): ServerSocket {
  const [state, setState] = React.useState<SocketState>('connecting');
  const [status, setStatus] = React.useState<ServerStatus | null>(null);
  const [stats, setStats] = React.useState<ServerLiveStats | null>(null);
  const [lines, setLines] = React.useState<ConsoleLine[]>([]);

  const socketRef = React.useRef<WebSocket | null>(null);
  const attemptRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const counterRef = React.useRef(0);
  const closedByUs = React.useRef(false);

  const append = React.useCallback((text: string, kind: ConsoleLine['kind'], at?: string) => {
    counterRef.current += 1;
    const line: ConsoleLine = {
      id: counterRef.current,
      text,
      at: at ?? new Date().toISOString(),
      kind,
    };
    setLines((current) => {
      const next = current.length >= MAX_LINES ? current.slice(-(MAX_LINES - 1)) : current;
      return [...next, line];
    });
  }, []);

  const connect = React.useCallback(() => {
    if (!serverId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/api/v1/servers/${serverId}/ws`;

    setState('connecting');
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => {
      attemptRef.current = 0;
      setState('open');
      socket.send(JSON.stringify({ type: 'logs' } satisfies ServerSocketCommand));
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let message: ServerSocketEvent;
      try {
        message = JSON.parse(event.data) as ServerSocketEvent;
      } catch {
        return;
      }

      switch (message.type) {
        case 'ready':
          setStatus(message.status);
          break;
        case 'console':
          append(message.line, 'output', message.timestamp);
          break;
        case 'console:history':
          counterRef.current += message.lines.length;
          setLines(
            message.lines.slice(-MAX_LINES).map((text, index) => ({
              id: counterRef.current - message.lines.length + index,
              text,
              at: new Date().toISOString(),
              kind: 'output' as const,
            })),
          );
          break;
        case 'install':
          append(message.line, 'install');
          break;
        case 'status':
          setStatus(message.status);
          break;
        case 'stats':
          setStats(message.stats);
          break;
        case 'error':
          append(`[panel] ${message.message}`, 'system');
          break;
        default:
          break;
      }
    };

    socket.onerror = () => {
      setState('error');
    };

    socket.onclose = () => {
      socketRef.current = null;
      if (closedByUs.current) {
        setState('closed');
        return;
      }

      setState('closed');
      attemptRef.current += 1;
      const backoff = Math.min(1000 * 2 ** (attemptRef.current - 1), MAX_BACKOFF);
      const jitter = Math.random() * 400;
      timerRef.current = setTimeout(connect, backoff + jitter);
    };
  }, [serverId, append]);

  React.useEffect(() => {
    closedByUs.current = false;
    connect();

    return () => {
      closedByUs.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect]);

  // Keep the connection alive through proxies that cull idle sockets.
  React.useEffect(() => {
    const interval = setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'ping' } satisfies ServerSocketCommand));
      }
    }, 25_000);
    return () => clearInterval(interval);
  }, []);

  const send = React.useCallback((command: ServerSocketCommand) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(command));
    }
  }, []);

  const reconnect = React.useCallback(() => {
    attemptRef.current = 0;
    socketRef.current?.close();
    connect();
  }, [connect]);

  return {
    state,
    status,
    stats,
    lines,
    send,
    clear: () => setLines([]),
    reconnect,
  };
}
