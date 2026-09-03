'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Laptop, Plus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useConfirm,
  useToast,
} from '@storm/ui';
import type { SessionSummary } from '@storm/types';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';

interface PermissionRow {
  key: string;
  category: string;
  description: string;
}

/** Section headings for the key scope picker, in the panel's own words. */
const PERMISSION_CATEGORIES: Record<string, string> = {
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

interface ApiKeySummary {
  id: string;
  name: string;
  keyId: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** A key past its date still shows in the list; it just stops working. */
function expired(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

export default function SecurityPage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [passwords, setPasswords] = React.useState({ current: '', next: '', confirm: '' });
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});
  const [enrolment, setEnrolment] = React.useState<{ secret: string; otpauthUrl: string } | null>(
    null,
  );
  const [backupCodes, setBackupCodes] = React.useState<string[] | null>(null);
  const [keyDialog, setKeyDialog] = React.useState(false);
  const [issuedKey, setIssuedKey] = React.useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['account', 'sessions'],
    queryFn: () => api.get<SessionSummary[]>('/account/sessions'),
  });

  const apiKeys = useQuery({
    queryKey: ['account', 'api-keys'],
    queryFn: () => api.get<ApiKeySummary[]>('/account/api-keys'),
  });

  /* ------------------------------------------------------------ password -- */

  const changePassword = useMutation({
    mutationFn: () =>
      api.post('/auth/change-password', {
        currentPassword: passwords.current,
        newPassword: passwords.next,
      }),
    onSuccess: (result: unknown) => {
      const revoked = (result as { sessionsRevoked?: number })?.sessionsRevoked ?? 0;
      setPasswords({ current: '', next: '', confirm: '' });
      setFieldErrors({});
      toast.success('Password changed', `${revoked} other session(s) were signed out.`);
      void queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details) setFieldErrors(error.details);
      toast.error('Could not change password', errorMessage(error));
    },
  });

  /* ----------------------------------------------------------------- 2FA -- */

  const beginTwoFactor = useMutation({
    mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>('/account/2fa/setup', {}),
    onSuccess: setEnrolment,
    onError: (error) => toast.error('Could not start setup', errorMessage(error)),
  });

  const disableTwoFactor = useMutation({
    mutationFn: (input: { password: string; code: string }) =>
      api.post('/account/2fa/disable', input),
    onSuccess: async () => {
      toast.success('Two-factor authentication disabled');
      await refresh();
    },
    onError: (error) => toast.error('Could not disable 2FA', errorMessage(error)),
  });

  /* -------------------------------------------------------------- sessions -- */

  const revokeSession = useMutation({
    mutationFn: (id: string) => api.delete(`/account/sessions/${id}`),
    onSuccess: () => {
      toast.success('Session signed out');
      void queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] });
    },
    onError: (error) => toast.error('Could not revoke session', errorMessage(error)),
  });

  const revokeAll = useMutation({
    mutationFn: () => api.delete<{ revoked: number }>('/account/sessions'),
    onSuccess: (result) => {
      toast.success(`Signed out of ${result.revoked} session(s)`);
      void queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] });
    },
    onError: (error) => toast.error('Could not revoke sessions', errorMessage(error)),
  });

  const revokeKey = useMutation({
    mutationFn: (id: string) => api.delete(`/account/api-keys/${id}`),
    onSuccess: () => {
      toast.success('API key revoked');
      void queryClient.invalidateQueries({ queryKey: ['account', 'api-keys'] });
    },
    onError: (error) => toast.error('Could not revoke key', errorMessage(error)),
  });

  const passwordMismatch = passwords.confirm.length > 0 && passwords.next !== passwords.confirm;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>Changing your password signs out every other device.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Current password" error={fieldErrors.currentPassword} required>
            <Input
              type="password"
              value={passwords.current}
              onChange={(event) => setPasswords((c) => ({ ...c, current: event.target.value }))}
              autoComplete="current-password"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New password" error={fieldErrors.newPassword} required>
              <Input
                type="password"
                value={passwords.next}
                onChange={(event) => setPasswords((c) => ({ ...c, next: event.target.value }))}
                autoComplete="new-password"
              />
            </Field>
            <Field
              label="Confirm new password"
              error={passwordMismatch ? 'Both passwords must match' : undefined}
              required
            >
              <Input
                type="password"
                value={passwords.confirm}
                onChange={(event) => setPasswords((c) => ({ ...c, confirm: event.target.value }))}
                autoComplete="new-password"
                aria-invalid={passwordMismatch}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => changePassword.mutate()}
              disabled={
                !passwords.current ||
                !passwords.next ||
                passwordMismatch ||
                passwords.next.length < 10
              }
              loading={changePassword.isPending}
            >
              <KeyRound />
              Change password
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              Two-factor authentication
              {user?.twoFactorEnabled ? <Badge variant="success">Enabled</Badge> : null}
            </CardTitle>
            <CardDescription>
              Require a time-based code from your authenticator app at sign-in.
            </CardDescription>
          </div>
          {user?.twoFactorEnabled ? (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => {
                void confirm({
                  title: 'Disable two-factor authentication?',
                  description: 'Your account will be protected by a password alone.',
                  confirmLabel: 'Disable',
                  destructive: true,
                }).then((confirmed) => {
                  if (!confirmed) return;
                  const password = window.prompt('Confirm your password');
                  const code = password
                    ? window.prompt('Enter a current 2FA or backup code')
                    : null;
                  if (password && code) disableTwoFactor.mutate({ password, code });
                });
              }}
            >
              <ShieldOff />
              Disable
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => beginTwoFactor.mutate()}
              loading={beginTwoFactor.isPending}
            >
              <ShieldCheck />
              Enable
            </Button>
          )}
        </CardHeader>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>Devices currently signed in to your account.</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => revokeAll.mutate()}
            loading={revokeAll.isPending}
          >
            Sign out everywhere else
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {sessions.data?.map((session) => (
            <div
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate font-medium">
                    {session.deviceLabel ?? 'Unknown device'}
                    {session.current ? <Badge variant="success">This device</Badge> : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {session.ip ?? 'unknown IP'} · last used {formatRelative(session.lastUsedAt)}
                  </p>
                </div>
              </div>
              {!session.current ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive"
                  onClick={() => revokeSession.mutate(session.id)}
                  aria-label="Revoke session"
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ))}
          {sessions.data?.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No active sessions.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>API keys</CardTitle>
            <CardDescription>
              Use these with the REST API. A key can never exceed your own permissions.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setKeyDialog(true)}>
            <Plus />
            New key
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {apiKeys.data?.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{key.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  storm_{key.keyId}… · created {formatDate(key.createdAt)}
                  {key.lastUsedAt
                    ? ` · last used ${formatRelative(key.lastUsedAt)}`
                    : ' · never used'}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {/* What the key can do is the thing worth seeing at a glance:
                      a key that can do everything should not look like one
                      that can read a server list. */}
                  <Badge variant={key.permissions.length === 0 ? 'warning' : 'secondary'}>
                    {key.permissions.length === 0
                      ? 'Full access'
                      : `${key.permissions.length} permission${key.permissions.length === 1 ? '' : 's'}`}
                  </Badge>
                  {key.expiresAt ? (
                    <Badge variant={expired(key.expiresAt) ? 'destructive' : 'muted'}>
                      {expired(key.expiresAt)
                        ? `Expired ${formatRelative(key.expiresAt)}`
                        : `Expires ${formatDate(key.expiresAt)}`}
                    </Badge>
                  ) : (
                    <Badge variant="muted">Never expires</Badge>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-destructive"
                onClick={() => revokeKey.mutate(key.id)}
                aria-label="Revoke key"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {apiKeys.data?.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No API keys yet.</p>
          ) : null}
        </CardContent>
      </Card>

      {enrolment ? (
        <TwoFactorDialog
          enrolment={enrolment}
          onClose={() => setEnrolment(null)}
          onEnabled={async (codes) => {
            setEnrolment(null);
            setBackupCodes(codes);
            await refresh();
          }}
        />
      ) : null}

      {backupCodes ? (
        <BackupCodesDialog codes={backupCodes} onClose={() => setBackupCodes(null)} />
      ) : null}

      {keyDialog ? (
        <CreateKeyDialog
          onClose={() => setKeyDialog(false)}
          onCreated={(token) => {
            setKeyDialog(false);
            setIssuedKey(token);
            void queryClient.invalidateQueries({ queryKey: ['account', 'api-keys'] });
          }}
        />
      ) : null}

      {issuedKey ? <IssuedKeyDialog token={issuedKey} onClose={() => setIssuedKey(null)} /> : null}
    </div>
  );
}

function TwoFactorDialog({
  enrolment,
  onClose,
  onEnabled,
}: {
  enrolment: { secret: string; otpauthUrl: string };
  onClose: () => void;
  onEnabled: (codes: string[]) => Promise<void>;
}) {
  const toast = useToast();
  const [code, setCode] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [qr, setQr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    // Loaded on demand: the encoder is only ever needed by this one dialog, so
    // it has no business in the bundle every page pays for.
    void import('qrcode')
      .then((module) =>
        module.default.toDataURL(enrolment.otpauthUrl, {
          margin: 0,
          width: 352,
          errorCorrectionLevel: 'M',
        }),
      )
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        // The setup key below is a complete fallback, so a failure here is not
        // worth interrupting the flow for.
        if (!cancelled) setQr(null);
      });

    return () => {
      cancelled = true;
    };
  }, [enrolment.otpauthUrl]);

  const enable = useMutation({
    mutationFn: () =>
      api.post<{ backupCodes: string[] }>('/account/2fa/enable', { code, password }),
    onSuccess: (result) => void onEnabled(result.backupCodes),
    onError: (error) => toast.error('Could not enable 2FA', errorMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set up two-factor authentication</DialogTitle>
          <DialogDescription>
            Scan the code with your authenticator app, then confirm with the code it shows.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-secondary/40 p-4">
            {qr ? (
              // Rendered from the otpauth URI the panel issued, in the browser:
              // the secret is already on this page, so drawing it here avoids
              // sending it anywhere else.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt="QR code containing this account's two-factor setup key"
                className="h-44 w-44 rounded bg-white p-2"
                width={176}
                height={176}
              />
            ) : (
              <div className="h-44 w-44 animate-pulse rounded bg-muted" />
            )}
            <p className="text-center text-xs text-muted-foreground">
              Scan this with your authenticator app, or enter the key by hand.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-secondary/40 p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">Setup key</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(enrolment.secret)
                    .then(() => toast.success('Copied', 'The setup key is on your clipboard.'))
                    .catch(() =>
                      toast.error('Could not copy', 'Select the key and copy it by hand.'),
                    );
                }}
              >
                Copy
              </Button>
            </div>
            <code className="block break-all font-mono text-sm">{enrolment.secret}</code>
          </div>

          <Field label="Password" required>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>

          <Field label="Authenticator code" required>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              inputMode="numeric"
              className="font-mono tracking-[0.3em]"
              autoFocus
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => enable.mutate()}
            disabled={code.length !== 6 || !password}
            loading={enable.isPending}
          >
            Enable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackupCodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const toast = useToast();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save your backup codes</DialogTitle>
          <DialogDescription>
            Each code works once if you lose your authenticator. This is the only time they are
            shown.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-secondary/40 p-3 font-mono text-sm">
          {codes.map((code) => (
            <span key={code}>{code}</span>
          ))}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard
                .writeText(codes.join('\n'))
                .then(() => toast.success('Backup codes copied'))
                .catch(() => toast.error('Could not copy'));
            }}
          >
            <Copy />
            Copy codes
          </Button>
          <Button onClick={onClose}>I have saved them</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Making a key that can do less than you can, and that stops working.
 *
 * The API has taken a permission list and an expiry since the beginning — the
 * auth layer narrows a key to its list on every request — and this dialog only
 * ever asked for a name. So every key the panel could produce carried its
 * owner's entire authority, for an administrator that is the whole panel, and
 * never expired. The deployment script, the Discord bot and the uptime check
 * all held the same key you sign in with.
 *
 * Full access stays possible, because it is what most keys honestly need. It
 * is a choice you make rather than the shape of a form you did not fill in.
 */
