'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoveRight } from 'lucide-react';
import { Permission, type NodeSummary } from '@storm/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useConfirm,
  useToast,
} from '@storm/ui';
import { api, apiPaginated, errorMessage } from '@/lib/api';
import { formatMib } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import { useServer } from '@/components/panel/server-context';

/**
 * Moving a server to a different node.
 *
 * The move runs on a queue for as long as the files take to copy, so this only
 * starts it. The server keeps running on its current node until the copy has
 * landed on the new one, which is why the confirmation talks about downtime
 * rather than about risk.
 */
export function ServerMoveCard() {
  const { server, status } = useServer();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [target, setTarget] = React.useState<string>('');

  // Mirrors the endpoint, which is gated on admin.servers.
  const allowed = can(Permission.ADMIN_SERVERS);

  const nodes = useQuery({
    queryKey: ['admin', 'nodes', 'for-move'],
    // apiPaginated, not api.get: a paginated endpoint answers with the array
    // as `data` and the page info beside it, so reading `.items` off a plain
    // get would quietly find nothing and offer no nodes at all.
    queryFn: () => apiPaginated<NodeSummary>('/admin/nodes', { query: { perPage: 100 } }),
    enabled: allowed,
  });

  const move = useMutation({
    mutationFn: () => api.post(`/admin/servers/${server.id}/move`, { nodeId: target }),
    onSuccess: () => {
      toast.success(
        'Move started',
        'The server is archived, rebuilt on the new node and restored there. It stays on the old one until that works.',
      );
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId] });
    },
    onError: (error) => toast.error('Could not start the move', errorMessage(error)),
  });

  if (!allowed) return null;

  const candidates = (nodes.data?.items ?? []).filter(
    (node) => node.id !== server.node.id && !node.maintenanceMode && node.status === 'ONLINE',
  );
  const chosen = candidates.find((node) => node.id === target);
  const busy = status === 'INSTALLING' || status === 'REINSTALLING' || status === 'TRANSFERRING';

  const start = async (): Promise<void> => {
    if (!chosen) return;
    const confirmed = await confirm({
      title: `Move to ${chosen.name}?`,
      description:
        'The server is stopped, its files are archived and copied to the new node, then restored there. ' +
        'It is offline for as long as that takes — minutes for a small server, longer for a large world. ' +
        'Its address changes, so anything that connects to it needs the new one.',
      confirmLabel: 'Move it',
    });
    if (confirmed) move.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Move to another node</CardTitle>
        <CardDescription>
          Currently on <span className="font-medium">{server.node.name}</span>. The files travel in
          an archive: straight between the nodes through shared storage if there is any, otherwise
          streamed by the panel, which is slower.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {nodes.isLoading
              ? 'Looking for nodes…'
              : 'No other node is online and taking servers right now.'}
          </p>
        ) : (
          <>
            <Field label="Destination" htmlFor="move-node">
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger id="move-node">
                  <SelectValue placeholder="Choose a node" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.name} · {node.location} ·{' '}
                      {formatMib(node.memoryTotal - node.allocatedMemory, 0)} free
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <div className="flex justify-end">
              <Button
                onClick={() => void start()}
                loading={move.isPending}
                disabled={!chosen || busy}
              >
                <MoveRight />
                Start the move
              </Button>
            </div>

            {busy ? (
              <p className="text-sm text-muted-foreground">
                A server that is {status.toLowerCase()} has to settle first.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
