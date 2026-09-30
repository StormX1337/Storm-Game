import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { LoginForm } from '@/components/auth/forms';
import { getSessionUser } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Anmelden') };
}

export default async function Page() {
  if (await getSessionUser()) redirect('/dashboard');
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
