'use client';

import type { SharedSelectionDto } from '@storm-bet/types';
import { Button, Card, EmptyState, toast } from '@storm-bet/ui';
import { Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { formatKickoff, formatOdds } from '@/lib/format';
import { useBetSlip } from '@/stores/bet-slip';
import { SportIcon } from '../sportsbook/sport-icon';
import { useT } from '@/i18n/client';

export function SharedSlip({ ids }: { ids: string[] }) {
  const t = useT();
  const [selections, setSelections] = useState<SharedSelectionDto[] | null>(null);
  const addMany = useBetSlip((s) => s.addMany);
  const setOpen = useBetSlip((s) => s.setOpen);
  const key = ids.join(',');

  useEffect(() => {
    if (!key) {
      setSelections([]);
      return;
    }
    api<{ selections: SharedSelectionDto[] }>(`/selections?ids=${encodeURIComponent(key)}`)
      .then((r) => setSelections(r.selections))
      .catch(() => setSelections([]));
  }, [key]);

  if (selections === null) return <Card className="h-40 animate-pulse" />;
  const open = selections.filter((s) => s.open);
  if (selections.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Share2 />}
          title={t('Nichts gefunden')}
          description={t('Dieser Link enthält keine gültigen Tipps.')}
        />
      </Card>
    );
  }

  const take = () => {
    addMany(
      open.map((s) => ({
        selectionId: s.selectionId,
        marketId: s.marketId,
        eventId: s.eventId,
        eventName: s.eventName,
        marketName: s.marketName,
        selectionName: s.selectionName,
        sportKey: s.sportKey,
        startTime: s.startTime,
        odds: s.odds,
        status: 'OPEN',
        isLive: s.isLive,
        multi: s.marketType === 'PLAYER_TO_SCORE',
      })),
    );
    setOpen(true);
    toast.success(
      t('{0} {1} im Wettschein', [open.length, open.length === 1 ? t('Tipp') : t('Tipps')]),
    );
  };

  return (
    <Card className="overflow-hidden" data-testid="shared-slip">
      <ul className="divide-y divide-border">
        {selections.map((s) => (
          <li key={s.selectionId} className="flex items-center gap-3 px-4 py-3">
            <SportIcon sport={s.sportKey} className="text-fg-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{t(s.selectionName)}</p>
              <p className="truncate text-xs text-fg-muted">
                {t(s.marketName)} · {s.eventName}
              </p>
              <p className="text-xs text-fg-subtle">
                {s.isLive ? (
                  <span className="font-semibold text-live">LIVE</span>
                ) : (
                  t(formatKickoff(s.startTime))
                )}
              </p>
            </div>
            {s.open ? (
              <span className="tabular rounded bg-surface-3 px-2 py-1 text-sm font-semibold">
                {formatOdds(s.odds)}
              </span>
            ) : (
              <span className="text-xs text-fg-subtle">{t('nicht mehr verfügbar')}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="border-t border-border p-3">
        <Button
          className="w-full"
          disabled={open.length === 0}
          onClick={take}
          data-testid="take-shared"
        >
          {open.length ? t('In meinen Wettschein übernehmen') : t('Keine Tipps mehr verfügbar')}
        </Button>
      </div>
    </Card>
  );
}
