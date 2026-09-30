'use client';

import type { CasinoTheme } from '@storm-bet/types';
import { cn } from '@storm-bet/ui';
import {
  ArrowUpDown,
  Bomb,
  Club,
  Dices,
  Grid3x3,
  Coins,
  Crown,
  Disc3,
  Gem,
  Grip,
  Moon,
  Rocket,
  Spade,
  Sparkles,
  Waves,
  Zap,
} from 'lucide-react';
import { useT } from '@/i18n/client';

const MOTIF = {
  bolt: Zap,
  gem: Gem,
  crown: Crown,
  star: Sparkles,
  wave: Waves,
  moon: Moon,
  wheel: Disc3,
  cards: Spade,
  chip: Coins,
  rocket: Rocket,
  bomb: Bomb,
  pegs: Grip,
  dice: Dices,
  balls: Grid3x3,
  arrows: ArrowUpDown,
  spades: Club,
} as const;

/** Generated cover art: gradient, glow, fine grid and the game's motif. No image files. */
export function GameCover({
  theme,
  name,
  className,
  large = false,
}: {
  theme: CasinoTheme;
  name: string;
  className?: string;
  large?: boolean;
}) {
  const t = useT();
  const Icon = MOTIF[theme.motif] ?? Sparkles;
  return (
    <div
      className={cn('relative isolate overflow-hidden', className)}
      style={{ background: `linear-gradient(135deg, ${theme.from}, ${theme.to})` }}
      role="img"
      aria-label={t('Cover {0}', [t(name)])}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-60"
        style={{
          background: `radial-gradient(circle at 75% 20%, ${theme.accent}55, transparent 45%), radial-gradient(circle at 10% 110%, #00000088, transparent 55%)`,
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-[0.12] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:22px_22px]"
      />
      <Icon
        aria-hidden="true"
        strokeWidth={1.25}
        className={cn(
          'absolute drop-shadow-[0_6px_18px_rgba(0,0,0,0.45)] transition-transform duration-500 group-hover:scale-110 group-hover:rotate-3',
          large ? 'right-6 top-6 size-28' : 'right-3 top-3 size-16',
        )}
        style={{ color: theme.accent }}
      />
      {/* Small covers sit on a card that names the game already. */}
      {large ? (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-4 pt-10">
          <p className="text-3xl font-semibold leading-tight tracking-tight text-white drop-shadow">
            {name}
          </p>
        </div>
      ) : null}
    </div>
  );
}
