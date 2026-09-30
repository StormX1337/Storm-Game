'use client';

import type { BetDto } from '@storm-bet/types';
import { Badge, Card, cn } from '@storm-bet/ui';
import { CheckCircle2, ChevronRight, Circle, MinusCircle, XCircle } from 'lucide-react';
import Link from 'next/link';
import { formatDateTime, formatMoney, formatOdds } from '@/lib/format';
import { BET_STATUS_LABELS, BET_TYPE_LABELS, betStatusVariant } from '@/lib/labels';
import { ShareButton } from '../betslip/share-button';
import { TeamBadge } from '../sportsbook/team-badge';
import { CashoutBar } from './cashout-bar';
import { LegLive } from './leg-live';
import { useT } from '@/i18n/client';

type Leg = BetDto['selections'][number];

/** ✓ won, ✗ lost, – void, ○ open. */
function ResultIcon({ result }: { result: Leg['result'] }) {
  const t = useT();
  if (result === 'WON')
    return <CheckCircle2 className="size-4 shrink-0 text-up" aria-label={t('Gewonnen')} />;
  if (result === 'LOST')
    return <XCircle className="size-4 shrink-0 text-down" aria-label={t('Verloren')} />;
  if (result === 'VOID')
    return <MinusCircle className="size-4 shrink-0 text-warning" aria-label={t('Storniert')} />;
  return <Circle className="size-4 shrink-0 text-fg-subtle" aria-label={t('Offen')} />;
}

function Teams({ leg }: { leg: Leg }) {
  return (
    <div className="space-y-1">
      {[leg.event.home, leg.event.away].map((team) => (
        <p key={team} className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
          <TeamBadge name={team} className="size-4 text-[7px]" />
          <span className="truncate">{team}</span>
        </p>
      ))}
    </div>
  );
}

function Legs({ bet }: { bet: BetDto }) {
  const t = useT();
  return (
    <ul className="divide-y divide-border/60">
      {bet.selections.map((leg) => (
        <li key={leg.id} className="space-y-2 px-4 py-3">
          <div className="flex items-start gap-2">
            <ResultIcon result={leg.result} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{t(leg.selectionName)}</p>
              <p className="truncate text-xs text-fg-muted">{t(leg.marketName)}</p>
              {leg.earlyPayout ? (
                <p className="text-[11px] font-semibold text-up">
                  {t('Frühe Auszahlung · 2 Tore Vorsprung')}
                </p>
              ) : null}
            </div>
            <span className="tabular text-sm font-semibold">{formatOdds(leg.odds)}</span>
          </div>
          <div className="flex items-end justify-between gap-2 pl-6">
            <Teams leg={leg} />
            <LegLive leg={leg} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One match, its picks as a chain. */
function BuilderLegs({ bet }: { bet: BetDto }) {
  const t = useT();
  const first = bet.selections[0];
  if (!first) return null;
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-end justify-between gap-2">
        <Teams leg={first} />
        <LegLive leg={first} />
      </div>
      <ol>
        {bet.selections.map((leg, i) => (
          <li key={leg.id} className="flex gap-3">
            <span className="flex w-4 shrink-0 flex-col items-center">
              <ResultIcon result={leg.result} />
              {i < bet.selections.length - 1 ? (
                <span className="my-0.5 w-px flex-1 bg-border-strong" />
              ) : null}
            </span>
            <div className="min-w-0 flex-1 pb-2.5">
              <p className="truncate text-sm font-semibold">{t(leg.selectionName)}</p>
              <p className="truncate text-xs text-fg-muted">{t(leg.marketName)}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BetCard({ bet, href }: { bet: BetDto; href?: string }) {
  const t = useT();
  const payout =
    bet.payout ??
    (bet.status === 'PENDING'
      ? Math.floor((bet.potentialReturn * bet.remainingStake) / bet.stake)
      : 0);
  const content = (
    <>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Badge variant={betStatusVariant(bet.status)}>{t(BET_STATUS_LABELS[bet.status])}</Badge>
        <span className="truncate text-sm font-semibold">
          {t(BET_TYPE_LABELS[bet.type])}
          {bet.system ? (
            <span className="ml-1 font-normal text-fg-muted">
              {bet.system.size} aus {bet.selections.length} · {bet.system.lines} {t('Wetten')}
            </span>
          ) : null}
        </span>
        {bet.boosted ? (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-strong">
            BOOST
          </span>
        ) : null}
        <span className="tabular ml-auto rounded-md bg-surface-3 px-2 py-0.5 text-sm font-semibold">
          {formatOdds(bet.totalOdds)}
        </span>
        {href ? (
          <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        ) : null}
      </div>
      <p className="flex justify-between px-4 pt-2 text-[11px] text-fg-subtle">
        <span className="font-mono">{bet.reference}</span>
        <span>{formatDateTime(bet.placedAt)}</span>
      </p>
      {bet.type === 'BET_BUILDER' ? <BuilderLegs bet={bet} /> : <Legs bet={bet} />}
      <dl className="grid grid-cols-3 gap-2 border-t border-border bg-surface-2/50 px-4 py-2.5 text-xs">
        <div>
          <dt className="text-fg-subtle">{t('Einsatz')}</dt>
          <dd className="tabular font-semibold">{formatMoney(bet.stake)}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">{bet.system ? t('Ø Quote') : t('Quote')}</dt>
          <dd className="tabular font-semibold">{formatOdds(bet.totalOdds)}</dd>
        </div>
        <div className="text-right">
          <dt className="text-fg-subtle">
            {bet.status === 'PENDING' ? t('Möglicher Gewinn') : t('Auszahlung')}
          </dt>
          <dd
            className={cn(
              'tabular font-semibold',
              (bet.status === 'WON' || bet.status === 'CASHED_OUT') && 'text-up',
              bet.status === 'LOST' && 'text-fg-muted',
            )}
          >
            {formatMoney(payout)}
          </dd>
        </div>
      </dl>
      {bet.partialCashouts.length ? (
        <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
          {t('Teil-Cashouts:')}{' '}
          {bet.partialCashouts
            .map((c) => t('{0} (Einsatz {1})', [formatMoney(c.amount), formatMoney(c.stake)]))
            .join(' · ')}
          {bet.status === 'PENDING' ? t(' · offen: {0}', [formatMoney(bet.remainingStake)]) : ''}
        </p>
      ) : null}
    </>
  );
  return (
    <Card
      className="overflow-hidden transition-colors hover:border-border-strong"
      data-testid="bet-card"
    >
      {href ? (
        <Link href={href} className="block">
          {content}
        </Link>
      ) : (
        content
      )}
      {bet.status === 'PENDING' && bet.type !== 'BET_BUILDER' ? (
        <CashoutBar betId={bet.id} />
      ) : null}
      <div className="flex justify-end border-t border-border px-4 py-1.5">
        <ShareButton
          selectionIds={bet.selections.map((s) => s.selectionId)}
          label={t('Tipp teilen')}
        />
      </div>
    </Card>
  );
}
