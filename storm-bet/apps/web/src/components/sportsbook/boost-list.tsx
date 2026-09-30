'use client';

import type { BoostDto, PlaceBetResponse } from '@storm-bet/types';
import { Button, Card, toast } from '@storm-bet/ui';
import { Rocket } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { formatKickoff, formatMoney, formatOdds, parseStake } from '@/lib/format';
import { uuid } from '@/lib/uuid';
import { announceWalletChange, useSession } from '../providers/session';
import { SportIcon } from './sport-icon';
import { useT } from '@/i18n/client';

/** Today's odds boosts: one pick at a raised price, limited stake, once per player. */
export function BoostList() {
  const t = useT();
  const { user } = useSession();
  const [boosts, setBoosts] = useState<BoostDto[]>([]);
  const load = useCallback(async () => {
    try {
      setBoosts((await api<{ boosts: BoostDto[] }>('/boosts')).boosts);
    } catch {
      setBoosts([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, user?.id]);

  if (boosts.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="boosts-title" data-testid="boosts">
      <h2 id="boosts-title" className="flex items-center gap-2 text-base font-semibold">
        <Rocket className="size-4 text-accent-strong" aria-hidden="true" /> {t('Quoten-Boosts')}
      </h2>
      <div className="grid gap-3 md:grid-cols-3">
        {boosts.map((b) => (
          <BoostCard key={b.id} boost={b} loggedIn={!!user} onChange={load} />
        ))}
      </div>
    </section>
  );
}

function BoostCard({
  boost,
  loggedIn,
  onChange,
}: {
  boost: BoostDto;
  loggedIn: boolean;
  onChange: () => Promise<void>;
}) {
  const t = useT();
  const [stake, setStake] = useState((boost.maxStake / 100).toFixed(2).replace('.', ','));
  const [busy, setBusy] = useState(false);
  const place = async () => {
    const value = parseStake(stake);
    if (!value) return;
    setBusy(true);
    try {
      const result = await api<PlaceBetResponse>('/bets/place', {
        body: {
          idempotencyKey: uuid(),
          mode: 'SINGLES',
          boostId: boost.id,
          oddsChangePolicy: 'REJECT',
          selections: [{ selectionId: boost.selectionId, odds: boost.boostedOdds, stake: value }],
        },
      });
      announceWalletChange(result.wallet);
      toast.success(t('Boost platziert · {0}', [result.bets[0]?.reference ?? '']));
    } catch (e) {
      toast.error(
        e instanceof ApiError && e.code === 'ODDS_CHANGED'
          ? t('Die Quote hat sich geändert – bitte prüfe den neuen Boost.')
          : e instanceof ApiError
            ? e.message
            : t('Der Boost konnte nicht platziert werden.'),
      );
    } finally {
      setBusy(false);
      void onChange();
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="boost-card">
      <div className="flex items-start gap-2">
        <SportIcon sport={boost.sportKey} className="mt-0.5 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{t(boost.title)}</p>
          <p className="truncate text-xs text-fg-muted">
            {boost.eventName} · {t(formatKickoff(boost.startTime))}
          </p>
        </div>
        <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-strong">
          +{boost.upliftPct} %
        </span>
      </div>
      <p className="flex items-baseline gap-2">
        <span className="tabular text-sm text-fg-subtle line-through">
          {formatOdds(boost.odds)}
        </span>
        <span className="tabular text-2xl font-semibold text-up">
          {formatOdds(boost.boostedOdds)}
        </span>
        <span className="ml-auto text-xs text-fg-muted">max. {formatMoney(boost.maxStake)}</span>
      </p>
      {!loggedIn ? (
        <Button variant="secondary" asChild>
          <Link href="/login">{t('Anmelden, um zu wetten')}</Link>
        </Button>
      ) : boost.used ? (
        <Button variant="secondary" disabled>
          {t('Bereits genutzt')}
        </Button>
      ) : !boost.open ? (
        <Button variant="secondary" disabled>
          {t('Gerade nicht verfügbar')}
        </Button>
      ) : (
        <div className="flex gap-2">
          <input
            inputMode="decimal"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            aria-label={t('Einsatz')}
            className="tabular h-10 w-24 rounded-md border border-border-strong bg-surface-2 px-2 text-right text-sm font-semibold focus-visible:border-accent focus-visible:outline-none"
          />
          <Button
            className="flex-1"
            onClick={() => void place()}
            loading={busy}
            data-testid="boost-place"
          >
            {t('Boost wetten')}
          </Button>
        </div>
      )}
    </Card>
  );
}
