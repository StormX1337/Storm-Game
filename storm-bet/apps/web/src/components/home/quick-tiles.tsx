'use client';

import type { CasinoTheme } from '@storm-bet/types';
import { Disc3, Layers, Radio, Rocket, Users, Zap } from 'lucide-react';
import Link from 'next/link';
import { useT } from '@/i18n/client';
import { GameCover } from '../casino/game-cover';

export interface QuickTile {
  href: string;
  label: string;
  /** Casino tiles show the game's cover; the others an icon on a gradient. */
  theme?: CasinoTheme;
  icon?: 'boost' | 'builder' | 'feed' | 'live' | 'crash' | 'wheel';
  gradient?: string;
}

const ICONS = {
  boost: Zap,
  builder: Layers,
  feed: Users,
  live: Radio,
  crash: Rocket,
  wheel: Disc3,
};

/** Shortcuts row: games and features, swiped sideways on phones. */
export function QuickTiles({ tiles }: { tiles: QuickTile[] }) {
  const t = useT();
  return (
    <nav aria-label={t('Schnellzugriff')} className="-mx-4 lg:mx-0">
      <div className="flex gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:px-0 [&::-webkit-scrollbar]:hidden">
        {tiles.map((tile) => {
          const Icon = tile.icon ? ICONS[tile.icon] : null;
          return (
            <Link
              key={tile.href + tile.label}
              href={tile.href}
              className="group relative h-32 w-28 shrink-0 overflow-hidden rounded-xl border border-border sm:h-36 sm:w-32"
              data-testid="quick-tile"
            >
              {tile.theme ? (
                <GameCover theme={tile.theme} name={tile.label} className="absolute inset-0" />
              ) : (
                <div
                  className="absolute inset-0 grid place-items-center"
                  style={{ background: tile.gradient }}
                >
                  {Icon ? <Icon className="size-10 text-white/90" aria-hidden="true" /> : null}
                </div>
              )}
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-2 pt-6 text-sm font-semibold leading-tight text-white">
                {t(tile.label)}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
