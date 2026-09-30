'use client';

import type { MarketStatus, SelectionDto, SportKey } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { Lock } from 'lucide-react';
import { formatOdds } from '@/lib/format';
import { useBetSlip } from '@/stores/bet-slip';
import { useLiveMarketStatus, useLiveSelection } from './hooks';
import { useT } from '@/i18n/client';

export interface OddsContext {
  eventId: string;
  eventName: string;
  sportKey: SportKey;
  startTime: string;
  isLive: boolean;
  marketId: string;
  marketName: string;
  marketStatus: MarketStatus;
  /** Several selections of this market may sit on the slip (goalscorers). */
  multi?: boolean;
}

export function OddsButton({
  selection,
  context,
  label,
  className,
  layout = 'stacked',
}: {
  selection: SelectionDto;
  context: OddsContext;
  /** Short label (1 / X / 2, Über …). Defaults to the selection name. */
  label?: string;
  className?: string;
  layout?: 'stacked' | 'inline';
}) {
  const t = useT();
  const live = useLiveSelection(selection);
  const marketStatus = useLiveMarketStatus(context.marketId, context.marketStatus);
  const selected = useBetSlip((s) => s.items.some((i) => i.selectionId === selection.id));
  const toggle = useBetSlip((s) => s.toggle);
  const available = live.status === 'OPEN' && marketStatus === 'OPEN';
  const text = label ?? t(selection.name);

  return (
    <button
      type="button"
      disabled={!available && !selected}
      aria-pressed={selected}
      data-testid="odds-button"
      data-selection-id={selection.id}
      title={`${t(context.marketName)}: ${t(selection.name)}`}
      onClick={() =>
        toggle({
          selectionId: selection.id,
          marketId: context.marketId,
          eventId: context.eventId,
          eventName: context.eventName,
          marketName: context.marketName,
          selectionName: selection.name,
          sportKey: context.sportKey,
          startTime: context.startTime,
          odds: live.odds,
          status: live.status,
          isLive: context.isLive,
          multi: context.multi,
        })
      }
      className={cn(
        'group relative flex min-h-11 min-w-0 items-center justify-between gap-2 overflow-hidden rounded-md border px-2.5 py-1.5 text-left transition-[background-color,border-color,color] duration-150',
        layout === 'stacked' && 'flex-col items-stretch justify-center gap-0.5 text-center',
        selected
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-border bg-surface-2 text-fg hover:border-border-strong hover:bg-surface-3',
        !available &&
          !selected &&
          'cursor-not-allowed opacity-60 hover:border-border hover:bg-surface-2',
        className,
      )}
    >
      <span
        className={cn(
          'truncate text-xs',
          selected ? 'text-accent-fg/80' : 'text-fg-muted group-hover:text-fg',
          layout === 'stacked' && 'text-[11px]',
        )}
      >
        {text}
      </span>
      {available || selected ? (
        <span
          key={live.version}
          className={cn(
            'tabular rounded-sm text-sm font-semibold',
            !selected && live.direction === 'up' && 'animate-flash-up text-up',
            !selected && live.direction === 'down' && 'animate-flash-down text-down',
          )}
        >
          {formatOdds(live.odds)}
        </span>
      ) : (
        <Lock className="mx-auto size-3.5 text-fg-subtle" aria-label={t('Gesperrt')} />
      )}
    </button>
  );
}
