'use client';

import type { AdminBetDetailDto } from '@storm-bet/types';
import { hasPermission, Permission } from '@storm-bet/types';
import { Button, toast } from '@storm-bet/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { useSession } from '../providers/session';
import { ReasonAction } from './reason-action';

export function BetActions({ bet }: { bet: AdminBetDetailDto }) {
  const { user } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!user || !hasPermission(user.role, Permission.BETS_SETTLE) || bet.status !== 'PENDING') {
    return bet.status !== 'PENDING' ? (
      <p className="text-xs text-fg-muted">
        Abgerechnete Wetten sind unveränderlich (datenbankseitig erzwungen).
      </p>
    ) : null;
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/admin/bets/${bet.id}/settle`, { method: 'POST' });
            toast.success('Wette abgerechnet');
            router.refresh();
          } catch (e) {
            toast.error(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Abrechnung prüfen
      </Button>
      <ReasonAction
        label="Stornieren & erstatten"
        title="Wette stornieren"
        description="Der Einsatz wird vollständig erstattet (BET_REFUND). Die Wette bleibt mit Begründung im Verlauf."
        path={`/admin/bets/${bet.id}/refund`}
        destructive
        variant="destructive"
        successMessage="Wette erstattet"
      />
    </div>
  );
}
