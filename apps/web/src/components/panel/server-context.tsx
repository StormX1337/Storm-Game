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
  socketStatus,
  children,
}: {
  server: ServerDetail;
  /**
   * What the account socket last said about this server, which is the panel's
   * fastest and most complete answer: it arrives on every page, for every
   * transition, whether or not this tab caused it.
   *
   * It is a parameter rather than a subscription in here because the layout
   * above already holds that socket, and two subscriptions would be two
   * answers — which is the bug this exists to prevent. The header badge and
   * the power buttons were reading different sources, so a server that went
   * into REINSTALLING elsewhere showed the new status next to a lit Start
   * button that the API then refused.
   */
  socketStatus?: ServerStatus;
  children: React.ReactNode;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = React.useState<ServerStatus | null>(null);

  const reported = socketStatus ?? server.status;

  // Anything real supersedes the guess. Without this a press of Start would
  // pin "STARTING" over every later transition, including one that says the
  // server is being reinstalled and cannot be started at all.
  React.useEffect(() => {
    setOptimistic(null);
  }, [reported]);

  const permissions = React.useMemo(() => new Set(server.permissions), [server.permissions]);

  const value = React.useMemo<ServerContextValue>(
    () => ({
      server,
      status: optimistic ?? reported,
      setLiveStatus: setOptimistic,
      can: (...required) => required.some((permission) => permissions.has(permission as never)),
      refetch: async () => {
        await queryClient.invalidateQueries({ queryKey: ['server', server.shortId] });
      },
    }),
    [server, optimistic, reported, permissions, queryClient],
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
