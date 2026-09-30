'use client';

import { Toaster, TooltipProvider } from '@storm-bet/ui';
import type { SessionUserDto } from '@storm-bet/types';
import { LocaleProvider } from '@/i18n/client';
import type { Locale } from '@/i18n/locale';
import { RealtimeProvider } from './realtime';
import { SessionProvider } from './session';

export function Providers({
  user,
  locale,
  children,
}: {
  user: SessionUserDto | null;
  locale: Locale;
  children: React.ReactNode;
}) {
  return (
    <LocaleProvider locale={locale}>
      <SessionProvider user={user}>
        <RealtimeProvider>
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </RealtimeProvider>
      </SessionProvider>
    </LocaleProvider>
  );
}
