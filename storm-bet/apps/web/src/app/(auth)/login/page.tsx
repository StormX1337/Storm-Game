import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { LoginForm } from '@/components/auth/forms';
import { getSessionUser } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Anmelden' };

export default async function Page() {
  if (await getSessionUser()) redirect('/dashboard');
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
