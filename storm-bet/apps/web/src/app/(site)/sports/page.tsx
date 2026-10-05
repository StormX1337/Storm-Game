import type { EventSummaryDto, Paginated, SportDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EventList } from '@/components/sportsbook/event-list';
import { LiveDot } from '@/components/sportsbook/live-indicator';
import { PageHeader, SectionTitle } from '@/components/sportsbook/page-header';
import { SportIcon } from '@/components/sportsbook/sport-icon';
import { getPlatformMeta, tryServerApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Sportarten') };
}
export const dynamic = 'force-dynamic';

export default async function SportsPage() {
  const t = await getT();
  const { odds } = await getPlatformMeta();
  const within = odds.isSimulated ? 12 : 72;
  const [sports, upcoming] = await Promise.all([
    tryServerApi<SportDto[]>('/sports'),
    tryServerApi<Paginated<EventSummaryDto>>(
      `/events?status=upcoming&withinHours=${within}&limit=30`,
    ),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader
        title={t('Sportarten')}
        description={t('Alle verfügbaren Sportarten und die nächsten Events. {0}', [
          odds.isSimulated ? t('Sämtliche Daten sind simuliert.') : t('Quoten: {0}.', [odds.name]),
        ])}
      />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 2xl:grid-cols-4">
        {(sports ?? []).map((s) => (
          <Link
            key={s.key}
            href={`/sports/${s.key}`}
            className="group flex items-center gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong hover:bg-surface-2"
            data-testid="sport-card"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-3 text-fg-muted transition-colors group-hover:text-accent-strong">
              <SportIcon sport={s.key} className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{t(s.name)}</span>
              <span className="flex items-center gap-2 text-xs text-fg-muted">
                <span className="tabular">
                  {s.eventCount} {t('Events')}
                </span>
                {s.liveCount ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-live">
                    <LiveDot /> {s.liveCount}
                  </span>
                ) : null}
              </span>
            </span>
          </Link>
        ))}
      </div>
      <SectionTitle>{t('Die nächsten Events')}</SectionTitle>
      <EventList events={upcoming?.items ?? []} emptyTitle={t('Keine anstehenden Events')} />
    </div>
  );
}
