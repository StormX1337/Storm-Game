'use client';

import type { EventSummaryDto, Paginated } from '@storm-bet/types';
import { EmptyState, Input, cn } from '@storm-bet/ui';
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { api } from '@/lib/api-client';
import { EventList } from '../sportsbook/event-list';

/** Finds open events by team or league name; debounced so typing does not flood the API. */
export function SearchEvents({ initialQuery }: { initialQuery: string }) {
  const t = useT();
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [events, setEvents] = useState<EventSummaryDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const term = query.trim();

  useEffect(() => {
    if (term.length < 2) {
      setEvents(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      router.replace(`/search?q=${encodeURIComponent(term)}`, { scroll: false });
      api<Paginated<EventSummaryDto>>(`/events?q=${encodeURIComponent(term)}&limit=30`)
        .then((r) => !cancelled && setEvents(r.items))
        .catch(() => !cancelled && setEvents([]))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [term, router]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('Suche')}</h1>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden="true"
        />
        <Input
          type="search"
          autoFocus
          value={query}
          maxLength={40}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Team oder Liga suchen …')}
          aria-label={t('Team oder Liga suchen …')}
          className="h-11 pl-9"
          data-testid="search-input"
        />
      </div>
      {events === null ? (
        <p className="text-sm text-fg-muted">{t('Mindestens 2 Zeichen eingeben.')}</p>
      ) : events.length === 0 && !loading ? (
        <EmptyState
          icon={<Search />}
          title={t('Keine Treffer')}
          description={t('Versuch einen anderen Team- oder Liganamen.')}
        />
      ) : (
        <div className={cn('transition-opacity', loading && 'opacity-60')}>
          <EventList events={events} subscribeLive />
        </div>
      )}
    </div>
  );
}
