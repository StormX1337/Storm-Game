'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Network, Plus, Star, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useConfirm,
  useToast,
} from '@storm/ui';
import type { AllocationSummary } from '@storm/types';
import { api, errorMessage } from '@/lib/api';
import { useServer } from '@/components/panel/server-context';

interface SftpDetails {
  host: string;
  port: number;
  username: string;
  password: string | null;
}

export default function NetworkPage() {
  const { server, can } = useServer();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const allocations = useQuery({
    queryKey: ['server', server.shortId, 'allocations'],
    queryFn: () => api.get<AllocationSummary[]>(`/servers/${server.id}/allocations`),
    initialData: server.allocations,
  });

  const sftp = useQuery({
    queryKey: ['server', server.shortId, 'sftp'],
    queryFn: () => api.get<SftpDetails>(`/servers/${server.id}/sftp`),
    enabled: can('servers.sftp'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['server', server.shortId] });
  };

  const addPort = useMutation({
    mutationFn: () => api.post(`/servers/${server.id}/allocations`, {}),
    onSuccess: () => {
      toast.success('Port assigned');
      invalidate();
    },
    onError: (error) => toast.error('Could not assign a port', errorMessage(error)),
  });

  const removePort = useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${server.id}/allocations/${id}`),
    onSuccess: () => {
      toast.success('Port released');
      invalidate();
    },
    onError: (error) => toast.error('Could not release the port', errorMessage(error)),
  });

  const makePrimary = useMutation({
    mutationFn: (id: string) => api.post(`/servers/${server.id}/allocations/${id}/primary`, {}),
    onSuccess: () => {
      toast.success('Primary port updated', 'Restart the server for it to take effect.');
      invalidate();
    },
    onError: (error) => toast.error('Could not update the primary port', errorMessage(error)),
  });

  const resetSftp = useMutation({
    mutationFn: () => api.post<{ password: string }>(`/servers/${server.id}/sftp/reset`, {}),
    onSuccess: () => {
      toast.success('SFTP password rotated');
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'sftp'] });
    },
    onError: (error) => toast.error('Could not rotate the password', errorMessage(error)),
  });

  const copy = async (value: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access.');
    }
  };

  const manage = can('servers.allocations') && !server.suspended;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Port allocations</CardTitle>
            <CardDescription>
              The primary port is what players connect to. Extra ports are for query, RCON or voice.
            </CardDescription>
          </div>
          {manage ? (
            <Button size="sm" onClick={() => addPort.mutate()} loading={addPort.isPending}>
              <Plus />
              Assign port
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {allocations.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : allocations.data && allocations.data.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Address</TableHead>
                  <TableHead className="w-24">Protocol</TableHead>
                  <TableHead className="w-28">Role</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {allocations.data.map((allocation) => (
                  <TableRow key={allocation.id}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() =>
                          void copy(`${allocation.ip}:${allocation.port}`, 'Address')
                        }
                        className="flex items-center gap-1.5 font-mono text-sm transition-colors hover:text-primary"
                      >
                        {allocation.ip}:{allocation.port}
                        <Copy className="h-3 w-3" />
                      </button>
                      {allocation.alias ? (
                        <span className="block text-xs text-muted-foreground">{allocation.alias}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{allocation.protocol}</Badge>
                    </TableCell>
                    <TableCell>
                      {allocation.isPrimary ? (
                        <Badge variant="default">Primary</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Additional</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {manage && !allocation.isPrimary ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => makePrimary.mutate(allocation.id)}
                            aria-label="Make primary"
                            title="Make primary"
                          >
                            <Star />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive"
                            aria-label="Release port"
                            onClick={() => {
                              void confirm({
                                title: `Release port ${allocation.port}?`,
                                description:
                                  'The port returns to the node pool and can be taken by another server.',
                                confirmLabel: 'Release',
                                destructive: true,
                              }).then((confirmed) => {
                                if (confirmed) removePort.mutate(allocation.id);
                              });
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState icon={Network} title="No ports assigned" />
          )}
        </CardContent>
      </Card>

      {can('servers.sftp') ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>SFTP access</CardTitle>
              <CardDescription>
                Connect any SFTP client to manage files outside the browser.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => resetSftp.mutate()}
              loading={resetSftp.isPending}
            >
              <KeyRound />
              Rotate password
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {sftp.isLoading ? (
              <Skeleton className="h-24" />
            ) : sftp.data ? (
              <>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <Row label="Host" value={sftp.data.host} onCopy={copy} />
                  <Row label="Port" value={String(sftp.data.port)} onCopy={copy} />
                  <Row label="Username" value={sftp.data.username} onCopy={copy} />
                  <Row
                    label="Password"
                    value={sftp.data.password ?? 'Hidden — rotate to reveal'}
                    onCopy={sftp.data.password ? copy : undefined}
                  />
                </dl>
                <div className="rounded-lg border border-border bg-secondary/40 p-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Quick connect</p>
                  <code className="block break-all font-mono text-xs">
                    sftp://{sftp.data.username}@{sftp.data.host}:{sftp.data.port}
                  </code>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">SFTP details are unavailable.</p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy?: (value: string, label: string) => Promise<void>;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-xs" title={value}>
          {value}
        </span>
        {onCopy ? (
          <button
            type="button"
            onClick={() => void onCopy(value, label)}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Copy ${label}`}
          >
            <Copy className="h-3 w-3" />
          </button>
        ) : null}
      </dd>
    </div>
  );
}
