'use client';

import type { CasinoGameDto, KenoResult } from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { useEffect, useState } from 'react';
import { formatMoney } from '@/lib/format';
import { GameShell, StakeControl, useCasinoPlay } from './controls';

/** The server's table (display only): return per unit by picks and hits. */
const PAYTABLE: Record<number, Record<number, number>> = {
  1: { 1: 3.8 },
  2: { 1: 1.3, 2: 8 },
  3: { 1: 0.7, 2: 2.5, 3: 25 },
  4: { 2: 2.1, 3: 8.5, 4: 80 },
  5: { 2: 1.1, 3: 4, 4: 23, 5: 300 },
  6: { 2: 0.6, 3: 2.4, 4: 10.5, 5: 85, 6: 1000 },
  7: { 3: 1.8, 4: 6.2, 5: 37, 6: 360, 7: 3000 },
  8: { 3: 1.3, 4: 3.8, 5: 16, 6: 110, 7: 900, 8: 5000 },
  9: { 3: 0.8, 4: 2.4, 5: 10.5, 6: 52, 7: 300, 8: 2500, 9: 10000 },
  10: { 3: 0.6, 4: 1.6, 5: 6, 6: 28, 7: 140, 8: 950, 9: 4800, 10: 10000 },
};

export function KenoGame({ game, sessionId }: { game: CasinoGameDto; sessionId: string }) {
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [stake, setStake] = useState(Math.max(game.minStake, 100));
  const [picks, setPicks] = useState<number[]>([]);
  const [last, setLast] = useState<{ result: KenoResult; payout: number } | null>(null);
  const [shown, setShown] = useState(0);

  // Reveal the drawn numbers one by one (the result is already decided).
  useEffect(() => {
    if (!last) return;
    setShown(0);
    const timer = window.setInterval(() => {
      setShown((n) => {
        if (n >= last.result.drawn.length) window.clearInterval(timer);
        return Math.min(n + 1, last.result.drawn.length);
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, [last]);
  const drawn = last ? last.result.drawn.slice(0, shown) : [];
  const done = last !== null && shown >= last.result.drawn.length;

  const toggle = (n: number) => {
    setLast(null);
    setPicks((p) => (p.includes(n) ? p.filter((x) => x !== n) : p.length < 10 ? [...p, n] : p));
  };
  const quick = () => {
    const pool = Array.from({ length: 40 }, (_, i) => i + 1);
    const out: number[] = [];
    while (out.length < 5) {
      const n = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!;
      out.push(n);
    }
    setLast(null);
    setPicks(out);
  };
  const start = async () => {
    const res = await play({ action: 'play', stake, picks });
    if (res) setLast({ result: res.round.result as KenoResult, payout: res.round.payout });
  };

  const area = (
    <div className="bg-[radial-gradient(ellipse_at_top,#581c87,#020617)] p-4 sm:p-6">
      <div className="mx-auto grid max-w-md grid-cols-8 gap-1.5" data-testid="keno-board">
        {Array.from({ length: 40 }, (_, i) => i + 1).map((n) => {
          const picked = picks.includes(n);
          const hit = picked && drawn.includes(n);
          const out = drawn.includes(n);
          return (
            <button
              key={n}
              type="button"
              onClick={() => toggle(n)}
              disabled={busy}
              className={cn(
                'tabular aspect-square rounded-md border text-xs font-semibold transition-colors',
                hit
                  ? 'border-emerald-300 bg-emerald-500 text-white'
                  : picked
                    ? 'border-amber-300 bg-amber-400/30 text-white'
                    : out
                      ? 'border-white/30 bg-white/25 text-white'
                      : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/15',
              )}
              aria-pressed={picked}
              data-testid="keno-number"
            >
              {n}
            </button>
          );
        })}
      </div>
      <p className="mt-4 text-center text-sm text-white/70" aria-live="polite">
        {!last
          ? `${picks.length} von 10 gewählt`
          : !done
            ? 'Ziehung läuft …'
            : `${last.result.hits.length} Treffer · ${last.result.multiplier}× · ${formatMoney(last.payout)}`}
      </p>
    </div>
  );

  const table = PAYTABLE[picks.length];
  const controls = (
    <>
      <StakeControl
        value={stake}
        onChange={setStake}
        min={game.minStake}
        max={game.maxStake}
        disabled={busy}
      />
      {table ? (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {Object.entries(table).map(([h, m]) => (
            <span key={h} className="tabular rounded bg-surface-2 px-2 py-1 text-fg-muted">
              {h} Treffer: <span className="font-semibold text-fg">{m}×</span>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-fg-muted">Tippe 1 bis 10 Zahlen an.</p>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <Button variant="secondary" size="sm" onClick={quick} disabled={busy}>
          Zufallstipp
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setPicks([]);
            setLast(null);
          }}
          disabled={busy}
        >
          Leeren
        </Button>
      </div>
      <Button
        size="lg"
        className="w-full"
        onClick={start}
        disabled={busy || picks.length === 0 || (last !== null && !done)}
        data-testid="keno-play"
        data-play
      >
        {busy ? 'Zieht …' : 'Ziehen'}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
