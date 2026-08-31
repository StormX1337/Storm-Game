'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { Button, Field, Input, useToast } from '@storm/ui';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/** Length is the only strength signal worth showing; the rest is theatre. */
function strengthOf(password: string): { score: number; label: string; tone: string } {
  let score = 0;
  if (password.length >= 10) score += 1;
  if (password.length >= 14) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) || /[^\w\s]/.test(password)) score += 1;

  if (password.length === 0) return { score: 0, label: '', tone: 'bg-border' };
  if (score <= 1) return { score: 1, label: 'Weak', tone: 'bg-destructive' };
  if (score === 2) return { score: 2, label: 'Fair', tone: 'bg-warning' };
  if (score === 3) return { score: 3, label: 'Good', tone: 'bg-primary' };
  return { score: 4, label: 'Strong', tone: 'bg-success' };
}

export default function RegisterPage() {
  const router = useRouter();
  const toast = useToast();
  const { refresh } = useAuth();

  const [form, setForm] = React.useState({
    email: '',
    username: '',
    firstName: '',
    lastName: '',
    password: '',
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  const strength = strengthOf(form.password);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const response = await api.post<{ emailVerificationRequired: boolean }>('/auth/register', {
        email: form.email,
        username: form.username,
        password: form.password,
        ...(form.firstName ? { firstName: form.firstName } : {}),
        ...(form.lastName ? { lastName: form.lastName } : {}),
      });

      await refresh();

      if (response.emailVerificationRequired) {
        toast.info('Check your inbox', 'Confirm your email address to unlock every feature.');
      } else {
        toast.success('Account created', 'Welcome to Storm Panel.');
      }
      router.replace('/dashboard');
    } catch (caught) {
      if (caught instanceof ApiError) {
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
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-sm text-muted-foreground">
          Deploy your first server in a couple of minutes.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" error={fieldErrors.firstName}>
            <Input value={form.firstName} onChange={set('firstName')} autoComplete="given-name" />
          </Field>
          <Field label="Last name" error={fieldErrors.lastName}>
            <Input value={form.lastName} onChange={set('lastName')} autoComplete="family-name" />
          </Field>
        </div>

        <Field label="Email" error={fieldErrors.email} required>
          <Input
            type="email"
            value={form.email}
            onChange={set('email')}
            placeholder="you@example.com"
            autoComplete="email"
            required
            aria-invalid={Boolean(fieldErrors.email)}
          />
        </Field>

        <Field
          label="Username"
          hint="Letters, numbers, dots, dashes and underscores."
          error={fieldErrors.username}
          required
        >
          <Input
            value={form.username}
            onChange={set('username')}
            placeholder="stormrider"
            autoComplete="username"
            required
            aria-invalid={Boolean(fieldErrors.username)}
          />
        </Field>

        <Field label="Password" error={fieldErrors.password} required>
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            placeholder="At least 10 characters"
            autoComplete="new-password"
            required
            aria-invalid={Boolean(fieldErrors.password)}
          />
          {form.password ? (
            <div className="flex items-center gap-2 pt-1.5">
              <div className="flex h-1 flex-1 gap-1">
                {[1, 2, 3, 4].map((step) => (
                  <div
                    key={step}
                    className={`h-full flex-1 rounded-full transition-colors ${
                      step <= strength.score ? strength.tone : 'bg-border'
                    }`}
                  />
                ))}
              </div>
              <span className="w-12 text-right text-xs text-muted-foreground">
                {strength.label}
              </span>
            </div>
          ) : null}
        </Field>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        <Button type="submit" className="w-full" loading={submitting} size="lg">
          <UserPlus />
          Create account
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
