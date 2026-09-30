'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Card, Checkbox, Field, Input, NativeSelect } from '@storm-bet/ui';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  type ForgotPasswordInput,
  type LoginInput,
  type RegisterInput,
  type ResetPasswordInput,
} from '@storm-bet/validation';
import { CheckCircle2, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';
import { ApiError, api, errorMessage } from '@/lib/api-client';
import { safeNext } from '@/lib/safe-next';
import { useT } from '@/i18n/client';

function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
): string | null {
  if (error instanceof ApiError) {
    const fields = Object.entries(error.fields);
    for (const [field, message] of fields) setError(field as Path<T>, { message });
    return fields.length ? null : error.message;
  }
  return errorMessage(error);
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-down/30 bg-down-soft px-3 py-2 text-sm text-down"
      data-testid="form-error"
    >
      {message}
    </p>
  );
}

export function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setFormError] = useState<string | null>(null);
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const [challenge, setChallenge] = useState<string | null>(null);
  const done = () => {
    router.replace(safeNext(params.get('next')));
    router.refresh();
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const res = await api<{ twoFactorRequired?: boolean; challenge?: string }>('/auth/login', {
        body: values,
      });
      if (res.twoFactorRequired && res.challenge) setChallenge(res.challenge);
      else done();
    } catch (e) {
      setFormError(applyServerErrors(e, form.setError));
    }
  });

  if (challenge) {
    return (
      <TwoFactorStep
        challenge={challenge}
        onDone={done}
        onRestart={() => {
          setChallenge(null);
          form.setValue('password', '');
        }}
      />
    );
  }

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold">{t('Anmelden')}</h1>
      <p className="mt-1 text-sm text-fg-muted">{t('Willkommen zurück bei STORM BET.')}</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <FormError message={error} />
        <Field label={t('E-Mail-Adresse')} htmlFor="email" error={t(errors.email?.message)}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            invalid={!!errors.email}
            {...form.register('email')}
          />
        </Field>
        <Field label={t('Passwort')} htmlFor="password" error={t(errors.password?.message)}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            invalid={!!errors.password}
            {...form.register('password')}
          />
        </Field>
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-xs text-accent hover:underline">
            {t('Passwort vergessen?')}
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={isSubmitting} data-testid="login-submit">
          {t('Anmelden')}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-fg-muted">
        {t('Noch kein Konto?')}{' '}
        <Link href="/register" className="text-accent hover:underline">
          {t('Jetzt registrieren')}
        </Link>
      </p>
    </Card>
  );
}

/** Second login step: the code from the authenticator app or a recovery code. */
function TwoFactorStep({
  challenge,
  onDone,
  onRestart,
}: {
  challenge: string;
  onDone: () => void;
  onRestart: () => void;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/auth/login/2fa', { body: { challenge, code: code.trim() } });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold">{t('Bestätigungscode')}</h1>
      <p className="mt-1 text-sm text-fg-muted">
        {t(
          'Gib den 6-stelligen Code aus deiner Authenticator-App ein – oder einen deiner Wiederherstellungscodes.',
        )}
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <FormError message={error} />
        <Field label={t('Code')} htmlFor="otp">
          <Input
            id="otp"
            autoComplete="one-time-code"
            inputMode="text"
            autoFocus
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="tabular text-center text-lg tracking-[0.3em]"
            data-testid="otp-input"
          />
        </Field>
        <Button
          type="submit"
          className="w-full"
          loading={busy}
          disabled={code.trim().length < 6}
          data-testid="otp-submit"
        >
          {t('Bestätigen')}
        </Button>
      </form>
      <button
        type="button"
        onClick={onRestart}
        className="mt-4 w-full text-center text-xs text-fg-muted hover:text-fg"
      >
        {t('Zurück zur Anmeldung')}
      </button>
    </Card>
  );
}

const COUNTRIES = [
  { code: 'DE', name: 'Deutschland' },
  { code: 'AT', name: 'Österreich' },
  { code: 'CH', name: 'Schweiz' },
  { code: 'LU', name: 'Luxemburg' },
  { code: 'NL', name: 'Niederlande' },
];

export function RegisterForm() {
  const t = useT();
  const router = useRouter();
  const [error, setFormError] = useState<string | null>(null);
  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', password: '', displayName: '', country: 'DE' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api('/auth/register', { body: values });
      router.replace('/dashboard?welcome=1');
      router.refresh();
    } catch (e) {
      setFormError(applyServerErrors(e, form.setError));
    }
  });

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold">{t('Konto erstellen')}</h1>
      <p className="mt-1 text-sm text-fg-muted">
        {t('Mit 1.000 € Spielgeld-Startguthaben – kostenlos und ohne Echtgeld.')}
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <FormError message={error} />
        <Field label={t('E-Mail-Adresse')} htmlFor="email" error={t(errors.email?.message)}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            invalid={!!errors.email}
            {...form.register('email')}
          />
        </Field>
        <Field
          label={t('Anzeigename')}
          htmlFor="displayName"
          error={t(errors.displayName?.message)}
        >
          <Input
            id="displayName"
            autoComplete="nickname"
            invalid={!!errors.displayName}
            {...form.register('displayName')}
          />
        </Field>
        <Field
          label={t('Passwort')}
          htmlFor="password"
          error={t(errors.password?.message)}
          hint={t('Mindestens 10 Zeichen, mit Buchstaben und Ziffern.')}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            invalid={!!errors.password}
            {...form.register('password')}
          />
        </Field>
        <Field label={t('Land')} htmlFor="country" error={t(errors.country?.message)}>
          <NativeSelect id="country" {...form.register('country')}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {t(c.name)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="space-y-2.5 pt-1">
          <Checkbox
            {...form.register('ageConfirmed')}
            label={t('Ich bin mindestens 18 Jahre alt.')}
            data-testid="age-confirm"
          />
          {errors.ageConfirmed ? (
            <p className="text-xs text-down">{t(errors.ageConfirmed.message)}</p>
          ) : null}
          <Checkbox
            {...form.register('termsAccepted')}
            data-testid="terms-accept"
            label={
              <>
                {t('Ich akzeptiere die')}{' '}
                <Link href="/terms" className="text-accent hover:underline">
                  {t('Nutzungsbedingungen')}
                </Link>{' '}
                {t('und habe die')}{' '}
                <Link href="/privacy" className="text-accent hover:underline">
                  {t('Datenschutzhinweise')}
                </Link>{' '}
                gelesen.
              </>
            }
          />
          {errors.termsAccepted ? (
            <p className="text-xs text-down">{t(errors.termsAccepted.message)}</p>
          ) : null}
        </div>
        <Button
          type="submit"
          className="w-full"
          loading={isSubmitting}
          data-testid="register-submit"
        >
          {t('Registrieren')}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-fg-muted">
        {t('Bereits registriert?')}{' '}
        <Link href="/login" className="text-accent hover:underline">
          {t('Anmelden')}
        </Link>
      </p>
    </Card>
  );
}

