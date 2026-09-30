'use client';

import type { CasinoGameDto, CasinoLobbyDto } from '@storm-bet/types';
import { cn, EmptyState, Input } from '@storm-bet/ui';
import { Search, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { GameCard } from './game-card';
import { useT } from '@/i18n/client';

function Section({
  title,
  games,
  onFavorite,
}: {
  title: string;
  games: CasinoGameDto[];
  onFavorite: (id: string, fav: boolean) => void;
}) {
  if (games.length === 0) return null;
  return (
    <section className="space-y-3" aria-label={title}>
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
        {games.map((g) => (
          <GameCard key={g.id} game={g} onFavoriteChange={onFavorite} />
        ))}
      </div>
    </section>
  );
}

/** Casino lobby: search, category chips and curated rows, all client-side on one payload. */
export function CasinoLobby({ lobby }: { lobby: CasinoLobbyDto }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [favorites, setFavorites] = useState(
    () => new Set(lobby.games.filter((g) => g.isFavorite).map((g) => g.id)),
  );
  const games = useMemo(
    () => lobby.games.map((g) => ({ ...g, isFavorite: favorites.has(g.id) })),
    [lobby.games, favorites],
  );
  const onFavorite = (id: string, fav: boolean) =>
    setFavorites((prev) => {
      const next = new Set(prev);
      if (fav) next.add(id);
      else next.delete(id);
      return next;
    });

  const search = query.trim().toLowerCase();
  const filtered = games.filter(
    (g) =>
      (category === 'all' ||
        (category === 'favorites' ? g.isFavorite : g.categories.includes(category))) &&
      (!search ||
        g.name.toLowerCase().includes(search) ||
        g.provider.name.toLowerCase().includes(search)),
  );
  const byId = new Map(games.map((g) => [g.id, g]));
  const popular = lobby.popular.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  const chips = [
    { key: 'all', name: t('Alle') },
    { key: 'favorites', name: t('Favoriten{0}', [favorites.size ? ` (${favorites.size})` : '']) },
    ...lobby.categories.filter((c) => c.gameCount > 0),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Spiel oder Anbieter suchen')}
            aria-label={t('Spiele suchen')}
            className="pl-9"
          />
        </div>
        <div
          className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0"
          role="tablist"
          aria-label={t('Kategorien')}
        >
          {chips.map((c) => (
            <button
              key={c.key}
              role="tab"
              aria-selected={category === c.key}
              onClick={() => setCategory(c.key)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors',
                category === c.key
                  ? 'border-accent/40 bg-accent-soft text-fg'
                  : 'border-border bg-surface text-fg-muted hover:text-fg',
              )}
            >
              {t(c.name)}
            </button>
          ))}
        </div>
      </div>

      {category === 'all' && !search ? (
        <>
          <Section
            title={t('Empfohlen')}
            games={games.filter((g) => g.isFeatured)}
            onFavorite={onFavorite}
          />
          <Section title={t('Beliebt')} games={popular.slice(0, 8)} onFavorite={onFavorite} />
          <Section title={t('Neu')} games={games.filter((g) => g.isNew)} onFavorite={onFavorite} />
          {lobby.categories
            .filter((c) => c.gameCount > 0)
            .map((c) => (
              <Section
                key={c.key}
                title={t(c.name)}
                games={games.filter((g) => g.categories.includes(c.key))}
                onFavorite={onFavorite}
              />
            ))}
        </>
      ) : filtered.length ? (
        <Section
          title={chips.find((c) => c.key === category)?.name ?? t('Ergebnisse')}
          games={filtered}
          onFavorite={onFavorite}
        />
      ) : (
        <EmptyState
          icon={<Sparkles />}
          title={category === 'favorites' ? t('Noch keine Favoriten') : t('Keine Spiele gefunden')}
          description={
            category === 'favorites'
              ? t('Tippe auf das Herz eines Spiels, um es hier zu sammeln.')
              : t('Versuche einen anderen Suchbegriff.')
          }
        />
      )}
    </div>
  );
}
