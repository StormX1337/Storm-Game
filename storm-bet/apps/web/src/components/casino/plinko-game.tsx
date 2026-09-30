'use client';

import type { CasinoGameDto, PlinkoResult, PlinkoRisk } from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { useEffect, useState } from 'react';
import { formatMoney } from '@/lib/format';
import { GameShell, StakeControl, useCasinoPlay } from './controls';
import { useT } from '@/i18n/client';

const ROWS = 12;
/** Must match the server's tables (packages/casino/src/games/plinko.ts). */
const HALF: Record<PlinkoRisk, number[]> = {
  low: [8.4, 2.9, 1.6, 1.3, 1.1, 1.0, 0.5],
  medium: [28, 9, 3.7, 1.8, 1.1, 0.6, 0.4],
  high: [160, 25, 8, 2, 0.6, 0.2, 0.2],
};
const table = (risk: PlinkoRisk) => [...HALF[risk], ...HALF[risk].slice(0, -1).reverse()];
const RISKS: [PlinkoRisk, string][] = [
  ['low', 'Niedrig'],
  ['medium', 'Mittel'],
  ['high', 'Hoch'],
];

export function PlinkoGame({ game, sessionId }: { game: CasinoGameDto; sessionId: string }) {
  const t = useT();
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [stake, setStake] = useState(Math.max(game.minStake, 100));
  const [risk, setRisk] = useState<PlinkoRisk>('medium');
  const [last, setLast] = useState<{ result: PlinkoResult; payout: number } | null>(null);
  const [row, setRow] = useState(ROWS);

  // The ball steps down its (server-drawn) path.
  useEffect(() => {
    if (!last) return;
    setRow(0);
    const timer = window.setInterval(() => {
      setRow((r) => {
        if (r >= ROWS) window.clearInterval(timer);
        return Math.min(ROWS, r + 1);
      });
    }, 110);
    return () => window.clearInterval(timer);
  }, [last]);

  const drop = async () => {
    const res = await play({ action: 'drop', stake, risk });
    if (res) setLast({ result: res.round.result as PlinkoResult, payout: res.round.payout });
  };

  const rights = last ? last.result.path.slice(0, row).filter((p) => p === 'R').length : 0;
  const ball = last ? { row, col: rights } : null;
  const landed = last !== null && row >= ROWS;
  const multipliers = table(last?.result.risk ?? risk);

  const area = (
    <div className="bg-[radial-gradient(ellipse_at_top,#1e3a8a,#020617)] p-4 sm:p-6">
      <div className="mx-auto max-w-lg space-y-1.5">
        {Array.from({ length: ROWS }, (_, r) => (
          <div key={r} className="flex justify-center gap-[3%]">
            {Array.from({ length: r + 3 }, (_, c) => {
              const here = ball && ball.row === r + 1 && ball.col === c && !landed;
              return (
                <span
                  key={c}
                  className={cn(
                    'size-1.5 rounded-full bg-white/40 sm:size-2',
                    here && 'size-3 bg-orange-400 shadow-[0_0_10px_#fb923c] sm:size-3.5',
                  )}
                />
              );
            })}
          </div>
        ))}
        <div
          className="grid gap-0.5 pt-2"
          style={{ gridTemplateColumns: `repeat(${ROWS + 1}, minmax(0, 1fr))` }}
        >
          {multipliers.map((m, i) => (
            <span
              key={i}
              className={cn(
                'tabular rounded py-1 text-center text-[9px] font-semibold sm:text-[11px]',
                m >= 2
                  ? 'bg-orange-500/30 text-orange-200'
                  : m >= 1
                    ? 'bg-sky-500/20 text-sky-200'
                    : 'bg-white/5 text-white/50',
                landed &&
                  last.result.bucket === i &&
                  'bg-orange-400 text-black ring-2 ring-orange-200',
              )}
            >
              {m}×
            </span>
          ))}
        </div>
        <p className="pt-2 text-center text-sm text-white/70" aria-live="polite">
          {!last
            ? t('Die Kugel fällt zufällig nach links oder rechts.')
            : !landed
              ? t('Fällt …')
              : last.payout > 0
                ? `${last.result.multiplier}× · ${formatMoney(last.payout)}`
                : t('{0}× – kein Gewinn', [last.result.multiplier])}
        </p>
      </div>
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
      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t('Risiko')}>
        {RISKS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={risk === key}
            onClick={() => setRisk(key)}
            className={cn(
              'rounded-md border py-1.5 text-sm',
              risk === key
                ? 'border-accent bg-accent-soft text-fg'
                : 'border-border text-fg-muted hover:text-fg',
            )}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <Button
        size="lg"
        className="w-full"
        onClick={drop}
        disabled={busy || (last !== null && !landed)}
        data-testid="plinko-drop"
        data-play
      >
        {busy ? t('Fällt …') : t('Kugel fallen lassen')}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
