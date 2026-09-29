'use client';

import type { CasinoGameDto } from '@storm-bet/types';
import { Badge, Button, Card, cn, toast } from '@storm-bet/ui';
import { Heart, Play } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { GameCover } from './game-cover';
import { GAME_TYPE_LABELS } from './labels';

export function GameCard({
  game,
  onFavoriteChange,
}: {
  game: CasinoGameDto;
  onFavoriteChange?: (id: string, favorite: boolean) => void;
}) {
  const [favorite, setFavorite] = useState(game.isFavorite);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const next = !favorite;
    setFavorite(next);
    try {
      await api(`/casino/favorites/${game.id}`, { method: next ? 'POST' : 'DELETE' });
      onFavoriteChange?.(game.id, next);
      toast.success(next ? `${game.name} gemerkt` : `${game.name} entfernt`);
    } catch (error) {
      setFavorite(!next);
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const unavailable = game.status !== 'ACTIVE';
  return (
    <Card
      className="group overflow-hidden transition-transform duration-200 hover:-translate-y-0.5"
      data-testid="game-card"
    >
      <Link href={`/casino/${game.id}`} className="block" aria-label={`${game.name} öffnen`}>
        <GameCover theme={game.theme} name={game.name} className="aspect-[4/3]" />
      </Link>
      <div className="space-y-2.5 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{game.name}</p>
            <p className="truncate text-xs text-fg-subtle">
              {game.provider.name} · {GAME_TYPE_LABELS[game.type]}
            </p>
          </div>
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            aria-pressed={favorite}
            aria-label={favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
            className="grid size-8 shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <Heart className={cn('size-4', favorite && 'fill-down text-down')} />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          {game.isNew ? <Badge variant="accent">Neu</Badge> : null}
          {game.categories.includes('live-casino') ? (
            <Badge variant="outline">Automatisiert</Badge>
          ) : null}
          {unavailable ? <Badge variant="warning">Wartung</Badge> : null}
          <Button asChild size="sm" className="ml-auto" disabled={unavailable}>
            <Link href={`/casino/${game.id}`}>
              <Play /> Demo spielen
            </Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}
