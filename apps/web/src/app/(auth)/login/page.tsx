'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Button, Checkbox, Field, Input, Label, useToast } from '@storm/ui';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { refresh } = useAuth();

  const [identifier, setIdentifier] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [totp, setTotp] = React.useState('');
  const [rememberMe, setRememberMe] = React.useState(true);
  const [needsTotp, setNeedsTotp] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  const next = params.get('next') ?? '/dashboard';

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await api.post('/auth/login', {
        identifier,
        password,
        rememberMe,
        ...(totp ? { totp } : {}),
      });

      await refresh();
      toast.success('Signed in', 'Welcome back to Storm Panel.');
      router.replace(next.startsWith('/') ? next : '/dashboard');
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.code === 'TWO_FACTOR_REQUIRED') {
          // Keep the credentials on screen and reveal the code field rather
          // than making the user retype everything.
          setNeedsTotp(true);
          setError(null);
          setSubmitting(false);
          return;
        }
        setError(caught.message);
        if (caught.details) setFieldErrors(caught.details);
      } else {
        setError('Could not reach the panel. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Enter your credentials to reach your servers.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email or username" error={fieldErrors.identifier} required>
          <Input
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
            autoFocus
            required
            aria-invalid={Boolean(fieldErrors.identifier)}
          />
        </Field>

        <Field label="Password" error={fieldErrors.password} required>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••••"
            autoComplete="current-password"
            required
            aria-invalid={Boolean(fieldErrors.password)}
          />
        </Field>

        {needsTotp ? (
          <Field
            label="Two-factor code"
            hint="Enter the 6-digit code from your authenticator, or a backup code."
            error={fieldErrors.totp}
            required
            htmlFor="totp-code"
          >
            <div className="relative">
              <ShieldCheck className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="totp-code"
                value={totp}
                onChange={(event) => setTotp(event.target.value)}
                placeholder="123456"
                inputMode="text"
                autoComplete="one-time-code"
                className="pl-9 font-mono tracking-[0.3em]"
                autoFocus
                required
              />
            </div>
          </Field>
        ) : null}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Checkbox
              id="remember"
              checked={rememberMe}
              onCheckedChange={(checked) => setRememberMe(checked === true)}
            />
            <Label
              htmlFor="remember"
              className="cursor-pointer text-sm font-normal text-muted-foreground"
            >
              Stay signed in
            </Label>
          </div>
          <Link
            href="/forgot-password"
            className="text-sm font-medium text-primary hover:underline"
          >
            Forgot password?
          </Link>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        <Button type="submit" className="w-full" loading={submitting} size="lg">
          <KeyRound />
          Sign in
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Need an account?{' '}
        <Link href="/register" className="font-medium text-primary hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}

/**
 * `useSearchParams` opts a page out of static prerendering unless it sits
 * inside a Suspense boundary, so the form is wrapped rather than forcing the
 * whole route to be dynamic.
 */
export default function LoginPage() {
  return (
    <React.Suspense fallback={<div className="h-80" />}>
      <LoginForm />
    </React.Suspense>
  );
}
