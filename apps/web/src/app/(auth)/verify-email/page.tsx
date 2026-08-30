'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '@storm/ui';
import { api, errorMessage } from '@/lib/api';

function VerifyContent() {
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = React.useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    if (!token) {
      setState('failed');
      setMessage('This verification link is missing its token.');
      return;
    }

    api
      .post('/auth/verify-email', { token })
      .then(() => setState('done'))
      .catch((error: unknown) => {
        setState('failed');
        setMessage(errorMessage(error));
      });
  }, [token]);

  if (state === 'working') {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Verifying your email address…</p>
      </div>
    );
  }

  const success = state === 'done';

  return (
    <div className="space-y-6 text-center animate-fade-in">
      <div
        className={`mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-border ${
          success ? 'bg-success/10' : 'bg-destructive/10'
        }`}
      >
        {success ? (
          <CheckCircle2 className="h-5 w-5 text-success" />
        ) : (
          <XCircle className="h-5 w-5 text-destructive" />
        )}
      </div>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {success ? 'Email verified' : 'Verification failed'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {success
            ? 'Your address is confirmed. Everything in the panel is now available.'
            : message || 'That link is invalid or has expired.'}
        </p>
      </div>
      <Button className="w-full" asChild>
        <Link href={success ? '/dashboard' : '/login'}>
          {success ? 'Go to dashboard' : 'Back to sign in'}
        </Link>
      </Button>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <React.Suspense fallback={<div className="h-64" />}>
      <VerifyContent />
    </React.Suspense>
  );
}
