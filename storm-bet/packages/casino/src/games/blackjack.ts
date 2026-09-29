import type { BlackjackResult, Card } from '@storm-bet/types';
import type { Rng } from '../rng';
import { draw, shuffledShoe } from './cards';

/**
 * Blackjack, 6 decks, dealer stands on soft 17, blackjack pays 3:2, double
 * on the first two cards, no split or insurance (return ≈ 99.3 %). The dealer
 * peeks for blackjack, so a dealer blackjack ends the hand at once.
 */
export const BLACKJACK_RTP = 99.3;

export type BlackjackAction = 'hit' | 'stand' | 'double';

/** Server-only state of an open hand; the shoe never leaves the server. */
export interface BlackjackState {
  shoe: Card[];
  player: Card[];
  dealer: Card[];
  doubled: boolean;
  actions: BlackjackAction[];
}

export function handTotal(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') {
      aces++;
      total += 11;
    } else total += ['10', 'J', 'Q', 'K'].includes(c.rank) ? 10 : Number(c.rank);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

const isBlackjack = (cards: Card[]) => cards.length === 2 && handTotal(cards).total === 21;

export interface BlackjackStep {
  state: BlackjackState;
  result: BlackjackResult;
  /** Total returned to the player once the hand is over (0 on a loss). */
  payout: bigint | null;
}

/** `stake` is the total at risk (twice the base after a double). */
function finish(
  state: BlackjackState,
  stake: bigint,
  forcedOutcome?: BlackjackResult['outcome'],
): BlackjackStep {
  const player = handTotal(state.player).total;
  let outcome = forcedOutcome ?? null;
  if (!outcome) {
    while (true) {
      const { total } = handTotal(state.dealer);
      if (total >= 17) break; // stands on all 17s, soft included
      state.dealer.push(draw(state.shoe));
    }
    const dealer = handTotal(state.dealer).total;
    outcome = dealer > 21 || player > dealer ? 'win' : player === dealer ? 'push' : 'lose';
  }
  const payout =
    outcome === 'blackjack'
      ? stake + (stake * 3n) / 2n
      : outcome === 'win'
        ? stake * 2n
        : outcome === 'push'
          ? stake
          : 0n;
  return { state, result: view(state, outcome), payout };
}

function view(state: BlackjackState, outcome: BlackjackResult['outcome']): BlackjackResult {
  const over = outcome !== null;
  return {
    game: 'BLACKJACK',
    player: state.player,
    dealer: over ? state.dealer : [state.dealer[0]!, null],
    playerTotal: handTotal(state.player).total,
    dealerTotal: over ? handTotal(state.dealer).total : null,
    doubled: state.doubled,
    outcome,
    actions: over ? [] : state.player.length === 2 ? ['hit', 'stand', 'double'] : ['hit', 'stand'],
  };
}

export function dealBlackjack(rng: Rng, stake: bigint): BlackjackStep {
  const shoe = shuffledShoe(6, rng);
  const state: BlackjackState = { shoe, player: [], dealer: [], doubled: false, actions: [] };
  state.player.push(draw(shoe));
  state.dealer.push(draw(shoe));
  state.player.push(draw(shoe));
  state.dealer.push(draw(shoe));
  const playerBj = isBlackjack(state.player);
  const dealerBj = isBlackjack(state.dealer);
  if (playerBj || dealerBj) {
    return finish(state, stake, playerBj && dealerBj ? 'push' : playerBj ? 'blackjack' : 'lose');
  }
  return { state, result: view(state, null), payout: null };
}

/**
 * Applies one action. `stake` is the total at risk after the action (the
 * caller doubles it for "double" and debits the difference).
 */
export function actBlackjack(
  state: BlackjackState,
  action: BlackjackAction,
  stake: bigint,
): BlackjackStep {
  if (action === 'double' && state.player.length !== 2)
    throw new Error('double is only allowed on the first two cards');
  state.actions.push(action);
  if (action === 'stand') return finish(state, stake);
  state.player.push(draw(state.shoe));
  if (action === 'double') state.doubled = true;
  const { total } = handTotal(state.player);
  if (total > 21) return finish(state, stake, 'bust');
  if (action === 'double' || total === 21) return finish(state, stake);
  return { state, result: view(state, null), payout: null };
}

/** Public view of a stored hand (used when a player resumes an open round). */
export function blackjackView(state: BlackjackState): BlackjackResult {
  return view(state, null);
}
