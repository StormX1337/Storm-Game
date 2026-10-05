'use client';

import type { LeagueDto } from '@storm-bet/types';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { SportIcon } from '../sportsbook/sport-icon';
import { SectionHeader } from './section-header';

/** The busiest competitions, two rows to swipe through. */
export function LeagueChips({ leagues }: { leagues: LeagueDto[] }) {
  const t = useT();
  if (leagues.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="top-leagues-title">
      <SectionHeader
        id="top-leagues-title"
        title={t('Top-Wettbewerbe')}
        href="/sports"
        linkLabel={t('Alle')}
      />
      <nav aria-label={t('Wettbewerbe')} className="-mx-4 md:mx-0">
        <div className="scrollbar-none grid auto-cols-max grid-flow-col grid-rows-2 gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 md:px-0">
          {leagues.map((l) => (
            <Link
              key={l.id}
              href={`/sports/${l.sportKey}?league=${l.id}`}
              className="flex h-12 items-center gap-2.5 rounded-xl border border-border bg-surface pl-2 pr-3 transition-colors hover:border-border-strong hover:bg-surface-2"
              data-testid="league-chip"
            >
              <span className="grid size-8 place-items-center rounded-lg bg-surface-3 text-fg-muted">
                <SportIcon sport={l.sportKey} className="size-4" />
              </span>
              <span className="whitespace-nowrap text-sm font-semibold">{l.name}</span>
              <span className="tabular text-xs text-fg-subtle">{l.eventCount}</span>
            </Link>
          ))}
        </div>
      </nav>
    </section>
  );
}
