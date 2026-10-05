import type { EventDetailDto, EventSummaryDto, Paginated } from '@storm-bet/types';
import { Layers } from 'lucide-react';
import type { Metadata } from 'next';
import { BetBuilderCard } from '@/components/home/bet-builder-card';
import { SectionHeader } from '@/components/home/section-header';
import { EventList } from '@/components/sportsbook/event-list';
import { getPlatformMeta, tryServerApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Bet Builder') };
}
export const dynamic = 'force-dynamic';

const STEPS = [
  { title: 'Spiel wählen', text: 'Ein Fußballspiel vor dem Anpfiff oder live.' },
  { title: 'Tipps kombinieren', text: 'Sieger, Tore, beide treffen, Ecken, Karten …' },
  { title: 'Eine Quote', text: 'Der Server berechnet den Preis für die Kombination.' },
];

/** Bet Builder hub: how it works, ready-made combinations, matches to build on. */
export default async function BetBuilderPage() {
  const t = await getT();
  const { odds } = await getPlatformMeta();
  const within = odds.isSimulated ? 24 : 72;
  const upcoming = await tryServerApi<Paginated<EventSummaryDto>>(
    `/events?sport=football&status=upcoming&withinHours=${within}&limit=30`,
  );
  const events = (upcoming?.items ?? []).filter((e) => e.mainMarket !== null);
  const details = (
    await Promise.all(
      events.slice(0, 3).map((e) => tryServerApi<EventDetailDto>(`/events/${e.id}`)),
    )
  ).filter((d): d is EventDetailDto => d !== null);

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand text-white">
          <Layers className="size-6" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{t('Bet Builder')}</h1>
          <p className="text-sm text-fg-muted">
            {t('Mehrere Tipps auf ein Spiel – eine Wette, eine Quote.')}
          </p>
        </div>
      </header>
      <ol className="grid gap-2.5 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="flex gap-3 rounded-xl border border-border bg-surface p-3"
          >
            <span className="tabular grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent-strong">
              {i + 1}
            </span>
            <span>
              <span className="block text-sm font-semibold">{t(step.title)}</span>
              <span className="block text-xs text-fg-muted">{t(step.text)}</span>
            </span>
          </li>
        ))}
      </ol>
      {details.length ? (
        <section className="space-y-3" aria-labelledby="builder-picks-title">
          <SectionHeader id="builder-picks-title" title={t('Fertige Kombinationen')} />
          <div className="space-y-3">
            {details.map((event) => (
              <BetBuilderCard key={event.id} event={event} />
            ))}
          </div>
        </section>
      ) : null}
      <section className="space-y-3" aria-labelledby="builder-matches-title">
        <SectionHeader id="builder-matches-title" title={t('Spiele für deinen Bet Builder')} />
        <EventList
          events={events}
          emptyTitle={t('Keine anstehenden Events')}
          emptyDescription={t(
            'Bet Builder gibt es für Fußballspiele – schau später wieder vorbei.',
          )}
        />
      </section>
    </div>
  );
}
