'use client';

import { Toaster, TooltipProvider } from '@storm-bet/ui';
import type { SessionUserDto } from '@storm-bet/types';
import { RealtimeProvider } from './realtime';
import { SessionProvider } from './session';

export function Providers({
  user,
  children,
}: {
  user: SessionUserDto | null;
  children: React.ReactNode;
}) {
  return (
    <SessionProvider user={user}>
      <RealtimeProvider>
        <TooltipProvider>
          {children}
          <Toaster />
        </TooltipProvider>
      </RealtimeProvider>
    </SessionProvider>
  );
}
