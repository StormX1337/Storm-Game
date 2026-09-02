'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
  Skeleton,
  cn,
  useToast,
} from '@storm/ui';
import type { UserDetail } from '@storm/types';
import { api, errorMessage } from '@/lib/api';

interface RoleRow {
  name: string;
  displayName: string;
  permissions: string[];
}

interface PermissionRow {
  key: string;
  category: string;
  description: string;
}

/** What an operator has decided about one permission for one account. */
type Override = 'default' | 'grant' | 'deny';

const CATEGORY_LABELS: Record<string, string> = {
  server: 'Servers',
  power: 'Power',
  console: 'Console',
  file: 'Files',
  backup: 'Backups',
  database: 'Databases',
  schedule: 'Schedules',
  network: 'Network',
  startup: 'Startup',
  subuser: 'Team',
  activity: 'Activity',
  admin: 'Administration',
  other: 'Other',
};

/**
 * Granting one account more than its role, or less.
 *
 * Both lists have been honoured by the auth layer on every request since the
 * beginning — the deny list is subtracted from the effective set — and neither
 * had any way in. The panel could not set them, the API did not accept them,
 * and the only way to take a permission off one person was to move them to a
 * different role or edit the database.
 *
 * Three states per permission rather than two checkboxes: a permission can be
 * off because the role never granted it, or off because somebody took it away,
 * and those are different facts. Two checkboxes make the second one look like
 * the first.
 */
export function UserPermissionsDialog({
  userId,
  username,
  onClose,
}: {
  userId: string;
  username: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = React.useState('');
  const [overrides, setOverrides] = React.useState<Record<string, Override> | null>(null);

  // The endpoint answers with the account alongside its servers and sessions,
  // not with the account alone. Typing it as the bare detail compiled fine and
  // crashed the dialog on open, because a type assertion is a claim rather
  // than a check.
  const user = useQuery({
    queryKey: ['admin', 'user', userId],
    queryFn: () => api.get<{ user: UserDetail }>(`/admin/users/${userId}`),
  });
  const detail = user.data?.user;

  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => api.get<RoleRow[]>('/admin/roles'),
  });

  const permissions = useQuery({
    queryKey: ['admin', 'permissions'],
    queryFn: () => api.get<PermissionRow[]>('/admin/roles/permissions'),
  });

  // Seeded once the account is loaded, then owned by the dialog: editing has
  // to survive a background refetch without discarding what was clicked.
  React.useEffect(() => {
    if (!detail || overrides !== null) return;
    const next: Record<string, Override> = {};
    for (const key of detail.extraPermissions) next[key] = 'grant';
    for (const key of detail.deniedPermissions) next[key] = 'deny';
    setOverrides(next);
  }, [detail, overrides]);

  const save = useMutation({
    mutationFn: () => {
      const entries = Object.entries(overrides ?? {});
      return api.patch(`/admin/users/${userId}`, {
        extraPermissions: entries.filter(([, state]) => state === 'grant').map(([key]) => key),
        deniedPermissions: entries.filter(([, state]) => state === 'deny').map(([key]) => key),
      });
    },
    onSuccess: () => {
      toast.success('Permissions saved', `${username} now has what you set.`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user', userId] });
      onClose();
    },
    onError: (error) => toast.error('Could not save those permissions', errorMessage(error)),
  });

  const rolePermissions = new Set(
    roles.data?.find((role) => role.name === detail?.role)?.permissions ?? [],
  );

  const term = filter.trim().toLowerCase();
  const visible = (permissions.data ?? []).filter(
    (permission) =>
      term === '' ||
      permission.key.toLowerCase().includes(term) ||
      permission.description.toLowerCase().includes(term),
  );
  const categories = [...new Set(visible.map((permission) => permission.category))];

  const loading = user.isLoading || roles.isLoading || permissions.isLoading || overrides === null;
  const changed = Object.values(overrides ?? {}).filter((state) => state !== 'default').length;

  const set = (key: string, state: Override): void =>
    setOverrides((current) => ({ ...(current ?? {}), [key]: state }));

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Permissions for {username}</DialogTitle>
          <DialogDescription>
            Everything is inherited from the account&apos;s role unless it is set here. Granted adds
            a permission the role does not have; denied removes one it does.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <Skeleton className="h-80" />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[220px] flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter permissions…"
                  aria-label="Filter permissions"
                  className="pl-9"
                />
              </div>
              <Badge variant={changed > 0 ? 'default' : 'muted'}>
                {changed} override{changed === 1 ? '' : 's'}
              </Badge>
            </div>

            <ScrollArea className="h-[24rem] rounded-lg border border-border">
              <div className="divide-y divide-border">
                {categories.map((category) => (
                  <div key={category}>
                    <p className="bg-secondary/30 px-3 py-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {CATEGORY_LABELS[category] ?? category}
                    </p>
                    {visible
                      .filter((permission) => permission.category === category)
                      .map((permission) => {
                        const state = overrides[permission.key] ?? 'default';
                        const fromRole = rolePermissions.has(permission.key);
                        const effective = state === 'grant' || (fromRole && state !== 'deny');

                        return (
                          <div
                            key={permission.key}
                            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="font-mono text-xs">{permission.key}</p>
                              <p className="text-xs text-muted-foreground">
                                {permission.description}
                                {fromRole ? ' · in this role' : ' · not in this role'}
                              </p>
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              <Badge variant={effective ? 'success' : 'muted'}>
                                {effective ? 'allowed' : 'blocked'}
                              </Badge>
                              <div className="storm-segment-track flex" role="group">
                                {(
                                  [
                                    ['default', 'Role'],
                                    ['grant', 'Grant'],
                                    ['deny', 'Deny'],
                                  ] as const
                                ).map(([value, label]) => (
                                  <button
                                    key={value}
                                    type="button"
                                    aria-pressed={state === value}
                                    aria-label={`${label} ${permission.key}`}
                                    onClick={() => set(permission.key, value)}
                                    className={cn(
                                      'storm-segment px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground',
                                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                                      state === value && value === 'deny' && 'text-destructive',
                                    )}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={loading} onClick={() => save.mutate()}>
            Save permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
