import type { SessionInfoDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import {
  ChangePasswordForm,
  LogoutEverywhere,
  SessionsList,
} from '@/components/dashboard/account-forms';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Sicherheit' };

export default async function SecurityPage() {
  const sessions = await serverApi<SessionInfoDto[]>('/account/sessions');
  return (
    <>
      <PageHeader
        title="Sicherheit"
        description="Passwort, angemeldete Geräte und Sitzungen."
        actions={<LogoutEverywhere />}
      />
      <ChangePasswordForm />
      <SessionsList sessions={sessions} />
    </>
  );
}