function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = React.useState('');
  const [scoped, setScoped] = React.useState(false);
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [expiresInDays, setExpiresInDays] = React.useState('never');

  // Only what this account holds: a key can never exceed its owner, so
  // offering the whole catalogue would be offering things silently dropped.
  const available = useQuery({
    queryKey: ['account', 'permissions'],
    queryFn: () => api.get<PermissionRow[]>('/account/permissions'),
  });

  const categories = [...new Set((available.data ?? []).map((row) => row.category))];

  const create = useMutation({
    mutationFn: () =>
      api.post<{ token: string }>('/account/api-keys', {
        name: name.trim(),
        permissions: scoped ? [...chosen] : [],
        ...(expiresInDays === 'never' ? {} : { expiresInDays: Number(expiresInDays) }),
      }),
    onSuccess: (result) => onCreated(result.token),
    onError: (error) => toast.error('Could not create key', errorMessage(error)),
  });

  const toggle = (key: string): void =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // An empty list means full access on the wire, so "limited to nothing" would
  // quietly be the most powerful key of all.
  const incomplete = !name.trim() || (scoped && chosen.size === 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create an API key</DialogTitle>
          <DialogDescription>
            A key can never do more than you can. It is shown once.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name" required>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Deployment script"
              autoFocus
            />
          </Field>

          <Field label="Expires">
            <Select value={expiresInDays} onValueChange={setExpiresInDays}>
              <SelectTrigger aria-label="Expires">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">In 30 days</SelectItem>
                <SelectItem value="90">In 90 days</SelectItem>
                <SelectItem value="365">In a year</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <div className="storm-segment-track flex" role="group" aria-label="Key access">
            {(
              [
                [false, 'Everything you can do'],
                [true, 'Only what I pick'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={scoped === value}
                onClick={() => setScoped(value)}
                className="storm-segment flex-1 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {label}
              </button>
            ))}
          </div>

          {scoped ? (
            <ScrollArea className="h-64 rounded-lg border border-border">
              <div className="divide-y divide-border">
                {categories.map((category) => (
                  <div key={category}>
                    <p className="bg-secondary/30 px-3 py-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {PERMISSION_CATEGORIES[category] ?? category}
                    </p>
                    {(available.data ?? [])
                      .filter((row) => row.category === category)
                      .map((row) => (
                        <label
                          key={row.key}
                          className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-secondary/30"
                        >
                          <Checkbox
                            checked={chosen.has(row.key)}
                            onCheckedChange={() => toggle(row.key)}
                            aria-label={row.key}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="block font-mono text-xs">{row.key}</span>
                            <span className="block text-xs text-muted-foreground">
                              {row.description}
                            </span>
                          </span>
                        </label>
                      ))}
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <p className="text-xs text-muted-foreground">
              Anything you can do in the panel, this key can do through the API. Pick the second
              option if it is going into a script, a bot, or anywhere you would not paste your
              password.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={incomplete} loading={create.isPending}>
            {scoped ? `Create key (${chosen.size})` : 'Create key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IssuedKeyDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const toast = useToast();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Your new API key</DialogTitle>
          <DialogDescription>
            Copy it now — it is stored hashed and cannot be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border bg-secondary/40 p-3">
          <code className="block break-all font-mono text-xs">{token}</code>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard
                .writeText(token)
                .then(() => toast.success('API key copied'))
                .catch(() => toast.error('Could not copy'));
            }}
          >
            <Copy />
            Copy
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
