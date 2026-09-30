'use client';

import type { CasinoGameDto, CasinoRoundDto, MinesResult } from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { Bomb, Gem } from 'lucide-react';
import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { GameShell, StakeControl, useCasinoPlay } from './controls';
import { useT } from '@/i18n/client';

const MINE_CHOICES = [1, 3, 5, 10, 24];

export function MinesGame({
  game,
  sessionId,
  openRound,
}: {
  game: CasinoGameDto;
  sessionId: string;
  openRound: CasinoRoundDto | null;
}) {
  const t = useT();
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [stake, setStake] = useState(Math.max(game.minStake, 100));
  const [mines, setMines] = useState(3);
  const [round, setRound] = useState<CasinoRoundDto | null>(openRound);
  const result = round?.result as MinesResult | undefined;
  const running = round?.status === 'OPEN';

  const start = async () => {
    const res = await play({ action: 'start', stake, mines });
    if (res) setRound(res.round);
  };
  const act = async (body: Record<string, unknown>) => {
    if (!round) return;
    const res = await play({ ...body, roundId: round.id, step: round.step });
    if (res) setRound(res.round);
  };

  const area = (
    <div className="bg-[radial-gradient(ellipse_at_top,#134e4a,#020617)] p-4 sm:p-8">
      <div className="mx-auto grid max-w-sm grid-cols-5 gap-2" data-testid="mines-grid">
        {Array.from({ length: 25 }, (_, tile) => {
          const safe = result?.revealed.includes(tile);
          const mine = result?.minePositions?.includes(tile);
          const hit = result?.hit === tile;
          return (
            <button
              key={tile}
              type="button"
              disabled={!running || busy || safe}
              onClick={() => void act({ action: 'reveal', tile })}
              className={cn(
                'grid aspect-square place-items-center rounded-lg border transition-colors',
                safe
                  ? 'border-emerald-400/60 bg-emerald-500/20'
                  : mine
                    ? hit
                      ? 'border-red-400 bg-red-500/40'
                      : 'border-red-400/30 bg-red-500/10'
                    : 'border-white/10 bg-white/5 enabled:hover:bg-white/15',
              )}
              aria-label={safe ? t('Sicher') : mine ? t('Mine') : t('Feld {0}', [tile + 1])}
              data-testid="mines-tile"
            >
              {safe ? (
                <Gem className="size-5 text-emerald-300" />
              ) : mine ? (
                <Bomb className="size-5 text-red-300" />
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="mt-4 text-center text-sm text-white/70" aria-live="polite">
        {!result
          ? t('Wähle Minen und Einsatz, dann Felder aufdecken.')
          : running
            ? t('Jetzt {0}× · nächstes Feld {1}×', [
                result.multiplier.toFixed(2),
                result.nextMultiplier?.toFixed(2) ?? '–',
              ])
            : result.outcome === 'mine'
              ? t('Mine getroffen – Einsatz verloren.')
              : t('Ausgezahlt: {0}× · {1}', [
                  result.multiplier.toFixed(2),
                  formatMoney(round!.payout),
                ])}
      </p>
    </div>
  );

  const controls = running ? (
    <Button
      size="lg"
      className="w-full"
      onClick={() => void act({ action: 'cashout' })}
      disabled={busy}
      data-testid="mines-cashout"
    >
      {t('Auszahlen ·')}{' '}
      {formatMoney(Math.floor((round!.stake * Math.round(result!.multiplier * 100)) / 100))}
    </Button>
  ) : (
    <>
      <StakeControl
        value={stake}
        onChange={setStake}
        min={game.minStake}
        max={game.maxStake}
        disabled={busy}
      />
      <div className="space-y-2">
        <p className="text-xs text-fg-muted">{t('Minen')}</p>
        <div className="grid grid-cols-5 gap-1.5">
          {MINE_CHOICES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMines(m)}
              className={cn(
                'tabular rounded-md border py-1.5 text-sm',
                mines === m
                  ? 'border-accent bg-accent-soft text-fg'
                  : 'border-border text-fg-muted hover:text-fg',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <Button
        size="lg"
        className="w-full"
        onClick={start}
        disabled={busy}
        data-testid="mines-start"
        data-play
      >
        {busy ? t('Startet …') : t('Starten')}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
