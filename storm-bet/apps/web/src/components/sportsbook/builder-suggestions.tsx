'use client';

import type {
  EventDetailDto,
  MarketDto,
  MarketType,
  Outcome,
  ValidateSlipResponse,
} from '@storm-bet/types';
import { Card, cn } from '@storm-bet/ui';
import { Plus, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import { formatOdds } from '@/lib/format';
import { useBetSlip } from '@/stores/bet-slip';
import { eventName } from './event-row';
import { useLiveEvent } from './hooks';
import { useT } from '@/i18n/client';
import type { T } from '@/i18n/translate';

interface Pick {
  type: MarketType;
  line?: number;
  outcome: Outcome;
}

interface Suggestion {
  title: string;
  legs: { market: MarketDto; selection: MarketDto['selections'][number] }[];
  odds: number | null;
}

/** Common combinations for this match, priced like any Bet Builder. */
function presets(
  markets: MarketDto[],
  home: string,
  away: string,
  t: T,
): Omit<Suggestion, 'odds'>[] {
  const result = markets.find((m) => m.type === 'MATCH_RESULT');
  const price = (o: Outcome) => result?.selections.find((s) => s.outcome === o)?.odds ?? Infinity;
  const fav: 'HOME' | 'AWAY' = price('HOME') <= price('AWAY') ? 'HOME' : 'AWAY';
  const favName = fav === 'HOME' ? home : away;
  const list: { title: string; picks: Pick[] }[] = [
    {
      title: t('{0} gewinnt & über 1,5 Tore', [favName]),
      picks: [
        { type: 'MATCH_RESULT', outcome: fav },
        { type: 'TOTAL_GOALS', line: 1.5, outcome: 'OVER' },
      ],
    },
    {
      title: t('Beide treffen & über 2,5 Tore'),
      picks: [
        { type: 'BOTH_TEAMS_TO_SCORE', outcome: 'YES' },
        { type: 'TOTAL_GOALS', line: 2.5, outcome: 'OVER' },
      ],
    },
    {
      title: t('{0} gewinnt & beide treffen', [favName]),
      picks: [
        { type: 'MATCH_RESULT', outcome: fav },
        { type: 'BOTH_TEAMS_TO_SCORE', outcome: 'YES' },
      ],
    },
    {
      title: t('{0} oder Unentschieden & unter 3,5 Tore', [favName]),
      picks: [
        { type: 'DOUBLE_CHANCE', outcome: fav === 'HOME' ? 'HOME_OR_DRAW' : 'DRAW_OR_AWAY' },
        { type: 'TOTAL_GOALS', line: 3.5, outcome: 'UNDER' },
      ],
    },
  ];
  return list.flatMap(({ title, picks }) => {
    const legs = picks.map((p) => {
      const market = markets.find(
        (m) =>
          m.type === p.type && m.status === 'OPEN' && (p.line === undefined || m.line === p.line),
      );
      const selection = market?.selections.find(
        (s) => s.outcome === p.outcome && s.status === 'OPEN',
      );
      return market && selection ? { market, selection } : null;
    });
    return legs.every(Boolean) ? [{ title, legs: legs as Suggestion['legs'] }] : [];
  });
}

export function BuilderSuggestions({
  event,
  header,
  className,
}: {
  event: EventDetailDto;
  /** Replaces the default title row (the home page shows the match there). */
  header?: React.ReactNode;
  className?: string;
}) {
  const t = useT();
  const live = useLiveEvent(event);
  const replaceEvent = useBetSlip((s) => s.replaceEvent);
  const setOpen = useBetSlip((s) => s.setOpen);
  const eligible =
    event.sport.key === 'football' && (live.status === 'SCHEDULED' || live.status === 'LIVE');
  const base = useMemo(
    () => (eligible ? presets(event.markets, event.home.name, event.away.name, t) : []),
    [eligible, event.markets, event.home.name, event.away.name, t],
  );
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      base.map(async (s) => {
        try {
          const quote = await api<ValidateSlipResponse>('/bets/validate', {
            body: {
              mode: 'BUILDER',
              stake: 0,
              oddsChangePolicy: 'REJECT',
              selections: s.legs.map((l) => ({ selectionId: l.selection.id })),
            },
          });
          return {
            ...s,
            odds: quote.quote.betType === 'BET_BUILDER' ? quote.quote.totalOdds : null,
          };
        } catch {
          return { ...s, odds: null };
        }
      }),
    ).then((priced) => {
      if (!cancelled) setSuggestions(priced.filter((s) => s.odds !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [base]);

  if (suggestions.length === 0) return null;
  const add = (s: Suggestion) => {
    replaceEvent(
      event.id,
      s.legs.map(({ market, selection }) => ({
        selectionId: selection.id,
        marketId: market.id,
        eventId: event.id,
        eventName: eventName(event),
        marketName: market.name,
        selectionName: selection.name,
        sportKey: event.sport.key,
        startTime: event.startTime,
        odds: selection.odds,
        status: 'OPEN',
        isLive: live.isLive,
      })),
    );
    setOpen(true);
  };

  return (
    <Card className={cn('overflow-hidden', className)} data-testid="builder-suggestions">
      {header ?? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Sparkles className="size-4 text-accent-strong" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{t('Bet-Builder-Vorschläge')}</h3>
          {live.isLive ? <span className="text-xs font-semibold text-live">LIVE</span> : null}
        </div>
      )}
      <ul className="grid gap-2 p-3 sm:grid-cols-2">
        {suggestions.map((s) => (
          <li key={s.title} className="min-w-0">
            <button
              type="button"
              onClick={() => add(s)}
              className="group flex w-full items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-accent/60 hover:bg-surface-3 active:scale-[0.99]"
              aria-label={t('{0} – Quote {1} – in den Wettschein', [s.title, formatOdds(s.odds!)])}
              data-testid="builder-suggestion"
            >
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 block text-sm font-semibold leading-snug">
                  {s.title}
                </span>
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {s.legs.map((l) => (
                    <span
                      key={l.selection.id}
                      className="truncate rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-fg-muted"
                    >
                      {t(l.selection.name)}
                    </span>
                  ))}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="tabular rounded-md bg-accent-soft px-2 py-1 text-sm font-bold text-accent-strong">
                  {formatOdds(s.odds!)}
                </span>
                <Plus
                  className="size-4 text-fg-subtle transition-colors group-hover:text-fg"
                  aria-hidden="true"
                />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
