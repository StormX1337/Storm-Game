'use client';

import type { CasinoGameDto, WheelResult } from '@storm-bet/types';
import { Button } from '@storm-bet/ui';
import { useMemo, useState } from 'react';
import { formatMoney } from '@/lib/format';
import { GameShell, StakeControl, useCasinoPlay } from './controls';
import { useT } from '@/i18n/client';

/** The server's 50 segments (display only), spread the same way. */
const PRIZES = [7, 1.5, 2, 1.5, 3, 1.5, 2, 1.5, 5, 1.5, 2, 3, 1.5, 2, 1.5, 3, 2, 1.5, 2, 1.5, 1.5];
const SEGMENTS = Array.from({ length: 50 }, (_, i) =>
  Math.floor(((i + 1) * PRIZES.length) / 50) > Math.floor((i * PRIZES.length) / 50)
    ? PRIZES[Math.floor((i * PRIZES.length) / 50)]!
    : 0,
);
const COLORS: Record<number, string> = {
  0: '#1f2937',
  1.5: '#0ea5e9',
  2: '#22c55e',
  3: '#a855f7',
  5: '#f97316',
  7: '#facc15',
};

export function WheelGame({ game, sessionId }: { game: CasinoGameDto; sessionId: string }) {
  const t = useT();
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [stake, setStake] = useState(Math.max(game.minStake, 100));
  const [turn, setTurn] = useState(0);
  const [last, setLast] = useState<{ result: WheelResult; payout: number } | null>(null);
  const [spinning, setSpinning] = useState(false);

  const gradient = useMemo(
    () =>
      `conic-gradient(${SEGMENTS.map(
        (m, i) => `${COLORS[m] ?? '#334155'} ${i * 7.2}deg ${(i + 1) * 7.2}deg`,
      ).join(', ')})`,
    [],
  );

  const spin = async () => {
    const res = await play({ action: 'spin', stake });
    if (!res) return;
    const result = res.round.result as WheelResult;
    // Land the segment's centre under the pointer at the top, after a few turns.
    const target = 360 - (result.segment * 7.2 + 3.6);
    setSpinning(true);
    setTurn((deg) => deg - (deg % 360) + 360 * 5 + target);
    window.setTimeout(() => {
      setSpinning(false);
      setLast({ result, payout: res.round.payout });
    }, 3_200);
  };

  const area = (
    <div className="grid place-items-center bg-[radial-gradient(ellipse_at_center,#78350f,#020617)] p-6">
      <div className="relative size-64 sm:size-72">
        <div
          className="absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1 border-x-[10px] border-t-[18px] border-x-transparent border-t-white drop-shadow"
          aria-hidden="true"
        />
        <div
          className="size-full rounded-full border-4 border-white/20 shadow-2xl"
          style={{
            background: gradient,
            transform: `rotate(${turn}deg)`,
            transition: spinning ? 'transform 3s cubic-bezier(0.15, 0.85, 0.25, 1)' : 'none',
          }}
          aria-hidden="true"
        />
        <div className="absolute inset-[38%] grid place-items-center rounded-full bg-slate-950/90 text-center">
          <span
            className="tabular text-lg font-bold text-white"
            aria-live="polite"
            data-testid="wheel-result"
          >
            {spinning || !last ? '?' : `${last.result.multiplier}×`}
          </span>
        </div>
      </div>
      <p className="mt-4 text-sm text-white/70">
        {spinning
          ? t('Das Rad dreht sich …')
          : last
            ? last.payout > 0
              ? t('Gewonnen: {0}', [formatMoney(last.payout)])
              : t('Leider nichts.')
            : t('Bis zu 7-facher Einsatz.')}
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
        disabled={busy || spinning}
      />
      <div className="flex flex-wrap gap-1.5 text-xs">
        {[7, 5, 3, 2, 1.5, 0].map((m) => (
          <span key={m} className="flex items-center gap-1 rounded bg-surface-2 px-2 py-1">
            <span className="size-2.5 rounded-full" style={{ background: COLORS[m] }} />
            {m}× · {SEGMENTS.filter((s) => s === m).length}/50
          </span>
        ))}
      </div>
      <Button
        size="lg"
        className="w-full"
        onClick={spin}
        disabled={busy || spinning}
        data-testid="wheel-spin"
        data-play
      >
        {busy || spinning ? t('Dreht …') : t('Drehen')}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
