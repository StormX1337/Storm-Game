import type { SessionInfoDto, TwoFactorStatusDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import {
  ChangePasswordForm,
  LogoutEverywhere,
  SessionsList,
} from '@/components/dashboard/account-forms';
import { TwoFactorCard } from '@/components/dashboard/two-factor-card';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Sicherheit') };
}

export default async function SecurityPage() {
  const t = await getT();
  const [sessions, twoFactor] = await Promise.all([
    serverApi<SessionInfoDto[]>('/account/sessions'),
    serverApi<TwoFactorStatusDto>('/account/2fa'),
  ]);
  return (
    <>
      <PageHeader
        title={t('Sicherheit')}
        description={t('Passwort, Zwei-Faktor-Anmeldung, angemeldete Geräte und Sitzungen.')}
        actions={<LogoutEverywhere />}
      />
      <TwoFactorCard initial={twoFactor} />
      <ChangePasswordForm />
      <SessionsList sessions={sessions} />
    </>
  );
}
