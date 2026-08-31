'use client';

import { LogOut, Wrench } from 'lucide-react';
import { Button } from '@storm/ui';
import { useAuth } from '@/lib/auth-context';
import { usePanelSettings } from '@/lib/panel-settings';

/**
 * What a customer sees while the panel is in maintenance.
 *
 * Their servers keep running — nothing here stops a container — so the copy
 * says that plainly. The alternative, letting them into a panel where every
 * request comes back 503, reads as the panel being broken rather than being
 * worked on.
 */
export function MaintenanceScreen({ message }: { message: string }) {
  const { panelName, supportEmail } = usePanelSettings();
  const { signOut } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-12">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-warning/40 bg-warning/10">
          <Wrench className="h-6 w-6 text-warning" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {panelName} is under maintenance
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {message || 'The panel is temporarily unavailable. Please check back soon.'}
          </p>
        </div>

        <p className="text-sm text-muted-foreground">
          Your servers are unaffected and keep running. This page updates itself once the panel is
          back.
        </p>

        {supportEmail ? (
          <p className="text-sm text-muted-foreground">
            Need something urgently?{' '}
            <a
              href={`mailto:${supportEmail}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {supportEmail}
            </a>
          </p>
        ) : null}

        <Button variant="outline" size="sm" onClick={() => void signOut()}>
          <LogOut />
          Sign out
        </Button>
      </div>
    </div>
  );
}
