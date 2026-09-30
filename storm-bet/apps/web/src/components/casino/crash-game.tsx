'use client';

import type { CasinoGameDto, CrashResult } from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { useEffect, useRef, useState } from 'react';
import { formatMoney } from '@/lib/format';
import { GameShell, StakeControl, useCasinoPlay } from './controls';

const TARGETS = [1.5, 2, 3, 5, 10];

/** Counts the multiplier up to the server's crash point (the result is known). */
function useClimb(to: number | null) {
  const [value, setValue] = useState(1);
  const frame = useRef(0);
  useEffect(() => {
    if (to === null) return;
    const duration = Math.min(4_000, 600 + Math.log(to) * 1_200);
    const start = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      setValue(Math.exp(Math.log(to) * k));
      if (k < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [to]);
  return value;
}

export function CrashGame({ game, sessionId }: { game: CasinoGameDto; sessionId: string }) {
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [stake, setStake] = useState(Math.max(game.minStake, 100));
  const [target, setTarget] = useState('2.00');
  const [last, setLast] = useState<{ result: CrashResult; payout: number } | null>(null);
  const shown = useClimb(last?.result.crashPoint ?? null);
  const done = last !== null && shown >= last.result.crashPoint - 1e-9;
  const targetValue = Number(target.replace(',', '.'));
  const valid = Number.isFinite(targetValue) && targetValue >= 1.01 && targetValue <= 100;

  const start = async () => {
    setLast(null);
    const res = await play({ action: 'play', stake, target: Math.round(targetValue * 100) / 100 });
    if (res) setLast({ result: res.round.result as CrashResult, payout: res.round.payout });
  };

  const area = (
    <div className="grid min-h-72 place-items-center bg-[radial-gradient(ellipse_at_bottom,#312e81,#020617)] p-6">
      <div className="text-center" aria-live="polite">
        <p
          className={cn(
            'tabular text-6xl font-bold tracking-tight transition-colors sm:text-7xl',
            !last
              ? 'text-white/40'
              : !done
                ? 'text-white'
                : last.result.won
                  ? 'text-up'
                  : 'text-down',
          )}
          data-testid="crash-multiplier"
        >
          {(last ? shown : 1).toFixed(2)}×
        </p>
        <p className="mt-3 text-sm text-white/70">
          {!last
            ? `Ziel: ${valid ? targetValue.toFixed(2) : '–'}× · Auszahlung, wenn der Kurs das Ziel erreicht`
            : !done
              ? 'Steigt …'
              : last.result.won
                ? `Ausgestiegen bei ${last.result.target.toFixed(2)}× · Gewinn ${formatMoney(last.payout)} (Crash bei ${last.result.crashPoint.toFixed(2)}×)`
                : `Crash bei ${last.result.crashPoint.toFixed(2)}× – Ziel ${last.result.target.toFixed(2)}× nicht erreicht`}
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
      <div className="space-y-2">
        <label
          className="flex items-center justify-between text-xs text-fg-muted"
          htmlFor="crash-target"
        >
          Aussteigen bei <span>1,01× – 100×</span>
        </label>
        <input
          id="crash-target"
          inputMode="decimal"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="tabular h-10 w-full rounded-md border border-border-strong bg-surface-2 px-3 text-right text-sm font-semibold focus-visible:border-accent focus-visible:outline-none"
          data-testid="crash-target"
        />
        <div className="flex flex-wrap gap-1.5">
          {TARGETS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTarget(t.toFixed(2))}
              className="tabular rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg-muted hover:text-fg"
            >
              {t}×
            </button>
          ))}
        </div>
      </div>
      <Button
        size="lg"
        className="w-full"
        onClick={start}
        disabled={busy || !valid || (last !== null && !done)}
        data-testid="crash-play"
        data-play
      >
        {busy ? 'Startet …' : 'Starten'}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
