import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VerifyEmail } from '@/components/auth/forms';

export const metadata: Metadata = { title: 'E-Mail bestätigen' };

export default function Page() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
