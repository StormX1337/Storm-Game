'use client';

import type { BaccaratResult, BaccaratSide, CasinoGameDto } from '@storm-bet/types';
import { Button, cn } from '@storm-bet/ui';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { ChipPicker, Felt, GameShell, Hand, useCasinoPlay } from './controls';
import { useT } from '@/i18n/client';

const SIDES: { side: BaccaratSide; label: string; pays: string }[] = [
  { side: 'player', label: 'Spieler', pays: '1:1' },
  { side: 'tie', label: 'Unentschieden', pays: '8:1' },
  { side: 'banker', label: 'Bank', pays: '0,95:1' },
];
const WINNER: Record<BaccaratSide, string> = {
  player: 'Spieler gewinnt',
  banker: 'Bank gewinnt',
  tie: 'Unentschieden',
};

export function BaccaratGame({ game, sessionId }: { game: CasinoGameDto; sessionId: string }) {
  const t = useT();
  const { play, busy } = useCasinoPlay(game.id, sessionId);
  const [chip, setChip] = useState(100);
  const [stakes, setStakes] = useState<Partial<Record<BaccaratSide, number>>>({});
  const [last, setLast] = useState<{ result: BaccaratResult; payout: number } | null>(null);
  const total = Object.values(stakes).reduce((s, v) => s + (v ?? 0), 0);

  const deal = async () => {
    const sides = Object.entries(stakes)
      .filter(([, v]) => v)
      .map(([side, stake]) => ({ side, stake }));
    const res = await play({ action: 'deal', sides });
    if (res) setLast({ result: res.round.result as BaccaratResult, payout: res.round.payout });
  };

  const area = (
    <Felt className="space-y-6">
      {last ? (
        <div className="grid gap-6 sm:grid-cols-2" data-testid="baccarat-table">
          <Hand label={t('Spieler')} cards={last.result.player} total={last.result.playerTotal} />
          <Hand label={t('Bank')} cards={last.result.banker} total={last.result.bankerTotal} />
        </div>
      ) : (
        <p className="py-10 text-center text-white/70">
          {t('Setze auf Spieler, Bank oder Unentschieden.')}
        </p>
      )}
      {last ? (
        <p className="text-lg font-semibold text-yellow-300" aria-live="polite">
          {WINNER[last.result.winner]}
          {last.payout > 0 ? t(' · Auszahlung {0}', [formatMoney(last.payout)]) : ''}
        </p>
      ) : null}
      <div className="grid grid-cols-3 gap-2">
        {SIDES.map(({ side, label, pays }) => (
          <button
            key={side}
            disabled={busy}
            onClick={() =>
              total + chip <= game.maxStake &&
              setStakes((s) => ({ ...s, [side]: (s[side] ?? 0) + chip }))
            }
            className={cn(
              'rounded-lg border border-white/20 bg-black/25 p-3 text-center text-white transition hover:bg-white/10',
              stakes[side] && 'ring-2 ring-yellow-300',
              last?.result.winner === side && 'bg-yellow-300/15',
            )}
          >
            <span className="block text-sm font-semibold">{t(label)}</span>
            <span className="block text-[11px] text-white/60">zahlt {pays}</span>
            <span className="tabular mt-1 block text-xs text-yellow-300">
              {stakes[side] ? formatMoney(stakes[side]!) : ' '}
            </span>
          </button>
        ))}
      </div>
    </Felt>
  );

  const controls = (
    <>
      <ChipPicker
        values={[10, 50, 100, 500, 1_000, 5_000].filter((c) => c <= game.maxStake)}
        value={chip}
        onChange={setChip}
        disabled={busy}
      />
      <div className="flex items-center justify-between text-sm">
        <span className="text-fg-muted">{t('Gesamteinsatz')}</span>
        <span className="tabular font-semibold" data-testid="stake">
          {formatMoney(total)}
        </span>
      </div>
      <Button variant="secondary" onClick={() => setStakes({})} disabled={busy || !total}>
        <RotateCcw /> {t('Einsätze leeren')}
      </Button>
      <Button
        size="lg"
        className="w-full"
        onClick={deal}
        disabled={busy || total < game.minStake}
        data-testid="deal"
        data-play
      >
        {busy ? t('Teilt aus …') : t('Austeilen')}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
