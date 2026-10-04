'use client';

import type { FeedItemDto } from '@storm-bet/types';
import { Badge, Button, Card, cn } from '@storm-bet/ui';
import { Check, Copy, X } from 'lucide-react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { formatKickoff, formatOdds, formatRelative } from '@/lib/format';
import { BET_STATUS_LABELS, BET_TYPE_LABELS, betStatusVariant } from '@/lib/labels';
import { SportIcon } from '../sportsbook/sport-icon';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** One shared bet: who, what, at which odds – and the picks to take over. */
export function FeedCard({ item }: { item: FeedItemDto }) {
  const t = useT();
  const { bet } = item;
  // Picks that may still be open; the shared slip shows today's prices.
  const open = bet.selections.filter((s) => s.result === 'PENDING').map((s) => s.selectionId);
  return (
    <Card className="overflow-hidden" data-testid="feed-card">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent-strong">
          {initials(item.author)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {item.author}
            {item.own ? (
              <span className="ml-1.5 text-xs font-normal text-fg-subtle">{t('(du)')}</span>
            ) : null}
          </p>
          <p className="text-xs text-fg-subtle">
            {t(BET_TYPE_LABELS[bet.type])}
            {bet.system ? ` ${bet.system.size}/${bet.selections.length}` : ''} ·{' '}
            {t(formatRelative(item.sharedAt))}
          </p>
        </div>
        <Badge variant={betStatusVariant(bet.status)}>{t(BET_STATUS_LABELS[bet.status])}</Badge>
      </div>
      <ul className="divide-y divide-border">
        {bet.selections.map((leg) => (
          <li key={leg.id} className="flex items-center gap-3 px-4 py-2.5">
            <span
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded-full',
                leg.result === 'WON'
                  ? 'bg-up text-white'
                  : leg.result === 'LOST'
                    ? 'bg-down text-white'
                    : 'bg-surface-3 text-fg-muted',
              )}
              aria-hidden="true"
            >
              {leg.result === 'WON' ? (
                <Check className="size-3" />
              ) : leg.result === 'LOST' ? (
                <X className="size-3" />
              ) : (
                <SportIcon sport={leg.sportKey} className="size-3" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t(leg.selectionName)}</p>
              <p className="truncate text-xs text-fg-muted">
                {t(leg.marketName)} · {leg.eventName} · {t(formatKickoff(leg.startTime))}
              </p>
            </div>
            <span className="tabular shrink-0 text-sm font-semibold">{formatOdds(leg.odds)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-2/50 px-4 py-2.5">
        <p className="text-xs text-fg-muted">
          {bet.system ? t('Ø Quote') : t('Gesamtquote')}{' '}
          <span className="tabular text-sm font-semibold text-fg">{formatOdds(bet.totalOdds)}</span>
          {bet.boosted ? (
            <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent-strong">
              BOOST
            </span>
          ) : null}
        </p>
        {open.length && !item.own ? (
          <Button size="sm" asChild>
            <Link href={`/share?ids=${open.join(',')}`} data-testid="feed-copy">
              <Copy /> {t('Übernehmen')}
            </Link>
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