export function ForgotPasswordForm() {
  const t = useT();
  const [sent, setSent] = useState(false);
  const [error, setFormError] = useState<string | null>(null);
  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api('/auth/forgot-password', { body: values });
      setSent(true);
    } catch (e) {
      setFormError(applyServerErrors(e, form.setError));
    }
  });
  if (sent) {
    return (
      <Card className="p-6 text-center">
        <MailCheck className="mx-auto size-8 text-accent" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold">{t('E-Mail unterwegs')}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          {t(
            'Falls ein Konto mit dieser Adresse existiert, haben wir dir einen Link zum Zurücksetzen gesendet. Er ist 30 Minuten gültig.',
          )}
        </p>
        <Button variant="outline" className="mt-5 w-full" asChild>
          <Link href="/login">{t('Zurück zur Anmeldung')}</Link>
        </Button>
      </Card>
    );
  }
  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold">{t('Passwort vergessen')}</h1>
      <p className="mt-1 text-sm text-fg-muted">
        {t('Wir senden dir einen Link zum Zurücksetzen.')}
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <FormError message={error} />
        <Field label={t('E-Mail-Adresse')} htmlFor="email" error={t(errors.email?.message)}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            invalid={!!errors.email}
            {...form.register('email')}
          />
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          {t('Link senden')}
        </Button>
      </form>
    </Card>
  );
}

export function ResetPasswordForm() {
  const t = useT();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setFormError] = useState<string | null>(null);
  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, password: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api('/auth/reset-password', { body: values });
      setDone(true);
    } catch (e) {
      setFormError(applyServerErrors(e, form.setError));
    }
  });
  if (done) {
    return (
      <Card className="p-6 text-center">
        <CheckCircle2 className="mx-auto size-8 text-up" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold">{t('Passwort geändert')}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          {t(
            'Aus Sicherheitsgründen wurden alle Sitzungen beendet. Melde dich mit dem neuen Passwort an.',
          )}
        </p>
        <Button className="mt-5 w-full" asChild>
          <Link href="/login">{t('Anmelden')}</Link>
        </Button>
      </Card>
    );
  }
  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold">{t('Neues Passwort festlegen')}</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <FormError
          message={
            error ??
            (errors.token ? t('Der Link ist unvollständig. Bitte fordere einen neuen an.') : null)
          }
        />
        <Field
          label={t('Neues Passwort')}
          htmlFor="password"
          error={t(errors.password?.message)}
          hint={t('Mindestens 10 Zeichen, mit Buchstaben und Ziffern.')}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            invalid={!!errors.password}
            {...form.register('password')}
          />
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          {t('Passwort speichern')}
        </Button>
      </form>
    </Card>
  );
}

export function VerifyEmail() {
  const t = useT();
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'pending' | 'ok' | 'error'>('pending');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!token) {
      setState('error');
      setMessage(t('Der Bestätigungslink ist unvollständig.'));
      return;
    }
    api('/auth/verify-email', { body: { token } })
      .then(() => setState('ok'))
      .catch((e: unknown) => {
        setState('error');
        setMessage(errorMessage(e));
      });
  }, [token, t]);
  return (
    <Card className="p-6 text-center">
      {state === 'pending' ? (
        <p className="text-sm text-fg-muted">{t('E-Mail-Adresse wird bestätigt …')}</p>
      ) : null}
      {state === 'ok' ? (
        <>
          <CheckCircle2 className="mx-auto size-8 text-up" aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold">{t('E-Mail-Adresse bestätigt')}</h1>
          <Button className="mt-5 w-full" asChild>
            <Link href="/dashboard">{t('Zum Konto')}</Link>
          </Button>
        </>
      ) : null}
      {state === 'error' ? (
        <>
          <h1 className="text-lg font-semibold">{t('Bestätigung fehlgeschlagen')}</h1>
          <p className="mt-2 text-sm text-fg-muted">{message}</p>
          <Button variant="outline" className="mt-5 w-full" asChild>
            <Link href="/dashboard/profile">{t('Neuen Link anfordern')}</Link>
          </Button>
        </>
      ) : null}
    </Card>
  );
}
