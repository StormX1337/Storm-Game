'use client';

import type { CasinoGameDto, DiceResult } from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { GameShell, StakeControl, useCasinoPlay } from './controls';
import { useT } from '@/i18n/client';

/** Same formula as the server: 97 % ÷ chance, cut to hundredths. */
const multiplierFor = (chance: number) => Math.floor(9700 / chance) / 100;

export function DiceGame({ game, sessionId }: { game: CasinoGameDto; sessionId: string }) {
  const t = useT();
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [stake, setStake] = useState(Math.max(game.minStake, 100));
  const [chance, setChance] = useState(50);
  const [direction, setDirection] = useState<'under' | 'over'>('under');
  const [last, setLast] = useState<{ result: DiceResult; payout: number } | null>(null);
  const threshold = direction === 'under' ? chance : 100 - chance;

  const roll = async () => {
    const res = await play({ action: 'roll', stake, chance, direction });
    if (res) setLast({ result: res.round.result as DiceResult, payout: res.round.payout });
  };

  const area = (
    <div className="bg-[radial-gradient(ellipse_at_top,#155e75,#020617)] px-5 py-8 sm:px-10">
      <p
        className={cn(
          'tabular text-center text-6xl font-bold tracking-tight',
          !last ? 'text-white/40' : last.result.won ? 'text-emerald-300' : 'text-red-300',
        )}
        aria-live="polite"
        data-testid="dice-roll"
      >
        {last ? last.result.roll.toFixed(2) : '–'}
      </p>
      <div className="relative mx-auto mt-8 h-3 max-w-md rounded-full bg-red-500/40">
        <div
          className="absolute inset-y-0 rounded-full bg-emerald-400/70"
          style={
            direction === 'under'
              ? { left: 0, width: `${threshold}%` }
              : { left: `${threshold}%`, right: 0 }
          }
        />
        {last ? (
          <div
            className="absolute -top-2 h-7 w-1 -translate-x-1/2 rounded bg-white shadow"
            style={{ left: `${last.result.roll}%` }}
          />
        ) : null}
      </div>
      <p className="mt-4 text-center text-sm text-white/70">
        {t('Gewinn bei')} {direction === 'under' ? 'unter' : 'mindestens'} {threshold.toFixed(2)} ·{' '}
        {multiplierFor(chance).toFixed(2)}×
        {last ? ` · ${last.result.won ? `+${formatMoney(last.payout)}` : 'verloren'}` : ''}
      </p>
    </div>
  );

  const controls = (
    <>
      <StakeControl
        value={stake}
        onChange={setStake}
        min={game.minStake}
        max={game.maxStake}
        disabled={busy}
      />
      <div className="space-y-2">
        <div className="flex justify-between text-xs text-fg-muted">
          <span>{t('Gewinnchance')}</span>
          <span className="tabular">
            {chance} % · {multiplierFor(chance).toFixed(2)}×
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={95}
          value={chance}
          onChange={(e) => setChance(Number(e.target.value))}
          className="w-full accent-[var(--color-accent)]"
          aria-label={t('Gewinnchance in Prozent')}
          disabled={busy}
        />
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label={t('Richtung')}>
          {(['under', 'over'] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={direction === d}
              onClick={() => setDirection(d)}
              className={cn(
                'rounded-md border py-1.5 text-sm',
                direction === d
                  ? 'border-accent bg-accent-soft text-fg'
                  : 'border-border text-fg-muted hover:text-fg',
              )}
            >
              {d === 'under' ? t('Darunter') : t('Darüber')}
            </button>
          ))}
        </div>
      </div>
      <Button
        size="lg"
        className="w-full"
        onClick={roll}
        disabled={busy}
        data-testid="dice-play"
        data-play
      >
        {busy ? t('Würfelt …') : t('Würfeln')}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
