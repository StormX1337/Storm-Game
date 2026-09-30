'use client';

import type {
  CasinoGameDto,
  CasinoRoundDto,
  VideoPokerHand,
  VideoPokerResult,
} from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { useEffect, useState } from 'react';
import { formatMoney } from '@/lib/format';
import { GameShell, PlayingCard, StakeControl, useCasinoPlay } from './controls';
import { useT } from '@/i18n/client';

/** The server's 8/5 Jacks or Better table (display only). */
const PAYTABLE: [Exclude<VideoPokerHand, 'nothing'>, string, number][] = [
  ['royal_flush', 'Royal Flush', 800],
  ['straight_flush', 'Straight Flush', 50],
  ['four_of_a_kind', 'Vierling', 25],
  ['full_house', 'Full House', 8],
  ['flush', 'Flush', 5],
  ['straight', 'Straße', 4],
  ['three_of_a_kind', 'Drilling', 3],
  ['two_pair', 'Zwei Paare', 2],
  ['jacks_or_better', 'Paar Buben+', 1],
];
const NAMES = Object.fromEntries(PAYTABLE.map(([k, n]) => [k, n])) as Record<string, string>;

export function PokerGame({
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
  const [round, setRound] = useState<CasinoRoundDto | null>(openRound);
  const [held, setHeld] = useState<number[]>([]);
  const result = round?.result as VideoPokerResult | undefined;
  const running = round?.status === 'OPEN';
  useEffect(() => setHeld([]), [round?.id]);

  const deal = async () => {
    const res = await play({ action: 'deal', stake });
    if (res) setRound(res.round);
  };
  const draw = async () => {
    if (!round) return;
    const res = await play({ action: 'draw', holds: held, roundId: round.id, step: round.step });
    if (res) setRound(res.round);
  };
  const toggle = (i: number) =>
    setHeld((h) => (h.includes(i) ? h.filter((x) => x !== i) : [...h, i]));

  const area = (
    <div className="bg-[radial-gradient(ellipse_at_top,#7f1d1d,#020617)] p-4 sm:p-6">
      <div className="flex justify-center gap-1.5 sm:gap-3" data-testid="poker-hand">
        {Array.from({ length: 5 }, (_, i) => {
          const card = result?.hand[i] ?? null;
          const isHeld = running ? held.includes(i) : (result?.held?.includes(i) ?? false);
          return (
            <button
              key={`${round?.id ?? 'none'}-${round?.step ?? 0}-${i}`}
              type="button"
              disabled={!running || busy}
              onClick={() => toggle(i)}
              className="flex flex-col items-center gap-1"
              aria-pressed={running ? isHeld : undefined}
              data-testid="poker-card"
            >
              <PlayingCard card={card} index={i} />
              <span
                className={cn(
                  'rounded px-1.5 text-[10px] font-bold uppercase',
                  isHeld ? 'bg-amber-400 text-slate-900' : 'text-transparent',
                )}
              >
                {t('Halten')}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-center text-sm text-white/70" aria-live="polite">
        {!result
          ? t('Geben, Karten halten, ziehen.')
          : running
            ? result.handName !== 'nothing'
              ? t('Auf der Hand: {0} – tippe Karten zum Halten.', [NAMES[result.handName]])
              : t('Tippe die Karten an, die du halten willst.')
            : result.handName !== 'nothing' && result.multiplier
              ? `${NAMES[result.handName]} · ${result.multiplier}× · ${formatMoney(round!.payout)}`
              : t('Keine Gewinnhand.')}
      </p>
    </div>
  );

  const controls = (
    <>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        {PAYTABLE.map(([key, name, pay]) => (
          <div
            key={key}
            className={cn(
              'flex justify-between rounded px-1.5 py-0.5',
              result?.handName === key ? 'bg-accent-soft font-semibold text-fg' : 'text-fg-muted',
            )}
          >
            <span>{name}</span>
            <span className="tabular">{pay}×</span>
          </div>
        ))}
      </div>
      {running ? (
        <Button
          size="lg"
          className="w-full"
          onClick={draw}
          disabled={busy}
          data-testid="poker-draw"
        >
          {busy ? t('Zieht …') : t('Ziehen ({0} neue Karten)', [5 - held.length])}
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
          <Button
            size="lg"
            className="w-full"
            onClick={deal}
            disabled={busy}
            data-testid="poker-deal"
            data-play
          >
            {busy ? t('Gibt …') : t('Geben')}
          </Button>
        </>
      )}
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
