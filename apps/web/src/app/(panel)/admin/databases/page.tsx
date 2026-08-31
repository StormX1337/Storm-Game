'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, MoreVertical, Plug, Plus, Trash2 } from 'lucide-react';
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
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';

interface DatabaseHostRow {
  id: string;
  name: string;
  engine: 'POSTGRES' | 'MYSQL';
  host: string;
  publicHost: string | null;
  port: number;
  username: string;
  maxDatabases: number;
  databaseCount: number;
  node: { id: string; name: string } | null;
  isActive: boolean;
  createdAt: string;
}

export default function AdminDatabaseHostsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [creating, setCreating] = React.useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'database-hosts'],
    queryFn: () => api.get<DatabaseHostRow[]>('/admin/database-hosts'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'database-hosts'] });
  };

  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; version?: string; error?: string }>(
        `/admin/database-hosts/${id}/test`,
        {},
      ),
    onSuccess: (result) => {
      if (result.ok) toast.success('Connection successful', result.version?.slice(0, 80));
      else toast.error('Connection failed', result.error);
    },
    onError: (error) => toast.error('Test failed', errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/database-hosts/${id}`),
    onSuccess: () => {
      toast.success('Database host removed');
      invalidate();
    },
    onError: (error) => toast.error('Could not remove host', errorMessage(error)),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Database hosts</h1>
          <p className="text-sm text-muted-foreground">
            Servers where customer databases are provisioned.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          Add host
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid gap-3">
          {data.map((host) => (
            <Card key={host.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    <Database className="h-4 w-4 shrink-0 text-primary" />
                    {host.name}
                    <Badge variant="secondary">
                      {host.engine === 'POSTGRES' ? 'PostgreSQL' : 'MySQL'}
                    </Badge>
                    {host.isActive ? null : <Badge variant="muted">Inactive</Badge>}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {host.host}:{host.port} · user {host.username}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {host.databaseCount} database{host.databaseCount === 1 ? '' : 's'}
                    {host.maxDatabases > 0 ? ` of ${host.maxDatabases}` : ''}
                    {host.node ? ` · pinned to ${host.node.name}` : ' · available to all nodes'} ·
                    added {formatDate(host.createdAt)}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => test.mutate(host.id)}
                    loading={test.isPending}
                  >
                    <Plug />
                    Test
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Host actions">
                        <MoreVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        destructive
                        disabled={host.databaseCount > 0}
                        onSelect={() => {
                          void confirm({
                            title: `Remove ${host.name}?`,
                            description:
                              'The host is removed from the panel. Existing databases must be deleted first.',
                            confirmLabel: 'Remove',
                            destructive: true,
                          }).then((confirmed) => {
                            if (confirmed) remove.mutate(host.id);
                          });
                        }}
                      >
                        <Trash2 />
                        Remove host
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={Database}
            title="No database hosts"
            description="Add a MySQL or PostgreSQL server so customers can create databases."
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus />
                Add host
              </Button>
            }
          />
        </Card>
      )}

      {creating ? (
        <CreateHostDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            invalidate();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateHostDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = React.useState({
    name: '',
    engine: 'MYSQL' as 'MYSQL' | 'POSTGRES',
    host: '',
    publicHost: '',
    port: 3306,
    username: 'root',
    password: '',
    maxDatabases: 0,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ connection: { ok: boolean; error?: string } }>('/admin/database-hosts', {
        ...form,
        publicHost: form.publicHost || undefined,
      }),
    onSuccess: (result) => {
      if (result.connection.ok) {
        toast.success('Database host added', 'The panel connected successfully.');
      } else {
        toast.warning('Host saved but unreachable', result.connection.error);
      }
      onCreated();
    },
    onError: (error) => toast.error('Could not add host', errorMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a database host</DialogTitle>
          <DialogDescription>
            The panel needs an account with permission to create databases and users.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required>
              <Input
                value={form.name}
                onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
                placeholder="MySQL cluster 1"
                autoFocus
              />
            </Field>
            <Field label="Engine" required>
              <select
                value={form.engine}
                onChange={(event) =>
                  setForm((c) => ({
                    ...c,
                    engine: event.target.value as 'MYSQL' | 'POSTGRES',
                    port: event.target.value === 'POSTGRES' ? 5432 : 3306,
                  }))
                }
                className="flex h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="MYSQL">MySQL / MariaDB</option>
                <option value="POSTGRES">PostgreSQL</option>
              </select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="Host" hint="Address the panel connects to" required>
              <Input
                value={form.host}
                onChange={(event) => setForm((c) => ({ ...c, host: event.target.value }))}
                placeholder="10.0.0.20"
              />
            </Field>
            <Field label="Port" required>
              <Input
                type="number"
                value={form.port}
                onChange={(event) =>
                  setForm((c) => ({ ...c, port: Number(event.target.value) || 0 }))
                }
                className="w-24"
              />
            </Field>
          </div>

          <Field
            label="Public host"
            hint="Optional. Shown to customers if it differs from the internal address."
          >
            <Input
              value={form.publicHost}
              onChange={(event) => setForm((c) => ({ ...c, publicHost: event.target.value }))}
              placeholder="db.example.com"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username" required>
              <Input
                value={form.username}
                onChange={(event) => setForm((c) => ({ ...c, username: event.target.value }))}
              />
            </Field>
            <Field label="Password" required>
              <Input
                type="password"
                value={form.password}
                onChange={(event) => setForm((c) => ({ ...c, password: event.target.value }))}
              />
            </Field>
          </div>

          <Field label="Maximum databases" hint="Zero means unlimited.">
            <Input
              type="number"
              value={form.maxDatabases}
              onChange={(event) =>
                setForm((c) => ({ ...c, maxDatabases: Number(event.target.value) || 0 }))
              }
              className="max-w-[160px]"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!form.name || !form.host || !form.username || !form.password}
            loading={create.isPending}
          >
            Add host
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
