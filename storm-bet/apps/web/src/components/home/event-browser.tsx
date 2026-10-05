'use client';

import type { EventSummaryDto, Paginated, SportDto, SportKey } from '@storm-bet/types';
import { Button, Card, cn } from '@storm-bet/ui';
import { AlertTriangle, Clock, Grid2x2, RotateCw, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { api } from '@/lib/api-client';
import { EventList } from '../sportsbook/event-list';
import { SportIcon } from '../sportsbook/sport-icon';

type Mode = 'live' | 'upcoming';

/** Live / coming up, filtered by sport with an icon row – the home page's main list. */
export function EventBrowser({
  sports,
  initial,
  initialMode,
  withinHours,
}: {
  sports: SportDto[];
  initial: EventSummaryDto[];
  initialMode: Mode;
  withinHours: number;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [sport, setSport] = useState<SportKey | null>(null);
  const [events, setEvents] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ status: mode, limit: '25' });
    if (sport) params.set('sport', sport);
    if (mode === 'upcoming') params.set('withinHours', String(withinHours));
    api<Paginated<EventSummaryDto>>(`/events?${params}`)
      .then((r) => {
        if (cancelled) return;
        setEvents(r.items);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [mode, sport, withinHours, attempt]);

  const tabs = sports.filter((s) => (mode === 'live' ? s.liveCount > 0 : s.eventCount > 0));
  return (
    <section className="space-y-3" aria-labelledby="browse-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="browse-title" className="whitespace-nowrap text-[17px] font-bold tracking-tight">
          {t('Jetzt wetten')}
        </h2>
        <div
          className="flex rounded-lg border border-border bg-surface p-0.5"
          role="tablist"
          aria-label={t('Ansicht')}
        >
          {(
            [
              ['live', t('Live'), Zap],
              ['upcoming', t('Demnächst'), Clock],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              onClick={() => {
                setMode(key);
                setSport(null);
              }}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-semibold transition-colors sm:px-3',
                mode === key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
              )}
              data-testid={`browse-${key}`}
            >
              <Icon className={cn('size-4', key === 'live' && 'text-live')} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="-mx-4 md:mx-0">
        <div
          className="scrollbar-none flex gap-1 overflow-x-auto overscroll-x-contain px-4 md:px-0"
          role="tablist"
          aria-label={t('Sportarten')}
        >
          {[null, ...tabs.map((s) => s.key)].map((key) => {
            const info = tabs.find((s) => s.key === key);
            const on = sport === key;
            return (
              <button
                key={key ?? 'all'}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setSport(key)}
                className={cn(
                  'flex min-w-[4.5rem] shrink-0 flex-col items-center gap-1 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors',
                  on
                    ? 'border-accent/50 bg-accent-soft text-fg [&_svg]:text-accent-strong'
                    : 'border-transparent text-fg-muted hover:bg-surface hover:text-fg',
                )}
              >
                {key ? (
                  <SportIcon sport={key} className="size-6" />
                ) : (
                  <Grid2x2 className="size-6" aria-hidden="true" />
                )}
                <span className="whitespace-nowrap">{key ? t(info?.name) : t('Beliebt')}</span>
              </button>
            );
          })}
        </div>
      </div>
      {failed ? (
        <Card className="flex flex-wrap items-center gap-3 p-4" role="alert">
          <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-fg-muted">
            {t('Die Events konnten nicht geladen werden.')}
          </p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            <RotateCw /> {t('Erneut versuchen')}
          </Button>
        </Card>
      ) : (
        <div className={cn('transition-opacity', loading && 'opacity-60')}>
          <EventList
            events={events}
            subscribeLive={mode === 'live'}
            emptyTitle={mode === 'live' ? 'Gerade läuft kein Event' : 'Keine anstehenden Events'}
            emptyDescription={
              mode === 'live'
                ? t('Schau gleich wieder vorbei – neue Spiele beginnen laufend.')
                : undefined
            }
          />
        </div>
      )}
    </section>
  );
}
