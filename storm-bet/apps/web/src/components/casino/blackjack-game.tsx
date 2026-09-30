'use client';

import type { BlackjackResult, CasinoGameDto, CasinoRoundDto } from '@storm-bet/types';
import { Button } from '@storm-bet/ui';
import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { Felt, GameShell, Hand, StakeControl, useCasinoPlay } from './controls';
import { useT } from '@/i18n/client';

const OUTCOME: Record<NonNullable<BlackjackResult['outcome']>, string> = {
  blackjack: 'Blackjack!',
  win: 'Gewonnen',
  push: 'Unentschieden – Einsatz zurück',
  lose: 'Verloren',
  bust: 'Überkauft',
};

export function BlackjackGame({
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
  const hand = round?.result as BlackjackResult | undefined;
  const open = round?.status === 'OPEN';

  const deal = async () => {
    const res = await play({ action: 'deal', stake });
    if (res) setRound(res.round);
  };
  const act = async (action: 'hit' | 'stand' | 'double') => {
    if (!round) return;
    const res = await play({ action, roundId: round.id, step: round.step });
    if (res) setRound(res.round);
  };

  const area = (
    <Felt>
      {hand ? (
        <div className="space-y-6" data-testid="blackjack-table">
          <Hand label={t('Dealer')} cards={hand.dealer} total={hand.dealerTotal} />
          <Hand label={t('Du')} cards={hand.player} total={hand.playerTotal} />
          <div aria-live="polite" className="min-h-7">
            {hand.outcome ? (
              <p className="text-lg font-semibold text-yellow-300">
                {OUTCOME[hand.outcome]}
                {round && round.payout > 0 ? ` · ${formatMoney(round.payout)}` : ''}
              </p>
            ) : (
              <p className="text-sm text-white/70">
                {t('Einsatz')} {formatMoney(round?.stake ?? 0)} {t('– Karte oder stehen bleiben?')}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="grid min-h-[280px] place-items-center text-center text-white/70">
          <p>
            {t(
              'Dealer steht auf Soft 17 · Blackjack zahlt 3:2 · Verdoppeln auf die ersten zwei Karten',
            )}
          </p>
        </div>
      )}
    </Felt>
  );

  const controls = open ? (
    <div className="grid grid-cols-3 gap-2">
      <Button onClick={() => act('hit')} disabled={busy || !hand?.actions.includes('hit')}>
        {t('Karte')}
      </Button>
      <Button
        variant="secondary"
        onClick={() => act('stand')}
        disabled={busy || !hand?.actions.includes('stand')}
      >
        {t('Stehen')}
      </Button>
      <Button
        variant="secondary"
        onClick={() => act('double')}
        disabled={busy || !hand?.actions.includes('double')}
      >
        {t('Verdoppeln')}
      </Button>
    </div>
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
        data-testid="deal"
        data-play
      >
        {busy ? t('Teilt aus …') : round ? t('Neue Hand') : t('Austeilen')}
      </Button>
    </>
  );
  return <GameShell area={area} controls={controls} />;
}
