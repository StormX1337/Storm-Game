import type { ProfileDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import { ProfileForm } from '@/components/dashboard/account-forms';
import { VerifyNotice } from '@/components/dashboard/verify-notice';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime } from '@/lib/format';
import { serverApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Profil') };
}

export default async function ProfilePage() {
  const t = await getT();
  const profile = await serverApi<ProfileDto>('/account/profile');
  return (
    <>
      <PageHeader
        title={t('Profil')}
        description={t('Mitglied seit {0}{1}', [
          formatDateTime(profile.createdAt),
          profile.lastLoginAt
            ? t(' · letzte Anmeldung {0}', [formatDateTime(profile.lastLoginAt)])
            : '',
        ])}
      />
      {!profile.emailVerified ? <VerifyNotice /> : null}
      <ProfileForm profile={profile} />
    </>
  );
}
