import type { FeedItemDto, Paginated } from '@storm-bet/types';
import { EmptyState } from '@storm-bet/ui';
import { Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FeedList } from '@/components/feed/feed-list';
import { PageHeader } from '@/components/sportsbook/page-header';
import { getT } from '@/i18n/server';
import { getSessionUser, serverApi } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Tipp-Feed') };
}

const FILTERS = [
  { key: 'all', label: 'Alle' },
  { key: 'following', label: 'Gefolgt' },
  { key: 'open', label: 'Offen' },
  { key: 'won', label: 'Gewonnen' },
] as const;

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const t = await getT();
  if (!(await getSessionUser())) redirect('/login?next=/feed');
  const { filter: raw } = await searchParams;
  const filter = FILTERS.some((f) => f.key === raw) ? raw! : 'all';
  const first = await serverApi<Paginated<FeedItemDto>>(`/feed?filter=${filter}&limit=20`);
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('Tipp-Feed')}
        description={t(
          'Wettscheine, die andere Spieler teilen – mit Quoten und Ergebnis, ohne Einsätze. Übernimm offene Tipps zu den aktuellen Quoten.',
        )}
      />
      <nav className="flex flex-wrap gap-2" aria-label={t('Filter')}>
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/feed?filter=${f.key}`}
            className={
              filter === f.key
                ? 'rounded-full border border-accent bg-accent-soft px-3 py-1.5 text-sm text-fg'
                : 'rounded-full border border-border px-3 py-1.5 text-sm text-fg-muted hover:text-fg'
            }
          >
            {t(f.label)}
          </Link>
        ))}
      </nav>
      {first.items.length === 0 ? (
        filter === 'following' ? (
          <EmptyState
            icon={<Users />}
            title={t('Noch nichts von Spielern, denen du folgst')}
            description={t(
              'Tippe bei einem Tipp auf „Folgen“ – neue Tipps dieser Spieler erscheinen dann hier.',
            )}
          />
        ) : (
          <EmptyState
            icon={<Users />}
            title={t('Noch keine geteilten Tipps')}
            description={t(
              'Teile eine deiner Wetten unter „Meine Wetten“ – sie erscheint dann hier.',
            )}
          />
        )
      ) : (
        <FeedList initial={first} filter={filter} />
      )}
    </div>
  );
}
