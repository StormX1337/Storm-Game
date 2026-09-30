'use client';

import type { CasinoGameDto, RouletteBet, RouletteResult } from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { RotateCcw, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { ChipPicker, GameShell, useCasinoPlay } from './controls';

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n: number) =>
  n === 0 ? 'bg-emerald-600' : RED.has(n) ? 'bg-red-600' : 'bg-slate-900';
/** Board order: columns of three (3,2,1), (6,5,4) … so both layouts read naturally. */
const BOARD = Array.from({ length: 12 }, (_, c) => [3 * c + 3, 3 * c + 2, 3 * c + 1]).flat();
const OUTSIDE: { label: string; bet: Omit<RouletteBet, 'stake'> }[] = [
  { label: '1–18', bet: { type: 'low' } },
  { label: 'Gerade', bet: { type: 'even' } },
  { label: 'Rot', bet: { type: 'red' } },
  { label: 'Schwarz', bet: { type: 'black' } },
  { label: 'Ungerade', bet: { type: 'odd' } },
  { label: '19–36', bet: { type: 'high' } },
  { label: '1. Dutzend', bet: { type: 'dozen', value: 1 } },
  { label: '2. Dutzend', bet: { type: 'dozen', value: 2 } },
  { label: '3. Dutzend', bet: { type: 'dozen', value: 3 } },
  { label: '1. Kolonne', bet: { type: 'column', value: 1 } },
  { label: '2. Kolonne', bet: { type: 'column', value: 2 } },
  { label: '3. Kolonne', bet: { type: 'column', value: 3 } },
];
const keyOf = (b: Omit<RouletteBet, 'stake'>) => `${b.type}:${b.value ?? ''}`;

