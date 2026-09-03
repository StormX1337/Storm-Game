'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyPlus } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { formatMib } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

interface NodeOption {
  id: string;
  name: string;
  location: string;
}

/**
 * Another server like this one.
 *
 * Setting up the fourth server for the same customer meant filling in the same
 * eleven fields a fourth time — template, image, startup line, every variable,
 * every limit — and getting one of them subtly wrong on the fourth go.
 * Everything that decides what a server is can be read off this one; only the
 * name and where it goes cannot.
 *
 * The copy is a new server in every way that matters: its own identifier, its
 * own port, its own SFTP account, and its own install run. It is not a second
 * name for this one.
 */
export function ServerCloneCard() {
  const { server, can } = useServer();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = React.useState(`${server.name} (copy)`);
  const [nodeId, setNodeId] = React.useState('same');

  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.get<NodeOption[]>('/nodes'),
    // Only the operator gets a choice; a customer's copy lands where the
    // original is, which is the only node they were offered for it anyway.
    enabled: can('nodes.manage'),
  });

  const clone = useMutation({
    mutationFn: () =>
      api.post<{ shortId: string; name: string }>(`/servers/${server.id}/clone`, {
        name: name.trim(),
        ...(nodeId === 'same' ? {} : { nodeId }),
      }),
    onSuccess: (created) => {
      toast.success(`Created "${created.name}"`, 'It is installing now.');
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      router.push(`/servers/${created.shortId}`);
    },
    onError: (error) => toast.error('Could not copy this server', errorMessage(error)),
  });

  if (!can('servers.create')) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Copy this server</CardTitle>
        <CardDescription>
          A new server with the same template, image, startup command, variables and limits —{' '}
          {formatMib(server.limits.memoryLimit)} of memory and {formatMib(server.limits.diskLimit)}{' '}
          of disk. It gets its own port, its own SFTP account and a fresh install.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`${server.name} (copy)`}
            />
          </Field>

          {can('nodes.manage') ? (
            <Field label="Node">
              <Select value={nodeId} onValueChange={setNodeId}>
                <SelectTrigger aria-label="Node">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="same">Same node as this one</SelectItem>
                  {(nodes.data ?? []).map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.name} · {node.location}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button
            onClick={() => clone.mutate()}
            disabled={!name.trim() || server.suspended}
            loading={clone.isPending}
          >
            <CopyPlus />
            Create the copy
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
