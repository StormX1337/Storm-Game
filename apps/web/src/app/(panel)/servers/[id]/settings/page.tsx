'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, Save, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  useConfirm,
  useToast,
} from '@storm/ui';
import { CUSTOMER_PERMISSIONS } from '@storm/types';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

interface Subuser {
  id: string;
  userId: string;
  username: string;
  email: string;
  permissions: string[];
  createdAt: string;
}

export default function ServerSettingsPage() {
  const { server, can, status } = useServer();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [name, setName] = React.useState(server.name);
  const [description, setDescription] = React.useState(server.description ?? '');
  const [inviteOpen, setInviteOpen] = React.useState(false);

  const canManageSubusers = can('servers.subusers') && !server.suspended;

  const subusers = useQuery({
    queryKey: ['server', server.shortId, 'subusers'],
    queryFn: () => api.get<Subuser[]>(`/servers/${server.id}/subusers`),
    enabled: canManageSubusers,
  });

  const rename = useMutation({
    mutationFn: () =>
      api.patch(`/servers/${server.id}`, { name: name.trim(), description: description || null }),
    onSuccess: () => {
      toast.success('Server updated');
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId] });
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (error) => toast.error('Could not save', errorMessage(error)),
  });

  const reinstall = useMutation({
    mutationFn: (wipe: boolean) => api.post(`/servers/${server.id}/reinstall`, { wipe }),
    onSuccess: () => {
      toast.success('Reinstall queued', 'The server will be unavailable while it runs.');
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId] });
    },
    onError: (error) => toast.error('Could not reinstall', errorMessage(error)),
  });

  const destroy = useMutation({
    mutationFn: () => api.delete(`/servers/${server.id}`),
    onSuccess: () => {
      toast.success('Server deleted');
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      router.push('/servers');
    },
    onError: (error) => toast.error('Could not delete the server', errorMessage(error)),
  });

  const removeSubuser = useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${server.id}/subusers/${id}`),
    onSuccess: () => {
      toast.success('Access removed');
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'subusers'] });
    },
    onError: (error) => toast.error('Could not remove access', errorMessage(error)),
  });

  const askReinstall = async (): Promise<void> => {
    const confirmed = await confirm({
      title: 'Reinstall this server?',
      description:
        'The install script runs again against the current template. Server files are kept, but files the installer overwrites will be replaced.',
      confirmLabel: 'Reinstall',
      destructive: true,
    });
    if (confirmed) reinstall.mutate(false);
  };

  const askWipe = async (): Promise<void> => {
    const confirmed = await confirm({
      title: 'Wipe and reinstall?',
      description:
        'Every file in the server directory is deleted before reinstalling. Worlds, configuration and plugins are lost unless you have a backup.',
      confirmLabel: 'Wipe and reinstall',
      confirmText: server.name,
      destructive: true,
    });
    if (confirmed) reinstall.mutate(true);
  };

  const askDelete = async (): Promise<void> => {
    const confirmed = await confirm({
      title: 'Delete this server permanently?',
      description:
        'The container, all files, databases and backups are destroyed. This cannot be undone.',
      confirmLabel: 'Delete server',
      confirmText: server.name,
      destructive: true,
    });
    if (confirmed) destroy.mutate();
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Server details</CardTitle>
          <CardDescription>How this server is labelled in the panel.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Name" required>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Description" hint="Optional note shown to anyone with access.">
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button
              onClick={() => rename.mutate()}
              loading={rename.isPending}
              disabled={
                !name.trim() ||
                (name === server.name && description === (server.description ?? ''))
              }
            >
              <Save />
              Save changes
            </Button>
          </div>
        </CardContent>
      </Card>

      {canManageSubusers ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Shared access</CardTitle>
              <CardDescription>
                Give someone else scoped access without handing over your account.
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus />
              Add user
            </Button>
          </CardHeader>
          <CardContent>
            {subusers.data && subusers.data.length > 0 ? (
              <div className="space-y-2">
                {subusers.data.map((subuser) => (
                  <div
                    key={subuser.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{subuser.username}</p>
                      <p className="truncate text-xs text-muted-foreground">{subuser.email}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {subuser.permissions.slice(0, 5).map((permission) => (
                          <Badge key={permission} variant="secondary" className="text-2xs">
                            {permission.replace('servers.', '')}
                          </Badge>
                        ))}
                        {subuser.permissions.length > 5 ? (
                          <Badge variant="muted" className="text-2xs">
                            +{subuser.permissions.length - 5}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive"
                      aria-label="Remove access"
                      onClick={() => removeSubuser.mutate(subuser.id)}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Users className="h-4 w-4" />
                Nobody else has access to this server.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Danger zone
          </CardTitle>
          <CardDescription>These actions are disruptive and cannot be undone.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {can('servers.reinstall') ? (
            <>
              <DangerRow
                title="Reinstall server"
                description="Run the install script again, keeping existing files where the installer does not overwrite them."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void askReinstall()}
                    disabled={status === 'INSTALLING' || status === 'REINSTALLING'}
                    loading={reinstall.isPending}
                  >
                    <RefreshCw />
                    Reinstall
                  </Button>
                }
              />
              <DangerRow
                title="Wipe and reinstall"
                description="Delete every file first, then reinstall from scratch."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => void askWipe()}
                    disabled={status === 'INSTALLING' || status === 'REINSTALLING'}
                  >
                    <Trash2 />
                    Wipe
                  </Button>
                }
              />
            </>
          ) : null}

          <DangerRow
            title="Delete server"
            description="Destroy the container, files, databases and backups permanently."
            action={
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void askDelete()}
                loading={destroy.isPending}
              >
                <Trash2 />
                Delete
              </Button>
            }
          />
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        Server created {formatDate(server.createdAt)} · UUID {server.uuid}
      </p>

      {inviteOpen ? (
        <InviteDialog
          serverId={server.id}
          available={server.permissions}
          onClose={() => setInviteOpen(false)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'subusers'] });
            setInviteOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function DangerRow({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

function InviteDialog({
  serverId,
  available,
  onClose,
  onSaved,
}: {
  serverId: string;
  available: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = React.useState('');
  const [permissions, setPermissions] = React.useState<Set<string>>(
    () => new Set(['servers.view', 'servers.console']),
  );

  // Only offer permissions the inviter actually holds — the API enforces this
  // too, but showing the real set avoids a confusing rejection.
  const grantable = CUSTOMER_PERMISSIONS.filter((permission) => available.includes(permission));

  const invite = useMutation({
    mutationFn: () =>
      api.post(`/servers/${serverId}/subusers`, {
        email: email.trim(),
        permissions: [...permissions],
      }),
    onSuccess: () => {
      toast.success('Access granted');
      onSaved();
    },
    onError: (error) => toast.error('Could not grant access', errorMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share this server</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Email address" hint="They must already have a Storm Panel account." required>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="teammate@example.com"
              autoFocus
            />
          </Field>

          <div className="space-y-2">
            <Label>Permissions</Label>
            <div className="grid max-h-64 gap-1.5 overflow-y-auto rounded-lg border border-border p-3 sm:grid-cols-2">
              {grantable.map((permission) => (
                <label key={permission} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={permissions.has(permission)}
                    onCheckedChange={(checked) =>
                      setPermissions((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(permission);
                        else next.delete(permission);
                        return next;
                      })
                    }
                  />
                  <span className="font-mono text-xs">{permission.replace('servers.', '')}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => invite.mutate()}
            disabled={!email.trim() || permissions.size === 0}
            loading={invite.isPending}
          >
            Grant access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
