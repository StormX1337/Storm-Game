import type { MinesResult } from '@storm-bet/types';
import type { Rng } from '../rng';

export const MINES_TILES = 25;
export const MINES_RTP = 0.97;

/** Server-side state of an open field; mine positions never leave the server. */
export interface MinesState {
  mines: number[];
  revealed: number[];
  /** Action applied at each step (for idempotent retries). */
  actions: string[];
}

/**
 * Payout multiplier (hundredths) after `safe` safe tiles with `mines` mines:
 * the fair odds of surviving so long, less the house edge. No reveal: stake back.
 */
export function minesMultiplier(mines: number, safe: number): number {
  if (safe === 0) return 100;
  let fair = 1;
  for (let i = 0; i < safe; i += 1) fair *= (MINES_TILES - i) / (MINES_TILES - mines - i);
  return Math.floor(fair * MINES_RTP * 100);
}

function view(state: MinesState, outcome: MinesResult['outcome'], hit: number | null): MinesResult {
  const count = state.mines.length;
  const safe = state.revealed.length;
  return {
    game: 'MINES',
    mines: count,
    revealed: [...state.revealed],
    multiplier: minesMultiplier(count, safe) / 100,
    nextMultiplier: safe < MINES_TILES - count ? minesMultiplier(count, safe + 1) / 100 : null,
    outcome,
    hit,
    // Revealed only once the round is over.
    minePositions: outcome ? [...state.mines] : null,
  };
}

export function startMines(rng: Rng, mines: number): { result: MinesResult; state: MinesState } {
  if (!Number.isInteger(mines) || mines < 1 || mines >= MINES_TILES)
    throw new RangeError('mines out of range');
  const tiles = Array.from({ length: MINES_TILES }, (_, i) => i);
  for (let i = tiles.length - 1; i > 0; i -= 1) {
    const j = rng(i + 1);
    [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
  }
  const state: MinesState = {
    mines: tiles.slice(0, mines).sort((a, b) => a - b),
    revealed: [],
    actions: [],
  };
  return { result: view(state, null, null), state };
}

/** Reveals a tile or cashes out. payout null: the round goes on. */
export function actMines(
  state: MinesState,
  action: { type: 'reveal'; tile: number } | { type: 'cashout' },
  stake: bigint,
): { result: MinesResult; state: MinesState; payout: bigint | null } {
  const next: MinesState = {
    ...state,
    revealed: [...state.revealed],
    actions: [...state.actions, action.type === 'reveal' ? `reveal:${action.tile}` : 'cashout'],
  };
  const pay = () =>
    (stake * BigInt(minesMultiplier(next.mines.length, next.revealed.length))) / 100n;
  if (action.type === 'cashout') {
    return { result: view(next, 'cashout', null), state: next, payout: pay() };
  }
  const { tile } = action;
  if (!Number.isInteger(tile) || tile < 0 || tile >= MINES_TILES || next.revealed.includes(tile))
    throw new RangeError('tile not available');
  if (next.mines.includes(tile)) {
    return { result: view(next, 'mine', tile), state: next, payout: 0n };
  }
  next.revealed.push(tile);
  // Every safe tile found: paid out automatically.
  if (next.revealed.length === MINES_TILES - next.mines.length) {
    return { result: view(next, 'cashout', null), state: next, payout: pay() };
  }
  return { result: view(next, null, null), state: next, payout: null };
}
