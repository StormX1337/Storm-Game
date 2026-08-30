'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Download,
  HardDrive,
  Lock,
  MoreVertical,
  Plus,
  RotateCcw,
  Trash2,
  Unlock,
} from 'lucide-react';
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
  Progress,
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
import type { BackupStatus, BackupSummary } from '@storm/types';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDate, formatRelative } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

const STATUS_VARIANT: Record<BackupStatus, 'success' | 'warning' | 'destructive' | 'muted' | 'default'> = {
  COMPLETED: 'success',
  PENDING: 'muted',
  RUNNING: 'warning',
  RESTORING: 'warning',
  DELETING: 'muted',
  FAILED: 'destructive',
};

interface BackupsPayload {
  items: BackupSummary[];
  limit: number;
  used: number;
}

export default function BackupsPage() {
  const { server, can, status } = useServer();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [ignored, setIgnored] = React.useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['server', server.shortId, 'backups'],
    queryFn: () => api.get<BackupsPayload>(`/servers/${server.id}/backups`),
    // A backup in flight resolves within minutes; poll only while one is active.
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((backup) => backup.status === 'RUNNING' || backup.status === 'PENDING')
        ? 5_000
        : false;
    },
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'backups'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.post(`/servers/${server.id}/backups`, {
        name: name.trim() || undefined,
        ignoredFiles: ignored
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      toast.success('Backup started', 'It will appear as completed once the node finishes.');
      setCreating(false);
      setName('');
      setIgnored('');
      invalidate();
    },
    onError: (error) => toast.error('Could not start backup', errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${server.id}/backups/${id}`),
    onSuccess: () => {
      toast.success('Backup deleted');
      invalidate();
    },
    onError: (error) => toast.error('Delete failed', errorMessage(error)),
  });

  const restore = useMutation({
    mutationFn: (input: { id: string; truncate: boolean }) =>
      api.post(`/servers/${server.id}/backups/${input.id}/restore`, { truncate: input.truncate }),
    onSuccess: () => {
      toast.success('Restore started', 'Files are being written back to the server.');
      invalidate();
    },
    onError: (error) => toast.error('Restore failed', errorMessage(error)),
  });

  const toggleLock = useMutation({
    mutationFn: (input: { id: string; locked: boolean }) =>
      api.patch(`/servers/${server.id}/backups/${input.id}`, { isLocked: input.locked }),
    onSuccess: invalidate,
    onError: (error) => toast.error('Could not update backup', errorMessage(error)),
  });

  const download = async (backup: BackupSummary): Promise<void> => {
    try {
      const response = await api.get<{ url?: string }>(
        `/servers/${server.id}/backups/${backup.id}/download`,
      );
      // Object storage returns a signed URL; local archives stream from here.
      const url =
        response && typeof response === 'object' && 'url' in response && response.url
          ? response.url
          : `/api/v1/servers/${server.id}/backups/${backup.id}/download`;
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      toast.error('Download failed', errorMessage(error));
    }
  };

  const askRestore = async (backup: BackupSummary): Promise<void> => {
    if (status !== 'OFFLINE' && status !== 'CRASHED') {
      toast.warning('Stop the server first', 'A restore rewrites files the server has open.');
      return;
    }
    const confirmed = await confirm({
      title: `Restore "${backup.name}"?`,
      description:
        'Files in the backup overwrite the current ones. Anything created since this backup and not included in it stays in place.',
      confirmLabel: 'Restore',
      destructive: true,
    });
    if (confirmed) restore.mutate({ id: backup.id, truncate: false });
  };

  const askDelete = async (backup: BackupSummary): Promise<void> => {
    const confirmed = await confirm({
      title: `Delete "${backup.name}"?`,
      description: 'The archive is removed permanently and cannot be recovered.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (confirmed) remove.mutate(backup.id);
  };

  const backups = data?.items ?? [];
  const limit = data?.limit ?? 0;
  const atLimit = limit > 0 && backups.length >= limit;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Backups</h2>
          <p className="text-sm text-muted-foreground">
            {limit > 0
              ? `${backups.length} of ${limit} backup slots used`
              : `${backups.length} backups stored`}
          </p>
        </div>
        {can('servers.backups.create') ? (
          <Button onClick={() => setCreating(true)} disabled={atLimit || server.suspended}>
            <Plus />
            Create backup
          </Button>
        ) : null}
      </div>

      {limit > 0 ? (
        <Progress
          value={(backups.length / limit) * 100}
          indicatorClassName={atLimit ? 'bg-warning' : 'bg-primary'}
        />
      ) : null}

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-12" />
            ))}
          </div>
        ) : backups.length === 0 ? (
          <EmptyState
            icon={Archive}
            title="No backups yet"
            description="Create a backup before making risky changes, or schedule them automatically."
            action={
              can('servers.backups.create') ? (
                <Button size="sm" onClick={() => setCreating(true)} disabled={server.suspended}>
                  <Plus />
                  Create backup
                </Button>
              ) : null
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-28">Size</TableHead>
                <TableHead className="w-44">Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((backup) => (
                <TableRow key={backup.id}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {backup.isLocked ? (
                        <Lock className="h-3.5 w-3.5 shrink-0 text-warning" />
                      ) : (
                        <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{backup.name}</span>
                        {backup.error ? (
                          <span className="block truncate text-xs text-destructive">
                            {backup.error}
                          </span>
                        ) : backup.checksum ? (
                          <span className="block truncate font-mono text-2xs text-muted-foreground">
                            sha256:{backup.checksum.slice(0, 16)}…
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[backup.status]}>
                      {backup.status.toLowerCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {backup.bytes > 0 ? formatBytes(backup.bytes) : '—'}
                  </TableCell>
                  <TableCell>
                    <span className="block text-sm">{formatRelative(backup.createdAt)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatDate(backup.completedAt ?? backup.createdAt)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Backup actions">
                          <MoreVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={backup.status !== 'COMPLETED'}
                          onSelect={() => void download(backup)}
                        >
                          <Download />
                          Download
                        </DropdownMenuItem>
                        {can('servers.backups.restore') ? (
                          <DropdownMenuItem
                            disabled={backup.status !== 'COMPLETED'}
                            onSelect={() => void askRestore(backup)}
                          >
                            <RotateCcw />
                            Restore
                          </DropdownMenuItem>
                        ) : null}
                        {can('servers.backups.create') ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              toggleLock.mutate({ id: backup.id, locked: !backup.isLocked })
                            }
                          >
                            {backup.isLocked ? <Unlock /> : <Lock />}
                            {backup.isLocked ? 'Unlock' : 'Lock'}
                          </DropdownMenuItem>
                        ) : null}
                        {can('servers.backups.delete') ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              destructive
                              disabled={backup.isLocked || backup.status === 'RUNNING'}
                              onSelect={() => void askDelete(backup)}
                            >
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a backup</DialogTitle>
            <DialogDescription>
              The whole server directory is archived. Large worlds can take several minutes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Field label="Name" hint="Leave blank to use the current date and time.">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Before 1.21 update"
              />
            </Field>
            <Field
              label="Ignored files"
              hint="One pattern per line, e.g. cache/** or *.log. These are left out of the archive."
            >
              <textarea
                value={ignored}
                onChange={(event) => setIgnored(event.target.value)}
                rows={4}
                placeholder={'cache/**\n*.log'}
                className="flex w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate()} loading={create.isPending}>
              Start backup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
