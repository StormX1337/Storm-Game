import type { BaccaratResult, BaccaratSide, Card } from '@storm-bet/types';
import type { Rng } from '../rng';
import { draw, shuffledShoe } from './cards';

/** Punto banco from an 8-deck shoe; banker pays 0.95:1, tie 8:1 (house edge ≈ 1.06 % / 1.24 %). */
export const BACCARAT_RTP = 98.9;

export function baccaratValue(card: Card): number {
  if (card.rank === 'A') return 1;
  if (['10', 'J', 'Q', 'K'].includes(card.rank)) return 0;
  return Number(card.rank);
}

const total = (cards: Card[]) => cards.reduce((s, c) => s + baccaratValue(c), 0) % 10;

/** The standard drawing rules for both hands, from cards in dealing order. */
export function dealBaccarat(next: () => Card): { player: Card[]; banker: Card[] } {
  const player = [next()];
  const banker = [next()];
  player.push(next());
  banker.push(next());
  const p = total(player);
  const b = total(banker);
  if (p >= 8 || b >= 8) return { player, banker };
  let third: number | null = null;
  if (p <= 5) {
    const card = next();
    player.push(card);
    third = baccaratValue(card);
  }
  const bankerDraws =
    third === null
      ? b <= 5
      : b <= 2 ||
        (b === 3 && third !== 8) ||
        (b === 4 && third >= 2 && third <= 7) ||
        (b === 5 && third >= 4 && third <= 7) ||
        (b === 6 && third >= 6 && third <= 7);
  if (bankerDraws) banker.push(next());
  return { player, banker };
}

export function settleBaccarat(
  hands: { player: Card[]; banker: Card[] },
  bets: { side: BaccaratSide; stake: number }[],
): { result: BaccaratResult; payout: bigint } {
  const playerTotal = total(hands.player);
  const bankerTotal = total(hands.banker);
  const winner: BaccaratSide =
    playerTotal > bankerTotal ? 'player' : bankerTotal > playerTotal ? 'banker' : 'tie';
  let payout = 0n;
  const resolved = bets.map((bet) => {
    const stake = BigInt(bet.stake);
    let back = 0n;
    if (winner === 'tie')
      back = bet.side === 'tie' ? stake * 9n : stake; // player/banker push
    else if (bet.side === winner)
      back = winner === 'banker' ? stake + (stake * 95n) / 100n : stake * 2n;
    payout += back;
    return { side: bet.side, stake: bet.stake, payout: Number(back) };
  });
  return {
    result: { game: 'BACCARAT', ...hands, playerTotal, bankerTotal, winner, bets: resolved },
    payout,
  };
}

export function playBaccarat(rng: Rng, bets: { side: BaccaratSide; stake: number }[]) {
  const shoe = shuffledShoe(8, rng);
  return settleBaccarat(
    dealBaccarat(() => draw(shoe)),
    bets,
  );
}