export function RouletteGame({ game, sessionId }: { game: CasinoGameDto; sessionId: string }) {
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [chip, setChip] = useState(100);
  const [bets, setBets] = useState<RouletteBet[]>([]);
  const [placed, setPlaced] = useState<string[]>([]);
  const [last, setLast] = useState<RouletteResult | null>(null);
  const [lastPayout, setLastPayout] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const stakeOn = (k: string) => bets.find((b) => keyOf(b) === k)?.stake ?? 0;
  const total = bets.reduce((s, b) => s + b.stake, 0);

  const add = (bet: Omit<RouletteBet, 'stake'>) => {
    const k = keyOf(bet);
    if (total + chip > game.maxStake) return;
    setBets((prev) =>
      prev.some((b) => keyOf(b) === k)
        ? prev.map((b) => (keyOf(b) === k ? { ...b, stake: b.stake + chip } : b))
        : [...prev, { ...bet, stake: chip }],
    );
    setPlaced((p) => [...p, k]);
  };
  const undo = () => {
    const k = placed.at(-1);
    if (!k) return;
    setPlaced((p) => p.slice(0, -1));
    setBets((prev) =>
      prev
        .map((b) => (keyOf(b) === k ? { ...b, stake: b.stake - chip } : b))
        .filter((b) => b.stake > 0),
    );
  };
  const spin = async () => {
    const res = await play({ action: 'spin', bets });
    if (!res) return;
    const result = res.round.result as RouletteResult;
    setLast(result);
    setLastPayout(res.round.payout);
    setHistory((h) => [result.number, ...h].slice(0, 12));
  };

  const cell = (n: number) => {
    const k = keyOf({ type: 'straight', value: n });
    const stake = stakeOn(k);
    return (
      <button
        key={n}
        onClick={() => add({ type: 'straight', value: n })}
        disabled={busy}
        className={cn(
          'tabular relative grid h-9 place-items-center rounded text-xs font-semibold text-white transition hover:brightness-125 sm:h-10 sm:text-sm',
          colorOf(n),
          last?.number === n && 'ring-2 ring-yellow-300',
        )}
        aria-label={`Zahl ${n}${stake ? `, Einsatz ${formatMoney(stake)}` : ''}`}
      >
        {n}
        {stake ? (
          <span className="absolute -right-1 -top-1 grid min-w-5 place-items-center rounded-full bg-yellow-300 px-1 text-[9px] font-bold text-slate-900">
            {formatMoney(stake, { unit: false })}
          </span>
        ) : null}
      </button>
    );
  };

  const area = (
    <div className="space-y-4 bg-[radial-gradient(ellipse_at_top,#14532d,#052e16)] p-4 sm:p-6">
      <div className="flex items-center gap-4">
        <div
          className={cn(
            'grid size-20 shrink-0 place-items-center rounded-full border-4 border-yellow-500/70 text-3xl font-bold text-white shadow-lg transition-colors sm:size-24',
            last ? colorOf(last.number) : 'bg-black/40',
            busy && 'animate-spin border-dashed',
          )}
          data-testid="roulette-number"
          aria-live="polite"
        >
          {busy ? '' : (last?.number ?? '–')}
        </div>
        <div className="min-w-0 space-y-1 text-white">
          <p className="text-sm text-white/70">Letzte Zahlen</p>
          <div className="flex flex-wrap gap-1">
            {history.length ? (
              history.map((n, i) => (
                <span
                  key={i}
                  className={cn(
                    'tabular grid size-6 place-items-center rounded-full text-[11px] font-semibold',
                    colorOf(n),
                  )}
                >
                  {n}
                </span>
              ))
            ) : (
              <span className="text-xs text-white/50">Noch keine Runde</span>
            )}
          </div>
          {last ? (
            <p className="text-sm font-semibold text-yellow-300">
              {lastPayout > 0 ? `Gewinn ${formatMoney(lastPayout)}` : 'Kein Gewinn'}
            </p>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-[2.25rem_1fr] gap-1.5">
        <button
          onClick={() => add({ type: 'straight', value: 0 })}
          disabled={busy}
          className={cn(
            'rounded text-sm font-semibold text-white',
            colorOf(0),
            last?.number === 0 && 'ring-2 ring-yellow-300',
          )}
          aria-label="Zahl 0"
        >
          0
        </button>
        <div className="grid grid-cols-3 gap-1.5 md:grid-flow-col md:grid-cols-12 md:grid-rows-3">
          {BOARD.map(cell)}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {OUTSIDE.map(({ label, bet }) => {
          const stake = stakeOn(keyOf(bet));
          return (
            <button
              key={label}
              onClick={() => add(bet)}
              disabled={busy}
              className={cn(
                'rounded border border-white/15 px-1 py-2 text-xs font-medium text-white transition hover:bg-white/10',
                bet.type === 'red' && 'bg-red-600/80',
                bet.type === 'black' && 'bg-slate-900/80',
                stake > 0 && 'ring-2 ring-yellow-300',
              )}
            >
              {label}
              {stake ? (
                <span className="tabular block text-[10px] text-yellow-300">
                  {formatMoney(stake)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );

  const controls = (
    <>
      <div className="space-y-2">
        <p className="text-xs text-fg-muted">Chip wählen, dann auf das Tableau tippen</p>
        <ChipPicker
          values={[10, 50, 100, 500, 1_000, 5_000].filter((c) => c <= game.maxStake)}
          value={chip}
          onChange={setChip}
          disabled={busy}
        />
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-fg-muted">Gesamteinsatz</span>
        <span className="tabular font-semibold" data-testid="stake">
          {formatMoney(total)}
        </span>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={undo} disabled={busy || !placed.length}>
          <Undo2 /> Zurück
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setBets([]);
            setPlaced([]);
          }}
          disabled={busy || !bets.length}
        >
          <RotateCcw /> Leeren
        </Button>
      </div>
      <Button
        size="lg"
        className="w-full"
        onClick={spin}
        disabled={busy || total < game.minStake}
        data-testid="spin"
        data-play
      >
        {busy ? 'Kugel rollt …' : 'Drehen'}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
