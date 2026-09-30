'use client';

import type { CasinoGameDto, CasinoRoundDto, HiloResult } from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { ArrowDown, ArrowUp, SkipForward } from 'lucide-react';
import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { GameShell, PlayingCard, StakeControl, useCasinoPlay } from './controls';

const pct = (p: number) => `${Math.round(p * 1000) / 10} %`;

export function HiloGame({
  game,
  sessionId,
  openRound,
}: {
  game: CasinoGameDto;
  sessionId: string;
  openRound: CasinoRoundDto | null;
}) {
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [stake, setStake] = useState(Math.max(game.minStake, 100));
  const [round, setRound] = useState<CasinoRoundDto | null>(openRound);
  const result = round?.result as HiloResult | undefined;
  const running = round?.status === 'OPEN';
  const won = result?.history.some((h) => h.won) ?? false;

  const start = async () => {
    const res = await play({ action: 'start', stake });
    if (res) setRound(res.round);
  };
  const act = async (action: string) => {
    if (!round) return;
    const res = await play({ action, roundId: round.id, step: round.step });
    if (res) setRound(res.round);
  };

  const area = (
    <div className="bg-[radial-gradient(ellipse_at_top,#065f46,#020617)] p-5 sm:p-8">
      <div className="flex min-h-40 items-center justify-center gap-4">
        {result ? <PlayingCard card={result.current} /> : <PlayingCard card={null} />}
      </div>
      {result && result.history.length ? (
        <div className="mt-4 flex gap-1 overflow-x-auto pb-1" aria-label="Bisherige Karten">
          {result.history.slice(-10).map((h, i) => (
            <span
              key={i}
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold',
                h.won === null
                  ? 'bg-white/10 text-white/60'
                  : h.won
                    ? 'bg-emerald-500/30 text-emerald-200'
                    : 'bg-red-500/30 text-red-200',
              )}
            >
              {h.card.rank}
              {h.guess === 'higher' ? '↑' : h.guess === 'lower' ? '↓' : '→'}
            </span>
          ))}
        </div>
      ) : null}
      <p className="mt-4 text-center text-sm text-white/70" aria-live="polite">
        {!result
          ? 'Starte eine Runde und rate: höher oder tiefer?'
          : running
            ? `Jetzt ${result.multiplier.toFixed(2)}×`
            : result.outcome === 'lost'
              ? 'Falsch geraten – Einsatz verloren.'
              : `Ausgezahlt: ${result.multiplier.toFixed(2)}× · ${formatMoney(round!.payout)}`}
      </p>
    </div>
  );

  const guess = (g: 'higher' | 'lower') => {
    const side = result![g];
    return (
      <Button
        size="lg"
        variant="secondary"
        onClick={() => void act(g)}
        disabled={busy || side.multiplier === null}
        className="flex-col gap-0.5"
        data-testid={`hilo-${g}`}
      >
        <span className="flex items-center gap-1">
          {g === 'higher' ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
          {g === 'higher' ? 'Höher/gleich' : 'Tiefer/gleich'}
        </span>
        <span className="tabular text-xs text-fg-muted">
          {pct(side.chance)} · {side.multiplier ? `${side.multiplier.toFixed(2)}×` : '–'}
        </span>
      </Button>
    );
  };

  const controls = running ? (
    <>
      <div className="grid grid-cols-2 gap-2">
        {guess('higher')}
        {guess('lower')}
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Button variant="ghost" onClick={() => void act('skip')} disabled={busy}>
          <SkipForward /> Überspringen
        </Button>
        <Button
          onClick={() => void act('cashout')}
          disabled={busy || !won}
          data-testid="hilo-cashout"
        >
          Auszahlen ·{' '}
          {formatMoney(Math.floor((round!.stake * Math.round(result!.multiplier * 100)) / 100))}
        </Button>
      </div>
    </>
  ) : (
    <>
      <StakeControl
        value={stake}
        onChange={setStake}
        min={game.minStake}
        max={game.maxStake}
        disabled={busy}
      />
      <Button
        size="lg"
        className="w-full"
        onClick={start}
        disabled={busy}
        data-testid="hilo-start"
        data-play
      >
        {busy ? 'Startet …' : 'Starten'}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
