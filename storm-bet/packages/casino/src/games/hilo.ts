import type { Card, HiloGuess, HiloResult } from '@storm-bet/types';
import type { Rng } from '../rng';

export const HILO_RTP = 0.97;
/** Rounds end (paid out) at this multiplier or after this many actions. */
export const HILO_MAX_MULTIPLIER = 10_000_00; // hundredths: 10 000×
export const HILO_MAX_ACTIONS = 45;

const RANKS: Card['rank'][] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS: Card['suit'][] = ['S', 'H', 'D', 'C'];

/** Server-side state; the coming cards never leave the server. */
export interface HiloState {
  /** Cards still to come (drawn at the start, independently: an endless deck). */
  queue: Card[];
  current: Card;
  /** Product of the fair odds of the guesses won so far. */
  fair: number;
  history: HiloResult['history'];
  actions: string[];
}

const value = (c: Card) => RANKS.indexOf(c.rank) + 1; // A = 1 … K = 13

/** Chance that the next card is higher-or-same / lower-or-same. */
export function hiloChance(card: Card, guess: HiloGuess): number {
  const v = value(card);
  return guess === 'higher' ? (14 - v) / 13 : v / 13;
}

/** Cash-out multiplier (hundredths): fair odds of the guesses won, less the house edge once. */
function multiplier(fair: number): number {
  return fair === 1 ? 100 : Math.min(Math.floor(fair * HILO_RTP * 100), HILO_MAX_MULTIPLIER);
}

function view(state: HiloState, outcome: HiloResult['outcome']): HiloResult {
  const next = (g: HiloGuess) => {
    const p = hiloChance(state.current, g);
    return p >= 1 ? null : multiplier(state.fair / p) / 100;
  };
  return {
    game: 'HILO',
    current: state.current,
    history: [...state.history],
    multiplier: multiplier(state.fair) / 100,
    higher: { chance: hiloChance(state.current, 'higher'), multiplier: next('higher') },
    lower: { chance: hiloChance(state.current, 'lower'), multiplier: next('lower') },
    outcome,
  };
}

export function startHilo(rng: Rng): { result: HiloResult; state: HiloState } {
  const card = (): Card => ({ rank: RANKS[rng(13)]!, suit: SUITS[rng(4)]! });
  const queue = Array.from({ length: HILO_MAX_ACTIONS + 1 }, card);
  const state: HiloState = { queue, current: card(), fair: 1, history: [], actions: [] };
  return { result: view(state, null), state };
}

/** A guess, a skipped card or a cash-out. payout null: the round goes on. */
export function actHilo(
  state: HiloState,
  action: { type: HiloGuess | 'skip' | 'cashout' },
  stake: bigint,
): { result: HiloResult; state: HiloState; payout: bigint | null } {
  const next: HiloState = {
    ...state,
    queue: [...state.queue],
    history: [...state.history],
    actions: [...state.actions, action.type],
  };
  const pay = () => (stake * BigInt(multiplier(next.fair))) / 100n;
  if (action.type === 'cashout') {
    return { result: view(next, 'cashout'), state: next, payout: pay() };
  }
  const card = next.queue.shift();
  if (!card) return { result: view(next, 'cashout'), state: next, payout: pay() };
  if (action.type === 'skip') {
    next.history.push({ card: next.current, guess: null, won: null });
    next.current = card;
  } else {
    const p = hiloChance(next.current, action.type);
    if (p >= 1) throw new RangeError('this guess cannot lose');
    const won =
      action.type === 'higher'
        ? value(card) >= value(next.current)
        : value(card) <= value(next.current);
    next.history.push({ card: next.current, guess: action.type, won });
    next.current = card;
    if (!won) return { result: view(next, 'lost'), state: next, payout: 0n };
    next.fair /= p;
  }
  // Limits reached: paid out automatically.
  if (multiplier(next.fair) >= HILO_MAX_MULTIPLIER || next.actions.length >= HILO_MAX_ACTIONS) {
    return { result: view(next, 'cashout'), state: next, payout: pay() };
  }
  return { result: view(next, null), state: next, payout: null };
}
