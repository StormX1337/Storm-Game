'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-fetches the server-rendered page periodically (new fixtures, finished ones). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [router, seconds]);
  return null;
}
