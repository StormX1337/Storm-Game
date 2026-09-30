'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import type {
  LimitDto,
  LimitType,
  ProfileDto,
  SelfExclusionDto,
  SessionInfoDto,
} from '@storm-bet/types';
import { LIMIT_TYPES } from '@storm-bet/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Field,
  Input,
  NativeSelect,
  toast,
} from '@storm-bet/ui';
import {
  changePasswordSchema,
  updateProfileSchema,
  type ChangePasswordInput,
  type SelfExclusionPeriod,
  type UpdateProfileInput,
} from '@storm-bet/validation';
import { Laptop, LogOut, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError, api, errorMessage } from '@/lib/api-client';
import { formatDateTime, formatMoney, formatRelative, parseStake, stakeInput } from '@/lib/format';
import { LIMIT_LABELS } from '@/lib/labels';

export function ProfileForm({ profile }: { profile: ProfileDto }) {
  const router = useRouter();
  const form = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: { displayName: profile.displayName, country: profile.country ?? undefined },
  });
  const { errors, isSubmitting, isDirty } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await api('/account/profile', { method: 'PATCH', body: values });
      toast.success('Profil gespeichert');
      form.reset(values);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError)
        for (const [k, v] of Object.entries(e.fields))
          form.setError(k as keyof UpdateProfileInput, { message: v });
      toast.error(errorMessage(e));
    }
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Persönliche Angaben</CardTitle>
          <CardDescription>Dein Anzeigename erscheint nur in deinem Konto.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field
            label="E-Mail-Adresse"
            htmlFor="email"
            hint={profile.emailVerified ? 'Bestätigt' : 'Noch nicht bestätigt'}
          >
            <Input id="email" value={profile.email} disabled readOnly />
          </Field>
          <Field label="Anzeigename" htmlFor="displayName" error={errors.displayName?.message}>
            <Input
              id="displayName"
              invalid={!!errors.displayName}
              {...form.register('displayName')}
            />
          </Field>
          <Field label="Land" htmlFor="country" error={errors.country?.message}>
            <NativeSelect id="country" {...form.register('country')}>
              {[
                ['DE', 'Deutschland'],
                ['AT', 'Österreich'],
                ['CH', 'Schweiz'],
                ['LU', 'Luxemburg'],
                ['NL', 'Niederlande'],
              ].map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            label="Identitätsprüfung (KYC)"
            htmlFor="kyc"
            hint="Nur für einen künftigen Echtgeldbetrieb erforderlich."
          >
            <Input
              id="kyc"
              value={
                profile.kycStatus === 'NOT_REQUIRED'
                  ? 'Nicht erforderlich (Demo)'
                  : profile.kycStatus
              }
              disabled
              readOnly
            />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
              Speichern
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function ChangePasswordForm() {
  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const result = await api<{ otherSessionsRevoked: number }>('/auth/change-password', {
        body: values,
      });
      toast.success(
        result.otherSessionsRevoked
          ? `Passwort geändert · ${result.otherSessionsRevoked} andere Sitzung(en) beendet`
          : 'Passwort geändert',
      );
      form.reset();
    } catch (e) {
      if (e instanceof ApiError)
        for (const [k, v] of Object.entries(e.fields))
          form.setError(k as keyof ChangePasswordInput, { message: v });
      else toast.error(errorMessage(e));
    }
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Passwort ändern</CardTitle>
          <CardDescription>Andere angemeldete Geräte werden dabei abgemeldet.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field
            label="Aktuelles Passwort"
            htmlFor="currentPassword"
            error={errors.currentPassword?.message}
          >
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              invalid={!!errors.currentPassword}
              {...form.register('currentPassword')}
            />
          </Field>
          <Field label="Neues Passwort" htmlFor="newPassword" error={errors.newPassword?.message}>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              invalid={!!errors.newPassword}
              {...form.register('newPassword')}
            />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" loading={isSubmitting}>
              Passwort ändern
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function SessionsList({ sessions }: { sessions: SessionInfoDto[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(message);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Aktive Sitzungen</CardTitle>
          <CardDescription>Geräte, auf denen du angemeldet bist.</CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          loading={busy === 'others'}
          disabled={sessions.length < 2}
          onClick={() =>
            void run(
              'others',
              () => api('/account/sessions/revoke-others', { method: 'POST' }),
              'Andere Sitzungen beendet',
            )
          }
        >
          <LogOut /> Andere abmelden
        </Button>
      </CardHeader>
      <ul className="divide-y divide-border border-t border-border">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-4 py-3">
            <Laptop className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{s.userAgent ?? 'Unbekanntes Gerät'}</p>
              <p className="text-xs text-fg-subtle">
                {s.ip ?? 'IP unbekannt'} · aktiv {formatRelative(s.lastSeenAt)} · angemeldet{' '}
                {formatDateTime(s.createdAt)}
              </p>
            </div>
            {s.current ? (
              <Badge variant="accent">Dieses Gerät</Badge>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                loading={busy === s.id}
                onClick={() =>
                  void run(
                    s.id,
                    () => api(`/account/sessions/${s.id}`, { method: 'DELETE' }),
                    'Sitzung beendet',
                  )
                }
              >
                Abmelden
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function LogoutEverywhere() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Überall abmelden
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Auf allen Geräten abmelden?"
        description="Alle Sitzungen – auch diese – werden sofort beendet."
        confirmLabel="Überall abmelden"
        destructive
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await api('/auth/logout-all', { method: 'POST' });
            router.push('/login');
            router.refresh();
          } catch (e) {
            toast.error(errorMessage(e));
            setBusy(false);
          }
        }}
      />
    </>
  );
}

function LimitRow({ type, current }: { type: LimitType; current: LimitDto | undefined }) {
  const router = useRouter();
  const [value, setValue] = useState(current ? stakeInput(current.amount) : '');
  const [busy, setBusy] = useState(false);
  const save = async (amount: number | null) => {
    setBusy(true);
    try {
      const result = await api<{ appliesImmediately: boolean }>('/account/limits', {
        method: 'PUT',
        body: { type, amount },
      });
      toast.success(
        result.appliesImmediately
          ? 'Limit gilt ab sofort'
          : 'Änderung gilt nach 24 Stunden Bedenkzeit',
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const parsed = parseStake(value);
  return (
    <li className="grid gap-3 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-end">
      <div className="space-y-1">
        <p className="text-sm font-medium">{LIMIT_LABELS[type]}</p>
        <p className="text-xs text-fg-muted">
          {current ? (
            <>
              Aktuell {formatMoney(current.amount)}
              {type !== 'STAKE_PER_BET' ? ` · genutzt ${formatMoney(current.used)}` : ''}
              {current.pendingAmount != null && current.pendingEffectiveAt
                ? ` · geplant: ${current.pendingAmount < 0 ? 'Aufhebung' : formatMoney(current.pendingAmount)} ab ${formatDateTime(current.pendingEffectiveAt)}`
                : ''}
            </>
          ) : (
            'Kein Limit gesetzt'
          )}
        </p>
      </div>
      <div className="flex gap-2">
        <div className="relative w-36">
          <Input
            inputMode="decimal"
            placeholder="z. B. 50,00"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`${LIMIT_LABELS[type]} in €`}
            className="pr-14 text-right"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">
            €
          </span>
        </div>
        <Button
          size="md"
          loading={busy}
          disabled={parsed === null}
          onClick={() => parsed !== null && void save(parsed)}
        >
          Setzen
        </Button>
        {current ? (
          <Button size="md" variant="ghost" disabled={busy} onClick={() => void save(null)}>
            Aufheben
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function LimitsCard({ limits }: { limits: LimitDto[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Einsatzlimits</CardTitle>
          <CardDescription>
            Senkungen gelten sofort. Erhöhungen und Aufhebungen erst nach 24 Stunden Bedenkzeit.
          </CardDescription>
        </div>
      </CardHeader>
      <ul className="divide-y divide-border border-t border-border">
        {LIMIT_TYPES.map((type) => (
          <LimitRow key={type} type={type} current={limits.find((l) => l.type === type)} />
        ))}
      </ul>
    </Card>
  );
}

const PERIODS: { value: SelfExclusionPeriod; label: string }[] = [
  { value: '24h', label: '24 Stunden' },
  { value: '7d', label: '7 Tage' },
  { value: '30d', label: '30 Tage' },
  { value: '180d', label: '6 Monate' },
  { value: 'permanent', label: 'Unbefristet' },
];

export function SelfExclusionCard({ exclusion }: { exclusion: SelfExclusionDto }) {
  const router = useRouter();
  const [period, setPeriod] = useState<SelfExclusionPeriod>('24h');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-warning" aria-hidden="true" /> Selbstsperre
          </CardTitle>
          <CardDescription>
            Während einer Selbstsperre kannst du keine Wetten platzieren. Sie kann nicht vorzeitig
            beendet werden.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {exclusion.active ? (
          <p
            className="rounded-md border border-warning/30 bg-warning-soft p-3 text-sm text-warning"
            data-testid="self-exclusion-active"
          >
            Selbstsperre aktiv{' '}
            {exclusion.endsAt ? `bis ${formatDateTime(exclusion.endsAt)}` : '(unbefristet)'}.
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Dauer" htmlFor="period" className="w-48">
            <NativeSelect
              id="period"
              value={period}
              onChange={(e) => setPeriod(e.target.value as SelfExclusionPeriod)}
            >
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Button variant="destructive" onClick={() => setOpen(true)}>
            Selbstsperre aktivieren
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Selbstsperre wirklich aktivieren?"
        description={`Für ${PERIODS.find((p) => p.value === period)?.label} kannst du keine Wetten platzieren. Das lässt sich nicht rückgängig machen.`}
        confirmLabel="Verbindlich sperren"
        destructive
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await api('/account/self-exclusion', { body: { period, confirm: true } });
            toast.success('Selbstsperre aktiviert');
            setOpen(false);
            router.refresh();
          } catch (e) {
            toast.error(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </Card>
  );
}
