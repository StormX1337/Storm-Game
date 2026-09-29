import type { ProfileDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import { ProfileForm } from '@/components/dashboard/account-forms';
import { VerifyNotice } from '@/components/dashboard/verify-notice';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime } from '@/lib/format';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Profil' };

export default async function ProfilePage() {
  const profile = await serverApi<ProfileDto>('/account/profile');
  return (
    <>
      <PageHeader
        title="Profil"
        description={`Mitglied seit ${formatDateTime(profile.createdAt)}${profile.lastLoginAt ? ` · letzte Anmeldung ${formatDateTime(profile.lastLoginAt)}` : ''}`}
      />
      {!profile.emailVerified ? <VerifyNotice /> : null}
      <ProfileForm profile={profile} />
    </>
  );
}
