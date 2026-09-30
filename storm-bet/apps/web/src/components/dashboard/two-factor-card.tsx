'use client';

import type { TwoFactorStatusDto } from '@storm-bet/types';
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
  toast,
} from '@storm-bet/ui';
import { Copy, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useT } from '@/i18n/client';

type Stage =
  | { kind: 'idle' }
  | { kind: 'password' }
  | { kind: 'scan'; secret: string; uri: string; qr: string }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'disable' };

/** Two-factor login with an authenticator app: set up, recovery codes, switch off. */
export function TwoFactorCard({ initial }: { initial: TwoFactorStatusDto }) {
  const t = useT();
  const [status, setStatus] = useState(initial);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPassword('');
    setCode('');
    setError(null);
  }, [stage.kind]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => setStatus(await api<TwoFactorStatusDto>('/account/2fa'));

  const start = () =>
    run(async () => {
      const r = await api<{ secret: string; uri: string }>('/account/2fa/setup', {
        body: { password },
      });
      // Drawn locally from the otpauth URI; the secret never goes to another service.
      const qr = await QRCode.toDataURL(r.uri, { margin: 1, width: 180 });
      setStage({ kind: 'scan', secret: r.secret, uri: r.uri, qr });
    });
  const confirm = () =>
    run(async () => {
      const r = await api<{ recoveryCodes: string[] }>('/account/2fa/enable', { body: { code } });
      setStage({ kind: 'codes', codes: r.recoveryCodes });
      await refresh();
      toast.success(t('Zwei-Faktor-Anmeldung aktiviert'));
    });
  const disable = () =>
    run(async () => {
      await api('/account/2fa/disable', { body: { password, code } });
      setStage({ kind: 'idle' });
      await refresh();
      toast.success(t('Zwei-Faktor-Anmeldung deaktiviert'));
    });
  const renew = () =>
    run(async () => {
      const r = await api<{ recoveryCodes: string[] }>('/account/2fa/recovery-codes', {
        body: { code },
      });
      setStage({ kind: 'codes', codes: r.recoveryCodes });
      await refresh();
    });

  return (
    <Card data-testid="two-factor">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" aria-hidden="true" /> {t('Zwei-Faktor-Anmeldung')}
          </CardTitle>
          <CardDescription>
            {t(
              'Zusätzlich zum Passwort ein Code aus einer Authenticator-App (z. B. Google Authenticator, Microsoft Authenticator, 1Password oder iPhone-Passwörter).',
            )}
          </CardDescription>
        </div>
        <Badge variant={status.enabled ? 'success' : 'outline'}>
          {status.enabled ? t('Aktiv') : t('Aus')}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-down" role="alert">
            {error}
          </p>
        ) : null}

        {stage.kind === 'codes' ? (
          <div className="space-y-3">
            <p className="text-sm">
              {t('Deine')} <strong>{t('Wiederherstellungscodes')}</strong>{' '}
              {t(
                '– jeder funktioniert einmal, falls du dein Handy nicht hast. Bewahre sie sicher auf; sie werden nur jetzt angezeigt.',
              )}
            </p>
            <ul
              className="tabular grid grid-cols-2 gap-1.5 rounded-md bg-surface-2 p-3 font-mono text-sm"
              data-testid="recovery-codes"
            >
              {stage.codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(stage.codes.join('\n'))
                    .then(() => toast.success(t('Kopiert')))
                }
              >
                <Copy /> {t('Kopieren')}
              </Button>
              <Button size="sm" onClick={() => setStage({ kind: 'idle' })}>
                {t('Gespeichert')}
              </Button>
            </div>
          </div>
        ) : stage.kind === 'scan' ? (
          <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL */}
            <img
              src={stage.qr}
              width={180}
              height={180}
              className="rounded-md bg-white"
              alt={t('QR-Code für die Authenticator-App')}
              data-testid="totp-qr"
            />
            <div className="space-y-3 text-sm">
              <p>{t('1. QR-Code mit der App scannen – oder am Handy direkt öffnen:')}</p>
              <Button asChild variant="secondary" size="sm">
                <a href={stage.uri}>{t('In Authenticator-App öffnen')}</a>
              </Button>
              <p className="text-xs text-fg-muted">
                {t('Oder manuell eingeben:')}{' '}
                <code className="break-all font-mono" data-testid="totp-secret">
                  {stage.secret}
                </code>
              </p>
              <p>{t('2. Den 6-stelligen Code aus der App eingeben:')}</p>
              <div className="flex gap-2">
                <Input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="tabular w-32 text-center tracking-widest"
                  aria-label={t('Code aus der App')}
                  data-testid="totp-code"
                />
                <Button
                  onClick={() => void confirm()}
                  loading={busy}
                  disabled={code.length !== 6}
                  data-testid="totp-enable"
                >
                  {t('Aktivieren')}
                </Button>
              </div>
            </div>
          </div>
        ) : stage.kind === 'password' ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('Passwort zur Bestätigung')} htmlFor="tfa-password">
              <Input
                id="tfa-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button onClick={() => void start()} loading={busy} disabled={!password}>
              {t('Weiter')}
            </Button>
            <Button variant="ghost" onClick={() => setStage({ kind: 'idle' })}>
              {t('Abbrechen')}
            </Button>
          </div>
        ) : stage.kind === 'disable' ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('Passwort')} htmlFor="tfa-off-password">
              <Input
                id="tfa-off-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label={t('Code oder Wiederherstellungscode')} htmlFor="tfa-off-code">
              <Input
                id="tfa-off-code"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <Button
              variant="destructive"
              onClick={() => void disable()}
              loading={busy}
              disabled={!password || code.trim().length < 6}
            >
              {t('Deaktivieren')}
            </Button>
            <Button variant="ghost" onClick={() => setStage({ kind: 'idle' })}>
              {t('Abbrechen')}
            </Button>
          </div>
        ) : status.enabled ? (
          <div className="space-y-3 text-sm">
            <p className="text-fg-muted">
              {t('Aktiv seit')} {status.enabledAt ? formatDateTime(status.enabledAt) : '–'} ·{' '}
              {status.recoveryCodesLeft} {t('Wiederherstellungscodes übrig.')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                placeholder={t('Code')}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="tabular w-28 text-center"
                aria-label={t('Code aus der App')}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void renew()}
                loading={busy}
                disabled={code.length !== 6}
              >
                {t('Neue Wiederherstellungscodes')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setStage({ kind: 'disable' })}>
                {t('Deaktivieren')}
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setStage({ kind: 'password' })} data-testid="totp-setup">
            {t('Einrichten')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
