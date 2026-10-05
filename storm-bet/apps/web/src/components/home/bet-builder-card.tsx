'use client';

import type { EventDetailDto } from '@storm-bet/types';
import { ChevronRight, Layers } from 'lucide-react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { formatKickoff } from '@/lib/format';
import { BuilderSuggestions } from '../sportsbook/builder-suggestions';

/** Bet Builder for one match: ready-made combinations at the model's combined price. */
export function BetBuilderCard({ event }: { event: EventDetailDto }) {
  const t = useT();
  return (
    <BuilderSuggestions
      event={event}
      className="bg-brand-soft"
      header={
        <div className="flex items-center gap-3 border-b border-border p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand text-white">
            <Layers className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-accent-strong">
              {t('Bet Builder')}
            </p>
            <p className="truncate text-[15px] font-bold tracking-tight">
              {event.home.name} – {event.away.name}
            </p>
            <p className="truncate text-xs text-fg-muted">
              {t(formatKickoff(event.startTime))} · {event.league.name}
            </p>
          </div>
          <Link
            href={`/events/${event.id}`}
            className="flex shrink-0 items-center gap-0.5 text-[13px] font-semibold text-accent-strong hover:text-fg"
          >
            <span className="max-sm:sr-only">{t('Selbst bauen')}</span>
            <ChevronRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      }
    />
  );
}
