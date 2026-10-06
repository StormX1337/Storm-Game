'use client';

import type { BoostDto, PlaceBetResponse } from '@storm-bet/types';
import { Button, Card, toast } from '@storm-bet/ui';
import { ArrowRight, Zap } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { formatKickoff, formatMoney, formatOdds, parseStake } from '@/lib/format';
import { uuid } from '@/lib/uuid';
import { announceWalletChange, useSession } from '../providers/session';
import { SectionHeader } from '../home/section-header';
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
      <SectionHeader
        id="boosts-title"
        title={t('Quoten-Boosts')}
        icon={<Zap className="size-4 text-violet-strong" aria-hidden="true" />}
        count={boosts.length}
      />
      <div className="scrollbar-none -mx-4 flex items-start snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible min-[1700px]:grid-cols-3 md:px-0">
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
    <Card
      className="flex w-[85%] min-w-0 shrink-0 snap-start flex-col overflow-hidden md:w-auto"
      data-testid="boost-card"
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-violet-soft text-violet-strong">
          <Zap className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[15px] font-bold leading-snug tracking-tight">
            {t(boost.title)}
          </p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-fg-muted">
            <SportIcon sport={boost.sportKey} className="size-3" />
            <span className="truncate">
              {boost.eventName} · {t(formatKickoff(boost.startTime))}
            </span>
          </p>
        </div>
        <span className="shrink-0 rounded-md bg-violet-soft px-2 py-1 text-xs font-extrabold text-violet-strong">
          +{boost.upliftPct}%
        </span>
      </div>
      <div className="mx-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg border border-up/20 bg-[linear-gradient(90deg,transparent,rgb(34_197_94/0.08))] px-3 py-2.5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            {t('Normale Quote')}
          </p>
          <p className="tabular text-base font-semibold text-fg-subtle line-through decoration-fg-subtle/70">
            {formatOdds(boost.odds)}
          </p>
        </div>
        <ArrowRight className="size-4 text-fg-subtle" aria-hidden="true" />
        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-wider text-up">{t('Boost')}</p>
          <p className="tabular text-[28px] font-extrabold leading-8 text-up">
            {formatOdds(boost.boostedOdds)}
          </p>
        </div>
      </div>
      <div className="mt-auto space-y-2 p-4 pt-3">
        <p className="text-[11px] text-fg-subtle">
          {t('Max. Einsatz {0} · einmal pro Spieler', [formatMoney(boost.maxStake)])}
        </p>
        {!loggedIn ? (
          <Button variant="secondary" className="w-full" asChild>
            <Link href="/login">{t('Anmelden, um zu wetten')}</Link>
          </Button>
        ) : boost.used ? (
          <Button variant="secondary" className="w-full" disabled>
            {t('Bereits genutzt')}
          </Button>
        ) : !boost.open ? (
          <Button variant="secondary" className="w-full" disabled>
            {t('Gerade nicht verfügbar')}
          </Button>
        ) : (
          <div className="flex gap-2">
            <label className="relative">
              <span className="sr-only">{t('Einsatz')}</span>
              <input
                inputMode="decimal"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                className="tabular h-10 w-24 rounded-lg border border-border-strong bg-surface-2 pl-2 pr-6 text-right text-sm font-semibold focus-visible:border-accent focus-visible:outline-none"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">
                €
              </span>
            </label>
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
      </div>
    </Card>
  );
}
