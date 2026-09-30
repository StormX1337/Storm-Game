import type { Card, VideoPokerHand, VideoPokerResult } from '@storm-bet/types';
import type { Rng } from '../rng';
import { shuffledShoe } from './cards';

/** Jacks or Better, 8/5 table: return per unit (RTP 97.3 % with best play). */
export const POKER_PAYTABLE: Record<Exclude<VideoPokerHand, 'nothing'>, number> = {
  royal_flush: 800,
  straight_flush: 50,
  four_of_a_kind: 25,
  full_house: 8,
  flush: 5,
  straight: 4,
  three_of_a_kind: 3,
  two_pair: 2,
  jacks_or_better: 1,
};

export interface PokerState {
  /** Remaining deck in drawing order; never leaves the server. */
  deck: Card[];
  hand: Card[];
  actions: string[];
}

const ORDER: Card['rank'][] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function evaluateHand(hand: Card[]): VideoPokerHand {
  const values = hand.map((c) => ORDER.indexOf(c.rank) + 2).sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = [...counts.values()].sort((a, b) => b - a);
  const flush = hand.every((c) => c.suit === hand[0]!.suit);
  const distinct = counts.size === 5;
  const wheel = distinct && values.join() === '2,3,4,5,14';
  const straight = distinct && (values[4]! - values[0]! === 4 || wheel);
  if (straight && flush) return values[0] === 10 ? 'royal_flush' : 'straight_flush';
  if (groups[0] === 4) return 'four_of_a_kind';
  if (groups[0] === 3 && groups[1] === 2) return 'full_house';
  if (flush) return 'flush';
  if (straight) return 'straight';
  if (groups[0] === 3) return 'three_of_a_kind';
  if (groups[0] === 2 && groups[1] === 2) return 'two_pair';
  if (groups[0] === 2) {
    const pair = [...counts.entries()].find(([, n]) => n === 2)![0];
    if (pair >= 11) return 'jacks_or_better';
  }
  return 'nothing';
}

function view(state: PokerState, held: number[] | null, final: boolean): VideoPokerResult {
  const hand = evaluateHand(state.hand);
  return {
    game: 'VIDEO_POKER',
    hand: [...state.hand],
    held,
    handName: hand,
    multiplier: final ? (hand === 'nothing' ? 0 : POKER_PAYTABLE[hand]) : null,
    final,
  };
}

export function dealPoker(rng: Rng): { result: VideoPokerResult; state: PokerState } {
  const deck = shuffledShoe(1, rng);
  const hand = deck.splice(0, 5);
  const state: PokerState = { deck, hand, actions: [] };
  return { result: view(state, null, false), state };
}

/** Keeps the held cards, replaces the others and pays the final hand. */
export function drawPoker(
  state: PokerState,
  holds: number[],
  stake: bigint,
): { result: VideoPokerResult; state: PokerState; payout: bigint } {
  if (
    new Set(holds).size !== holds.length ||
    holds.some((h) => !Number.isInteger(h) || h < 0 || h > 4)
  )
    throw new RangeError('invalid holds');
  const held = [...holds].sort((a, b) => a - b);
  const deck = [...state.deck];
  const hand = state.hand.map((c, i) => (held.includes(i) ? c : deck.shift()!));
  const next: PokerState = { deck, hand, actions: [...state.actions, `draw:${held.join('')}`] };
  const name = evaluateHand(hand);
  const pay = name === 'nothing' ? 0 : POKER_PAYTABLE[name];
  return { result: view(next, held, true), state: next, payout: stake * BigInt(pay) };
}
