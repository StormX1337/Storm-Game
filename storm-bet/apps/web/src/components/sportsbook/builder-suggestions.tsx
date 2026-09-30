'use client';

import type {
  EventDetailDto,
  MarketDto,
  MarketType,
  Outcome,
  ValidateSlipResponse,
} from '@storm-bet/types';
import { Card } from '@storm-bet/ui';
import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import { formatOdds } from '@/lib/format';
import { useBetSlip } from '@/stores/bet-slip';
import { eventName } from './event-row';
import { useLiveEvent } from './hooks';

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
function presets(markets: MarketDto[], home: string, away: string): Omit<Suggestion, 'odds'>[] {
  const result = markets.find((m) => m.type === 'MATCH_RESULT');
  const price = (o: Outcome) => result?.selections.find((s) => s.outcome === o)?.odds ?? Infinity;
  const fav: 'HOME' | 'AWAY' = price('HOME') <= price('AWAY') ? 'HOME' : 'AWAY';
  const favName = fav === 'HOME' ? home : away;
  const list: { title: string; picks: Pick[] }[] = [
    {
      title: `${favName} gewinnt & über 1,5 Tore`,
      picks: [
        { type: 'MATCH_RESULT', outcome: fav },
        { type: 'TOTAL_GOALS', line: 1.5, outcome: 'OVER' },
      ],
    },
    {
      title: 'Beide treffen & über 2,5 Tore',
      picks: [
        { type: 'BOTH_TEAMS_TO_SCORE', outcome: 'YES' },
        { type: 'TOTAL_GOALS', line: 2.5, outcome: 'OVER' },
      ],
    },
    {
      title: `${favName} gewinnt & beide treffen`,
      picks: [
        { type: 'MATCH_RESULT', outcome: fav },
        { type: 'BOTH_TEAMS_TO_SCORE', outcome: 'YES' },
      ],
    },
    {
      title: `${favName} oder Unentschieden & unter 3,5 Tore`,
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

export function BuilderSuggestions({ event }: { event: EventDetailDto }) {
  const live = useLiveEvent(event);
  const replaceEvent = useBetSlip((s) => s.replaceEvent);
  const setOpen = useBetSlip((s) => s.setOpen);
  const eligible =
    event.sport.key === 'football' && (live.status === 'SCHEDULED' || live.status === 'LIVE');
  const base = useMemo(
    () => (eligible ? presets(event.markets, event.home.name, event.away.name) : []),
    [eligible, event.markets, event.home.name, event.away.name],
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
    <Card className="overflow-hidden" data-testid="builder-suggestions">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Sparkles className="size-4 text-accent-strong" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Bet-Builder-Vorschläge</h3>
        {live.isLive ? <span className="text-xs font-semibold text-live">LIVE</span> : null}
      </div>
      <ul className="grid gap-2 p-3 sm:grid-cols-2">
        {suggestions.map((s) => (
          <li key={s.title} className="min-w-0">
            <button
              type="button"
              onClick={() => add(s)}
              className="flex w-full items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-accent"
              data-testid="builder-suggestion"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.title}</span>
                <span className="block truncate text-xs text-fg-muted">
                  {s.legs.map((l) => l.selection.name).join(' · ')}
                </span>
              </span>
              <span className="tabular rounded bg-surface-3 px-2 py-1 text-sm font-semibold">
                {formatOdds(s.odds!)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
