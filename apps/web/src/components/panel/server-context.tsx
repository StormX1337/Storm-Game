'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServerDetail, ServerStatus } from '@storm/types';
import { api } from '@/lib/api';

interface ServerContextValue {
  server: ServerDetail;
  /** Live status when the socket has one, falling back to the fetched row. */
  status: ServerStatus;
  setLiveStatus: (status: ServerStatus) => void;
  can: (...permissions: string[]) => boolean;
  refetch: () => Promise<void>;
}

const ServerContext = React.createContext<ServerContextValue | null>(null);

export function useServer(): ServerContextValue {
  const context = React.useContext(ServerContext);
  if (!context) throw new Error('useServer must be used inside a server page');
  return context;
}

export function ServerProvider({
  server,
  children,
}: {
  server: ServerDetail;
  children: React.ReactNode;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [liveStatus, setLiveStatus] = React.useState<ServerStatus | null>(null);

  // A fresh fetch is authoritative again: drop the socket override so a
  // suspend or reinstall performed elsewhere is reflected immediately.
  React.useEffect(() => {
    setLiveStatus(null);
  }, [server.status]);

  const permissions = React.useMemo(() => new Set(server.permissions), [server.permissions]);

  const value = React.useMemo<ServerContextValue>(
    () => ({
      server,
      status: liveStatus ?? server.status,
      setLiveStatus,
      can: (...required) => required.some((permission) => permissions.has(permission as never)),
      refetch: async () => {
        await queryClient.invalidateQueries({ queryKey: ['server', server.shortId] });
      },
    }),
    [server, liveStatus, permissions, queryClient],
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServerQuery(id: string) {
  return useQuery({
    queryKey: ['server', id],
    queryFn: () => api.get<ServerDetail>(`/servers/${id}`),
    retry: (failureCount, error) => {
      // A 404 here means "not yours"; retrying only delays the message.
      const status = (error as { status?: number }).status;
      return status !== undefined && status >= 500 && failureCount < 2;
    },
  });
}
