'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Database, Eye, EyeOff, KeyRound, MoreVertical, Plus, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  Skeleton,
  useConfirm,
  useToast,
} from '@storm/ui';
import type { ServerDatabaseView } from '@storm/types';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

export default function DatabasesPage() {
  const { server, can } = useServer();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [revealed, setRevealed] = React.useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['server', server.shortId, 'databases'],
    queryFn: () => api.get<ServerDatabaseView[]>(`/servers/${server.id}/databases`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'databases'] });
  };

  const create = useMutation({
    mutationFn: () => api.post<ServerDatabaseView>(`/servers/${server.id}/databases`, { name: name.trim() }),
    onSuccess: (database) => {
      toast.success('Database created', database.name);
      if (database.password) {
        setRevealed((current) => ({ ...current, [database.id]: database.password as string }));
      }
      setCreating(false);
      setName('');
      invalidate();
    },
    onError: (error) => toast.error('Could not create database', errorMessage(error)),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => api.post<ServerDatabaseView>(`/servers/${server.id}/databases/${id}/rotate`, {}),
    onSuccess: (database) => {
      toast.success('Password rotated');
      if (database.password) {
        setRevealed((current) => ({ ...current, [database.id]: database.password as string }));
      }
      invalidate();
    },
    onError: (error) => toast.error('Could not rotate password', errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${server.id}/databases/${id}`),
    onSuccess: () => {
      toast.success('Database deleted');
      invalidate();
    },
    onError: (error) => toast.error('Delete failed', errorMessage(error)),
  });

  const reveal = async (database: ServerDatabaseView): Promise<void> => {
    if (revealed[database.id]) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[database.id];
        return next;
      });
      return;
    }
    try {
      // Fetched on demand so a password is never sitting in the list payload.
      const full = await api.get<ServerDatabaseView>(
        `/servers/${server.id}/databases/${database.id}/credentials`,
      );
      setRevealed((current) => ({ ...current, [database.id]: full.password ?? '' }));
    } catch (error) {
      toast.error('Could not read credentials', errorMessage(error));
    }
  };

  const copy = async (value: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Databases</h2>
          <p className="text-sm text-muted-foreground">
            Dedicated database accounts for this server only.
          </p>
        </div>
        {can('servers.databases.create') ? (
          <Button onClick={() => setCreating(true)} disabled={server.suspended}>
            <Plus />
            New database
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((key) => (
            <Skeleton key={key} className="h-36" />
          ))}
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid gap-3">
          {data.map((database) => {
            const password = revealed[database.id];
            return (
              <Card key={database.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Database className="h-4 w-4 shrink-0 text-primary" />
                      <h3 className="truncate font-mono font-medium">{database.name}</h3>
                      <Badge variant="secondary">
                        {database.engine === 'POSTGRES' ? 'PostgreSQL' : 'MySQL'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Created {formatDate(database.createdAt)}
                    </p>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Database actions">
                        <MoreVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void reveal(database)}>
                        {password ? <EyeOff /> : <Eye />}
                        {password ? 'Hide password' : 'Show password'}
                      </DropdownMenuItem>
                      {can('servers.databases.create') ? (
                        <DropdownMenuItem onSelect={() => rotate.mutate(database.id)}>
                          <KeyRound />
                          Rotate password
                        </DropdownMenuItem>
                      ) : null}
                      {can('servers.databases.delete') ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            destructive
                            onSelect={() => {
                              void confirm({
                                title: `Delete ${database.name}?`,
                                description:
                                  'The database and all of its data are dropped permanently. This cannot be undone.',
                                confirmLabel: 'Delete database',
                                confirmText: database.name,
                                destructive: true,
                              }).then((confirmed) => {
                                if (confirmed) remove.mutate(database.id);
                              });
                            }}
                          >
                            <Trash2 />
                            Delete
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <dl className="mt-3 grid gap-2 border-t border-border pt-3 text-sm sm:grid-cols-2">
                  <CredentialRow label="Host" value={`${database.host}:${database.port}`} onCopy={copy} />
                  <CredentialRow label="Database" value={database.name} onCopy={copy} />
                  <CredentialRow label="Username" value={database.username} onCopy={copy} />
                  <CredentialRow
                    label="Password"
                    value={password ?? '••••••••••••'}
                    onCopy={password ? copy : undefined}
                    mono
                  />
                  {database.connectionString ? (
                    <div className="sm:col-span-2">
                      <CredentialRow
                        label="Connection string"
                        value={database.connectionString}
                        onCopy={copy}
                        mono
                        truncate
                      />
                    </div>
                  ) : null}
                </dl>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={Database}
            title="No databases yet"
            description="Create one for plugins that need persistent storage."
            action={
              can('servers.databases.create') ? (
                <Button size="sm" onClick={() => setCreating(true)} disabled={server.suspended}>
                  <Plus />
                  New database
                </Button>
              ) : null
            }
          />
        </Card>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create a database</DialogTitle>
            <DialogDescription>
              A dedicated user and password are generated. The final name is prefixed with your
              server ID so it stays unique.
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" hint="Letters, numbers and underscores only." required>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="plugins"
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate()} disabled={!name.trim()} loading={create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CredentialRow({
  label,
  value,
  onCopy,
  mono,
  truncate,
}: {
  label: string;
  value: string;
  onCopy?: (value: string, label: string) => Promise<void>;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span className={`${mono ? 'font-mono text-xs' : ''} ${truncate ? 'truncate' : ''}`} title={value}>
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
