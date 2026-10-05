'use client';

import type { MarketStatus, SelectionDto, SportKey } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import { ArrowDown, ArrowUp, Check, Lock } from 'lucide-react';
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
  const stacked = layout === 'stacked';
  const moved = !selected && available ? live.direction : null;
  const state = selected ? 'selected' : available ? 'open' : 'suspended';

  return (
    <button
      type="button"
      disabled={!available && !selected}
      aria-pressed={selected}
      aria-label={
        available || selected
          ? t('{0}: {1}, Quote {2}', [
              t(context.marketName),
              t(selection.name),
              formatOdds(live.odds),
            ])
          : t('{0}: {1}, gesperrt', [t(context.marketName), t(selection.name)])
      }
      data-testid="odds-button"
      data-selection-id={selection.id}
      data-state={state}
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
        'group relative flex min-h-11 min-w-0 select-none items-center justify-between gap-2 overflow-hidden rounded-lg border px-3 py-1.5 text-left',
        'transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97]',
        stacked && 'flex-col items-stretch justify-center gap-0.5 px-2 text-center',
        selected
          ? 'border-accent bg-accent/15 shadow-[inset_0_0_0_1px_var(--color-accent)]'
          : 'border-border bg-surface-2 hover:border-border-strong hover:bg-surface-3',
        !available && !selected && 'cursor-not-allowed border-border/60 bg-surface/70',
        className,
      )}
    >
      <span
        className={cn(
          'flex min-w-0 items-center gap-1 truncate text-xs font-medium',
          stacked && 'justify-center text-[11px]',
          selected ? 'text-accent-strong' : 'text-fg-muted group-hover:text-fg',
        )}
      >
        {selected && !stacked ? (
          <Check className="size-3 shrink-0" strokeWidth={3} aria-hidden="true" />
        ) : null}
        <span className="truncate">{text}</span>
      </span>
      {available || selected ? (
        <span className={cn('flex items-center gap-0.5', stacked && 'justify-center')}>
          {moved ? (
            <span
              key={`arrow-${live.version}`}
              className={cn('animate-tick', moved === 'up' ? 'text-up' : 'text-down')}
              aria-hidden="true"
            >
              {moved === 'up' ? (
                <ArrowUp className="size-3" strokeWidth={2.6} />
              ) : (
                <ArrowDown className="size-3" strokeWidth={2.6} />
              )}
            </span>
          ) : null}
          <span
            key={live.version}
            className={cn(
              'tabular rounded-sm px-0.5 text-[15px] font-bold leading-5 text-fg lg:text-base',
              moved === 'up' && 'animate-flash-up text-up',
              moved === 'down' && 'animate-flash-down text-down',
            )}
          >
            {formatOdds(live.odds)}
          </span>
        </span>
      ) : (
        <Lock className={cn('size-3.5 text-fg-subtle', stacked && 'mx-auto')} aria-hidden="true" />
      )}
      {selected && stacked ? (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 grid size-3.5 place-items-center rounded-full bg-accent text-white"
        >
          <Check className="size-2.5" strokeWidth={3.5} />
        </span>
      ) : null}
    </button>
  );
}
