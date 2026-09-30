import type { BetDto } from '@storm-bet/types';
import { Badge, Card, cn } from '@storm-bet/ui';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { formatDateTime, formatMoney, formatOdds } from '@/lib/format';
import { BET_STATUS_LABELS, BET_TYPE_LABELS, betStatusVariant } from '@/lib/labels';
import { CashoutBar } from './cashout-bar';

const RESULT_STYLE = {
  PENDING: 'bg-fg-subtle',
  WON: 'bg-up',
  LOST: 'bg-down',
  VOID: 'bg-warning',
} as const;

export function BetCard({ bet, href }: { bet: BetDto; href?: string }) {
  const payout =
    bet.payout ??
    (bet.status === 'PENDING'
      ? Math.floor((bet.potentialReturn * bet.remainingStake) / bet.stake)
      : 0);
  const content = (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Badge variant={betStatusVariant(bet.status)}>{BET_STATUS_LABELS[bet.status]}</Badge>
        <span className="text-sm font-medium">{BET_TYPE_LABELS[bet.type]}</span>
        <span className="font-mono text-xs text-fg-subtle">{bet.reference}</span>
        <span className="ml-auto text-xs text-fg-subtle">{formatDateTime(bet.placedAt)}</span>
        {href ? <ChevronRight className="size-4 text-fg-subtle" aria-hidden="true" /> : null}
      </div>
      <ul className="divide-y divide-border/60">
        {bet.selections.map((leg) => (
          <li key={leg.id} className="flex items-center gap-3 px-4 py-2.5">
            <span
              className={cn('size-1.5 shrink-0 rounded-full', RESULT_STYLE[leg.result])}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{leg.selectionName}</p>
              <p className="truncate text-xs text-fg-muted">
                {leg.marketName} · {leg.eventName}
              </p>
            </div>
            <span className="tabular text-sm font-semibold">{formatOdds(leg.odds)}</span>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-3 gap-2 border-t border-border bg-surface-2/50 px-4 py-2.5 text-xs">
        <div>
          <dt className="text-fg-subtle">Einsatz</dt>
          <dd className="tabular font-semibold">{formatMoney(bet.stake)}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Quote</dt>
          <dd className="tabular font-semibold">{formatOdds(bet.totalOdds)}</dd>
        </div>
        <div className="text-right">
          <dt className="text-fg-subtle">
            {bet.status === 'PENDING' ? 'Möglicher Gewinn' : 'Auszahlung'}
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
          Teil-Cashouts:{' '}
          {bet.partialCashouts
            .map((c) => `${formatMoney(c.amount)} (Einsatz ${formatMoney(c.stake)})`)
            .join(' · ')}
          {bet.status === 'PENDING' ? ` · offen: ${formatMoney(bet.remainingStake)}` : ''}
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
    </Card>
  );
}
