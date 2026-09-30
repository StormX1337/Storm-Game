'use client';

import {
  SLOT_PAYLINES,
  type CasinoGameDto,
  type SlotResult,
  type SlotSymbol,
} from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { Cherry, Citrus, Clover, Crown, Gem, Star, Zap } from 'lucide-react';
import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { GameShell, StakeControl, useCasinoPlay } from './controls';
import { useT } from '@/i18n/client';

const SYMBOL: Record<SlotSymbol, { icon: typeof Zap; color: string }> = {
  bolt: { icon: Zap, color: 'text-yellow-300' },
  crown: { icon: Crown, color: 'text-amber-400' },
  gem: { icon: Gem, color: 'text-cyan-300' },
  star: { icon: Star, color: 'text-violet-300' },
  clover: { icon: Clover, color: 'text-emerald-400' },
  cherry: { icon: Cherry, color: 'text-rose-400' },
  lemon: { icon: Citrus, color: 'text-lime-300' },
};

const START: SlotSymbol[][] = [
  ['cherry', 'bolt', 'lemon'],
  ['gem', 'crown', 'clover'],
  ['star', 'bolt', 'cherry'],
  ['lemon', 'gem', 'star'],
  ['clover', 'crown', 'gem'],
];

export function SlotGame({ game, sessionId }: { game: CasinoGameDto; sessionId: string }) {
  const t = useT();
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [stake, setStake] = useState(Math.max(game.minStake, 100));
  const [last, setLast] = useState<{ result: SlotResult; payout: number; stake: number } | null>(
    null,
  );
  const reels = last?.result.reels ?? START;
  const winning = new Set(
    (last?.result.wins ?? []).flatMap((w) =>
      SLOT_PAYLINES[w.line - 1]!.slice(0, w.count).map((row, reel) => `${reel}:${row}`),
    ),
  );

  const spin = async () => {
    const res = await play({ action: 'spin', stake });
    if (res) setLast({ result: res.round.result as SlotResult, payout: res.round.payout, stake });
  };

  const area = (
    <div className="bg-[radial-gradient(ellipse_at_top,#1e293b,#020617)] p-4 sm:p-8">
      <div
        className="mx-auto grid max-w-xl grid-cols-5 gap-2 rounded-xl border border-white/10 bg-black/40 p-2 sm:gap-3 sm:p-3"
        data-testid="slot-reels"
      >
        {reels.map((reel, r) => (
          <div key={r} className={cn('grid gap-2 sm:gap-3', busy && 'animate-pulse')}>
            {reel.map((symbol, row) => {
              const { icon: Icon, color } = SYMBOL[symbol];
              const hit = winning.has(`${r}:${row}`);
              return (
                <div
                  key={row}
                  className={cn(
                    'grid aspect-square place-items-center rounded-lg bg-gradient-to-b from-slate-800 to-slate-900 transition-all duration-300',
                    hit && 'ring-2 ring-yellow-300 shadow-[0_0_18px_rgba(250,204,21,0.45)]',
                    busy && 'blur-[2px]',
                  )}
                >
                  <Icon className={cn('size-7 sm:size-10', color)} aria-label={symbol} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-4 text-center" aria-live="polite">
        {last ? (
          last.payout > 0 ? (
            <p className="text-lg font-semibold text-yellow-300">
              {t('Gewinn')} {formatMoney(last.payout)} · {last.result.wins.length} {t('Linie')}
              {last.result.wins.length === 1 ? '' : 'n'}
            </p>
          ) : (
            <p className="text-sm text-white/60">
              {t('Kein Gewinn – viel Glück beim nächsten Dreh.')}
            </p>
          )
        ) : (
          <p className="text-sm text-white/60">
            {t('10 Gewinnlinien · Gewinne von links nach rechts')}
          </p>
        )}
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
      <Button
        size="lg"
        className="w-full"
        onClick={spin}
        disabled={busy}
        data-testid="spin"
        data-play
      >
        {busy ? t('Dreht …') : t('Drehen')}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
