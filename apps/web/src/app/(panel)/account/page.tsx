'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { MailCheck, Save } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  useToast,
} from '@storm/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';

export default function AccountProfilePage() {
  const { user, refresh } = useAuth();
  const toast = useToast();

  const [form, setForm] = React.useState({
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
  });
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  React.useEffect(() => {
    if (!user) return;
    setForm({
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      email: user.email,
    });
  }, [user]);

  const save = useMutation({
    mutationFn: () =>
      api.patch('/account', {
        firstName: form.firstName || null,
        lastName: form.lastName || null,
        email: form.email,
      }),
    onSuccess: async () => {
      setFieldErrors({});
      toast.success('Profile updated');
      await refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details) setFieldErrors(error.details);
      toast.error('Could not save', errorMessage(error));
    },
  });

  const resend = useMutation({
    mutationFn: () => api.post('/auth/resend-verification', {}),
    onSuccess: () => toast.success('Verification email sent', 'Check your inbox.'),
    onError: (error) => toast.error('Could not send email', errorMessage(error)),
  });

  if (!user) return null;

  const dirty =
    form.firstName !== (user.firstName ?? '') ||
    form.lastName !== (user.lastName ?? '') ||
    form.email !== user.email;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>How you appear across the panel.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" error={fieldErrors.firstName}>
              <Input
                value={form.firstName}
                onChange={(event) => setForm((c) => ({ ...c, firstName: event.target.value }))}
              />
            </Field>
            <Field label="Last name" error={fieldErrors.lastName}>
              <Input
                value={form.lastName}
                onChange={(event) => setForm((c) => ({ ...c, lastName: event.target.value }))}
              />
            </Field>
          </div>

          <Field label="Email" error={fieldErrors.email} required>
            <div className="flex items-center gap-2">
              <Input
                type="email"
                value={form.email}
                onChange={(event) => setForm((c) => ({ ...c, email: event.target.value }))}
                className="flex-1"
              />
              {user.emailVerified ? (
                <Badge variant="success">Verified</Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resend.mutate()}
                  loading={resend.isPending}
                >
                  <MailCheck />
                  Verify
                </Button>
              )}
            </div>
          </Field>

          <Field label="Username" hint="Usernames cannot be changed after registration.">
            <Input value={user.username} disabled />
          </Field>

          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
              <Save />
              Save changes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <Row label="Role" value={<Badge variant="secondary">{user.role}</Badge>} />
          <Row label="Servers owned" value={String(user.serverCount)} />
          <Row
            label="Server limit"
            value={user.limits.serverLimit > 0 ? String(user.limits.serverLimit) : 'Unlimited'}
          />
          <Row label="Member since" value={formatDate(user.createdAt)} />
          <Row label="Last sign-in" value={formatDate(user.lastLoginAt)} />
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
