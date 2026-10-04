'use client';

import type { LeagueDto } from '@storm-bet/types';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { SportIcon } from '../sportsbook/sport-icon';

/** The busiest competitions, two rows to swipe through. */
export function LeagueChips({ leagues }: { leagues: LeagueDto[] }) {
  const t = useT();
  if (leagues.length === 0) return null;
  return (
    <nav aria-label={t('Wettbewerbe')} className="-mx-4 lg:mx-0">
      <div className="grid auto-cols-max grid-flow-col grid-rows-2 gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:px-0 [&::-webkit-scrollbar]:hidden">
        {leagues.map((l) => (
          <Link
            key={l.id}
            href={`/sports/${l.sportKey}?league=${l.id}`}
            className="flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 transition-colors hover:border-border-strong hover:bg-surface-2"
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
  );
}
