'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Check,
  KeyRound,
  MoreVertical,
  Plus,
  Search,
  ShieldOff,
  Trash2,
  UserCheck,
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
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import type { RoleName, UserSummary } from '@storm/types';
import { ApiError, api, apiPaginated, errorMessage } from '@/lib/api';
import { formatDate, formatRelative, initials } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';

interface UserRow extends UserSummary {
  serverCount: number;
}

const ROLES: RoleName[] = ['OWNER', 'ADMIN', 'STAFF', 'SUPPORT', 'CUSTOMER'];

const ROLE_VARIANT: Record<RoleName, 'default' | 'secondary' | 'success' | 'warning' | 'muted'> = {
  OWNER: 'warning',
  ADMIN: 'default',
  STAFF: 'success',
  SUPPORT: 'secondary',
  CUSTOMER: 'muted',
};

export default function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [role, setRole] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const [creating, setCreating] = React.useState(false);
  const perPage = 25;

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', debounced, role, page],
    queryFn: () =>
      apiPaginated<UserRow>('/admin/users', {
        query: {
          page,
          perPage,
          search: debounced || undefined,
          role: role === 'all' ? undefined : role,
        },
      }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  };

  const suspend = useMutation({
    mutationFn: (input: { id: string; suspend: boolean }) =>
      api.post(`/admin/users/${input.id}/${input.suspend ? 'suspend' : 'unsuspend'}`, {}),
    onSuccess: (_data, input) => {
      toast.success(input.suspend ? 'User suspended' : 'User restored');
      invalidate();
    },
    onError: (error) => toast.error('Could not update user', errorMessage(error)),
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post<{ password: string }>(`/admin/users/${id}/reset-password`, {}),
    onSuccess: (result) => {
      toast.success('Password reset', `Temporary password: ${result.password}`);
    },
    onError: (error) => toast.error('Could not reset password', errorMessage(error)),
  });

  const disable2fa = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/disable-2fa`, {}),
    onSuccess: () => {
      toast.success('Two-factor authentication removed');
      invalidate();
    },
    onError: (error) => toast.error('Could not remove 2FA', errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: () => {
      toast.success('User deleted');
      invalidate();
    },
    onError: (error) => toast.error('Could not delete user', errorMessage(error)),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${data.meta.total} account${data.meta.total === 1 ? '' : 's'}` : 'Loading…'}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          Create user
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, username or email…"
            className="pl-9"
          />
        </div>
        <Select
          value={role}
          onValueChange={(value) => {
            setRole(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            {ROLES.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((key) => (
              <Skeleton key={key} className="h-12" />
            ))}
          </div>
        ) : data && data.items.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="w-28">Role</TableHead>
                <TableHead className="w-24">Servers</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-40">Last sign-in</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-2xs font-semibold">
                        {initials(`${row.firstName ?? ''} ${row.lastName ?? row.username}`)}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {[row.firstName, row.lastName].filter(Boolean).join(' ') || row.username}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.email}
                        </span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={ROLE_VARIANT[row.role]}>{row.role}</Badge>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">{row.serverCount}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.suspended ? (
                        <Badge variant="destructive">Suspended</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                      {row.twoFactorEnabled ? <Badge variant="secondary">2FA</Badge> : null}
                      {!row.emailVerified ? <Badge variant="warning">Unverified</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="block text-sm">{formatRelative(row.lastLoginAt)}</span>
                    <span className="block text-xs text-muted-foreground">
                      joined {formatDate(row.createdAt)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="User actions">
                          <MoreVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() =>
                            suspend.mutate({ id: row.id, suspend: !row.suspended })
                          }
                          disabled={row.id === currentUser?.id}
                        >
                          {row.suspended ? <UserCheck /> : <Ban />}
                          {row.suspended ? 'Restore access' : 'Suspend'}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => resetPassword.mutate(row.id)}>
                          <KeyRound />
                          Reset password
                        </DropdownMenuItem>
                        {row.twoFactorEnabled ? (
                          <DropdownMenuItem onSelect={() => disable2fa.mutate(row.id)}>
                            <ShieldOff />
                            Remove 2FA
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          destructive
                          disabled={row.id === currentUser?.id || row.serverCount > 0}
                          onSelect={() => {
                            void confirm({
                              title: `Delete ${row.username}?`,
                              description:
                                'The account is removed permanently. Servers must be transferred or deleted first.',
                              confirmLabel: 'Delete user',
                              confirmText: row.username,
                              destructive: true,
                            }).then((confirmed) => {
                              if (confirmed) remove.mutate(row.id);
                            });
                          }}
                        >
                          <Trash2 />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            icon={Search}
            title="No users match"
            description="Try a different search term or role filter."
          />
        )}
      </Card>

      {data ? (
        <Pagination page={page} perPage={perPage} total={data.meta.total} onPageChange={setPage} />
      ) : null}

      {creating ? (
        <CreateUserDialog
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

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState({
    email: '',
    username: '',
    firstName: '',
    lastName: '',
    password: '',
    role: 'CUSTOMER' as RoleName,
    emailVerified: true,
  });
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  const create = useMutation({
    mutationFn: () =>
      api.post<{ generatedPassword?: string }>('/admin/users', {
        email: form.email,
        username: form.username,
        role: form.role,
        emailVerified: form.emailVerified,
        ...(form.firstName ? { firstName: form.firstName } : {}),
        ...(form.lastName ? { lastName: form.lastName } : {}),
        ...(form.password ? { password: form.password } : {}),
      }),
    onSuccess: (result) => {
      toast.success(
        'User created',
        result.generatedPassword
          ? `Temporary password: ${result.generatedPassword}`
          : 'They can sign in with the password you set.',
      );
      onCreated();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details) setFieldErrors(error.details);
      toast.error('Could not create user', errorMessage(error));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a user</DialogTitle>
          <DialogDescription>
            Leave the password blank to generate a temporary one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name">
              <Input
                value={form.firstName}
                onChange={(event) => setForm((c) => ({ ...c, firstName: event.target.value }))}
              />
            </Field>
            <Field label="Last name">
              <Input
                value={form.lastName}
                onChange={(event) => setForm((c) => ({ ...c, lastName: event.target.value }))}
              />
            </Field>
          </div>

          <Field label="Email" error={fieldErrors.email} required>
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm((c) => ({ ...c, email: event.target.value }))}
              autoFocus
            />
          </Field>

          <Field label="Username" error={fieldErrors.username} required>
            <Input
              value={form.username}
              onChange={(event) => setForm((c) => ({ ...c, username: event.target.value }))}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role" required>
              <Select
                value={form.role}
                onValueChange={(value) => setForm((c) => ({ ...c, role: value as RoleName }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {entry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Password" hint="Optional" error={fieldErrors.password}>
              <Input
                type="password"
                value={form.password}
                onChange={(event) => setForm((c) => ({ ...c, password: event.target.value }))}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.emailVerified}
              onChange={(event) => setForm((c) => ({ ...c, emailVerified: event.target.checked }))}
              className="h-4 w-4 rounded border-input"
            />
            Mark email address as verified
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!form.email || !form.username}
            loading={create.isPending}
          >
            <Check />
            Create user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
