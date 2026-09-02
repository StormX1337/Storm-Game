'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, Minus, Search, ShieldCheck } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  ScrollArea,
  Skeleton,
  cn,
} from '@storm/ui';
import { api } from '@/lib/api';

interface RoleRow {
  id: string;
  name: string;
  displayName: string;
  description: string;
  isSystem: boolean;
  userCount: number;
  permissions: string[];
  missing: string[];
  unexpected: string[];
}

interface PermissionRow {
  key: string;
  category: string;
  description: string;
}

/** Reads better than the raw key, and the keys are grouped by these. */
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
 * Who can do what.
 *
 * Five roles and forty-odd permissions have been enforced on every request
 * since the first version of the panel, and none of it was visible anywhere.
 * The question an operator actually has — "can I give this person the audit
 * log without making them an administrator?" — could only be answered by
 * reading the source or opening the database.
 *
 * The grants come from the database rather than from the seed's own table, so
 * this shows what is really enforced. Where the two differ it says so: a
 * deployment that never re-ran the seed after a permission was added is short
 * of it, and the symptom is a role that quietly cannot do a thing it should.
 */
export default function AdminRolesPage() {
  const [filter, setFilter] = React.useState('');

  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => api.get<RoleRow[]>('/admin/roles'),
  });

  const permissions = useQuery({
    queryKey: ['admin', 'permissions'],
    queryFn: () => api.get<PermissionRow[]>('/admin/roles/permissions'),
  });

  const term = filter.trim().toLowerCase();
  const visible = (permissions.data ?? []).filter(
    (permission) =>
      term === '' ||
      permission.key.toLowerCase().includes(term) ||
      permission.description.toLowerCase().includes(term),
  );

  const categories = [...new Set(visible.map((permission) => permission.category))];
  const drifted = (roles.data ?? []).filter(
    (role) => role.missing.length > 0 || role.unexpected.length > 0,
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Roles</h1>
        <p className="text-sm text-muted-foreground">
          What each role grants, read from the database that enforces it.
        </p>
      </div>

      {drifted.length > 0 ? (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-warning">
              <AlertTriangle className="h-4 w-4" />
              {drifted.length} role{drifted.length === 1 ? '' : 's'} differ from the seed
            </CardTitle>
            <CardDescription>
              Missing grants are what re-running <code className="font-mono">pnpm db:seed</code>{' '}
              would add — usually a permission introduced by an update that the deployment never
              seeded. Unexpected ones were granted by hand and no update will remove them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {drifted.map((role) => (
              <div key={role.id} className="space-y-1.5 text-sm">
                <p className="font-medium">{role.displayName}</p>
                {role.missing.length > 0 ? (
                  <p className="text-muted-foreground">
                    Missing: <span className="font-mono text-xs">{role.missing.join(', ')}</span>
                  </p>
                ) : null}
                {role.unexpected.length > 0 ? (
                  <p className="text-muted-foreground">
                    Unexpected:{' '}
                    <span className="font-mono text-xs">{role.unexpected.join(', ')}</span>
                  </p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {roles.isLoading
          ? [0, 1, 2].map((key) => <Skeleton key={key} className="h-28" />)
          : roles.data?.map((role) => (
              <Card key={role.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold">{role.displayName}</p>
                    <p className="font-mono text-xs text-muted-foreground">{role.name}</p>
                  </div>
                  <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{role.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge variant="secondary">
                    {role.userCount} account{role.userCount === 1 ? '' : 's'}
                  </Badge>
                  <Badge variant="secondary">{role.permissions.length} permissions</Badge>
                  {role.isSystem ? <Badge variant="muted">built in</Badge> : null}
                </div>
              </Card>
            ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Permission matrix</CardTitle>
          <CardDescription>
            A tick is a grant this role holds in the database. Individual accounts can be given more
            or fewer than their role on the Users page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter permissions…"
              aria-label="Filter permissions"
              className="pl-9"
            />
          </div>

          {permissions.isLoading || roles.isLoading ? (
            <Skeleton className="h-64" />
          ) : visible.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="No permission matches that filter" />
          ) : (
            <ScrollArea className="w-full">
              <table className="w-full min-w-[640px] caption-bottom text-sm">
                <thead className="bg-surface-sunken/60 [&_tr]:border-b [&_tr]:border-border">
                  <tr>
                    <th
                      scope="col"
                      className="h-10 px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      Permission
                    </th>
                    {roles.data?.map((role) => (
                      <th
                        key={role.id}
                        scope="col"
                        className="h-10 px-3 text-center align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {role.displayName}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {categories.map((category) => (
                    <React.Fragment key={category}>
                      <tr className="border-b border-border">
                        <td
                          colSpan={(roles.data?.length ?? 0) + 1}
                          className="bg-secondary/30 px-3 py-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                        >
                          {CATEGORY_LABELS[category] ?? category}
                        </td>
                      </tr>
                      {visible
                        .filter((permission) => permission.category === category)
                        .map((permission) => (
                          <tr
                            key={permission.key}
                            className="border-b border-border transition-colors last:border-0 hover:bg-secondary/25"
                          >
                            <td className="px-3 py-2 align-middle">
                              <p className="font-mono text-xs">{permission.key}</p>
                              <p className="text-xs text-muted-foreground">
                                {permission.description}
                              </p>
                            </td>
                            {roles.data?.map((role) => {
                              const held = role.permissions.includes(permission.key);
                              return (
                                <td key={role.id} className="px-3 py-2 text-center align-middle">
                                  {/* The label carries the answer, because a
                                      tick with no accessible name is a cell a
                                      screen reader reads as empty. */}
                                  <span
                                    className={cn(
                                      'inline-flex h-5 w-5 items-center justify-center rounded-md',
                                      held
                                        ? 'bg-success/15 text-success'
                                        : 'bg-secondary/60 text-muted-foreground',
                                    )}
                                    aria-label={`${role.displayName} ${held ? 'has' : 'does not have'} ${permission.key}`}
                                    role="img"
                                  >
                                    {held ? (
                                      <Check className="h-3.5 w-3.5" />
                                    ) : (
                                      <Minus className="h-3 w-3" />
                                    )}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
