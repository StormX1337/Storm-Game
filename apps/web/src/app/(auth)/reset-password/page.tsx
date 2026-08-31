'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { Button, Field, Input, useToast } from '@storm/ui';
import { ApiError, api } from '@/lib/api';

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const token = params.get('token') ?? '';

  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  const mismatch = confirmation.length > 0 && password !== confirmation;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch) return;

    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.post('/auth/reset-password', { token, password });
      toast.success('Password updated', 'Sign in with your new password.');
      router.replace('/login');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        if (caught.details) setFieldErrors(caught.details);
      } else {
        setError('Could not reach the panel. Try again shortly.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Link is incomplete</h1>
          <p className="text-sm text-muted-foreground">
            This reset link is missing its token. Request a new one to continue.
          </p>
        </div>
        <Button className="w-full" asChild>
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="text-sm text-muted-foreground">
          Every active session will be signed out once you save.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="New password" error={fieldErrors.password} required>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 10 characters"
            autoComplete="new-password"
            autoFocus
            required
          />
        </Field>

        <Field
          label="Confirm password"
          error={mismatch ? 'Both passwords must match' : undefined}
          required
        >
          <Input
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            aria-invalid={mismatch}
            required
          />
        </Field>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        <Button type="submit" className="w-full" loading={submitting} size="lg" disabled={mismatch}>
          <KeyRound />
          Update password
        </Button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <React.Suspense fallback={<div className="h-64" />}>
      <ResetForm />
    </React.Suspense>
  );
}
