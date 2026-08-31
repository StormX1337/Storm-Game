'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, HardDrive, MoreVertical, Plus, Star, Trash2 } from 'lucide-react';
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

interface StorageRow {
  id: string;
  name: string;
  driver: 'LOCAL' | 'S3' | 'R2' | 'MINIO';
  isDefault: boolean;
  bucket: string | null;
  region: string | null;
  endpoint: string | null;
  pathPrefix: string;
  retentionDays: number;
  isActive: boolean;
  backupCount: number;
  hasCredentials: boolean;
  createdAt: string;
}

const DRIVER_LABEL: Record<StorageRow['driver'], string> = {
  LOCAL: 'Local disk',
  S3: 'Amazon S3',
  R2: 'Cloudflare R2',
  MINIO: 'MinIO',
};

export default function AdminBackupStoragePage() {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [creating, setCreating] = React.useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'backup-storages'],
    queryFn: () => api.get<StorageRow[]>('/admin/backup-storages'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'backup-storages'] });
  };

  const setDefault = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/backup-storages/${id}`, { isDefault: true }),
    onSuccess: () => {
      toast.success('Default storage updated');
      invalidate();
    },
    onError: (error) => toast.error('Could not update storage', errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/backup-storages/${id}`),
    onSuccess: () => {
      toast.success('Storage removed');
      invalidate();
    },
    onError: (error) => toast.error('Could not remove storage', errorMessage(error)),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Backup storage</h1>
          <p className="text-sm text-muted-foreground">
            Where server archives are written. Object storage receives them directly from the node.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          Add storage
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid gap-3">
          {data.map((storage) => (
            <Card key={storage.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {storage.driver === 'LOCAL' ? (
                      <HardDrive className="h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <Cloud className="h-4 w-4 shrink-0 text-primary" />
                    )}
                    {storage.name}
                    <Badge variant="secondary">{DRIVER_LABEL[storage.driver]}</Badge>
                    {storage.isDefault ? <Badge variant="default">Default</Badge> : null}
                    {storage.isActive ? null : <Badge variant="muted">Inactive</Badge>}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {storage.driver === 'LOCAL'
                      ? `Node-local · prefix ${storage.pathPrefix}`
                      : `${storage.bucket}${storage.region ? ` · ${storage.region}` : ''} · prefix ${storage.pathPrefix}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {storage.backupCount} archive{storage.backupCount === 1 ? '' : 's'} ·{' '}
                    {storage.retentionDays > 0
                      ? `${storage.retentionDays} day retention`
                      : 'no automatic pruning'}{' '}
                    · added {formatDate(storage.createdAt)}
                  </p>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Storage actions">
                      <MoreVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={storage.isDefault}
                      onSelect={() => setDefault.mutate(storage.id)}
                    >
                      <Star />
                      Make default
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      destructive
                      disabled={storage.backupCount > 0}
                      onSelect={() => {
                        void confirm({
                          title: `Remove ${storage.name}?`,
                          description:
                            'Backups stored here must be deleted first. The archives themselves are not touched.',
                          confirmLabel: 'Remove',
                          destructive: true,
                        }).then((confirmed) => {
                          if (confirmed) remove.mutate(storage.id);
                        });
                      }}
                    >
                      <Trash2 />
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={HardDrive} title="No backup storage configured" />
        </Card>
      )}

      {creating ? (
        <CreateStorageDialog
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

function CreateStorageDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState({
    name: '',
    driver: 'S3' as StorageRow['driver'],
    bucket: '',
    region: 'auto',
    endpoint: '',
    accessKey: '',
    secretKey: '',
    pathPrefix: 'backups',
    retentionDays: 30,
    isDefault: false,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/admin/backup-storages', {
        ...form,
        bucket: form.driver === 'LOCAL' ? undefined : form.bucket,
        endpoint: form.endpoint || undefined,
        accessKey: form.driver === 'LOCAL' ? undefined : form.accessKey,
        secretKey: form.driver === 'LOCAL' ? undefined : form.secretKey,
      }),
    onSuccess: () => {
      toast.success('Backup storage added');
      onCreated();
    },
    onError: (error) => toast.error('Could not add storage', errorMessage(error)),
  });

  const isObjectStore = form.driver !== 'LOCAL';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add backup storage</DialogTitle>
          <DialogDescription>
            Credentials are encrypted at rest and used to sign short-lived upload URLs.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required>
              <Input
                value={form.name}
                onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
                placeholder="Primary S3"
                autoFocus
              />
            </Field>
            <Field label="Driver" required>
              <select
                value={form.driver}
                onChange={(event) =>
                  setForm((c) => ({ ...c, driver: event.target.value as StorageRow['driver'] }))
                }
                className="flex h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="S3">Amazon S3</option>
                <option value="R2">Cloudflare R2</option>
                <option value="MINIO">MinIO</option>
                <option value="LOCAL">Local disk on node</option>
              </select>
            </Field>
          </div>

          {isObjectStore ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Bucket" required>
                  <Input
                    value={form.bucket}
                    onChange={(event) => setForm((c) => ({ ...c, bucket: event.target.value }))}
                  />
                </Field>
                <Field label="Region">
                  <Input
                    value={form.region}
                    onChange={(event) => setForm((c) => ({ ...c, region: event.target.value }))}
                  />
                </Field>
              </div>

              <Field label="Endpoint" hint="Required for R2 and MinIO; leave blank for Amazon S3.">
                <Input
                  value={form.endpoint}
                  onChange={(event) => setForm((c) => ({ ...c, endpoint: event.target.value }))}
                  placeholder="https://<account>.r2.cloudflarestorage.com"
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Access key" required>
                  <Input
                    value={form.accessKey}
                    onChange={(event) => setForm((c) => ({ ...c, accessKey: event.target.value }))}
                  />
                </Field>
                <Field label="Secret key" required>
                  <Input
                    type="password"
                    value={form.secretKey}
                    onChange={(event) => setForm((c) => ({ ...c, secretKey: event.target.value }))}
                  />
                </Field>
              </div>
            </>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Path prefix">
              <Input
                value={form.pathPrefix}
                onChange={(event) => setForm((c) => ({ ...c, pathPrefix: event.target.value }))}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Retention (days)" hint="Zero disables pruning.">
              <Input
                type="number"
                value={form.retentionDays}
                onChange={(event) =>
                  setForm((c) => ({ ...c, retentionDays: Number(event.target.value) || 0 }))
                }
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(event) => setForm((c) => ({ ...c, isDefault: event.target.checked }))}
              className="h-4 w-4 rounded border-input"
            />
            Use as the default for new backups
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={
              !form.name || (isObjectStore && (!form.bucket || !form.accessKey || !form.secretKey))
            }
            loading={create.isPending}
          >
            Add storage
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
