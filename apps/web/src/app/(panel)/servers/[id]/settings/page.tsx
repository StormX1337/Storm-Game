'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, Save, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  useConfirm,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

export default function ServerSettingsPage() {
  const { server, can, status } = useServer();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [name, setName] = React.useState(server.name);
  const [description, setDescription] = React.useState(server.description ?? '');

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

  const setAutoRestart = useMutation({
    mutationFn: (autoRestart: boolean) => api.patch(`/servers/${server.id}`, { autoRestart }),
    onSuccess: (_data, autoRestart) => {
      void queryClient.invalidateQueries({ queryKey: ['server', server.id] });
      toast.success(
        autoRestart ? 'Automatic restart is on' : 'Automatic restart is off',
        autoRestart
          ? 'The panel will bring this server back after a crash.'
          : 'A crash will leave the server stopped.',
      );
    },
    onError: (error) => toast.error('Could not change that', errorMessage(error)),
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
                !name.trim() || (name === server.name && description === (server.description ?? ''))
              }
            >
              <Save />
              Save changes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>After a crash</CardTitle>
          <CardDescription>What happens when the server stops on its own.</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={server.autoRestart}
              // Not gated here, for the same reason the name field is not: the
              // API allows a server's owner as well as anyone holding
              // servers.update, and the context only knows the second. Mirroring
              // half the rule would lock owners out of their own server.
              disabled={setAutoRestart.isPending}
              onChange={(event) => setAutoRestart.mutate(event.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium">Start it again automatically</span>
              <span className="mt-1 block text-muted-foreground">
                A server that crashes three times without staying up for a minute is left alone, so
                one that cannot start does not restart forever. Starting it yourself clears that.
                Running out of memory is never retried — it would only happen again, and the fix is
                a setting.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

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
