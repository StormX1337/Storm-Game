import type { Card } from '@storm-bet/types';
import type { Rng } from '../rng';

const RANKS: Card['rank'][] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS: Card['suit'][] = ['S', 'H', 'D', 'C'];

/** A freshly shuffled shoe for every round (no card counting, no carried-over state). */
export function shuffledShoe(decks: number, rng: Rng): Card[] {
  const shoe: Card[] = [];
  for (let d = 0; d < decks; d++)
    for (const suit of SUITS) for (const rank of RANKS) shoe.push({ rank, suit });
  // Fisher–Yates.
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [shoe[i], shoe[j]] = [shoe[j]!, shoe[i]!];
  }
  return shoe;
}

export function draw(shoe: Card[]): Card {
  const card = shoe.pop();
  if (!card) throw new Error('shoe is empty');
  return card;
}
