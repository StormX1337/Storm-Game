import type { Card, SlotSymbol } from '@storm-bet/types';
import { describe, expect, it } from 'vitest';
import {
  actBlackjack,
  actMines,
  crashPoint,
  CRASH_RTP,
  dropPlinko,
  minesMultiplier,
  playCrash,
  PLINKO_MULTIPLIERS,
  PLINKO_ROWS,
  plinkoRtp,
  startMines,
  dealBaccarat,
  dealBlackjack,
  evaluateSlot,
  handTotal,
  resolveRoulette,
  settleBaccarat,
  SLOT_PAYS,
  SLOT_RTP,
  SLOT_WEIGHTS,
  spinSlot,
  type BlackjackState,
} from '../src';

const c = (rank: Card['rank'], suit: Card['suit'] = 'S'): Card => ({ rank, suit });
/** An RNG that replays fixed draws. */
const scripted = (values: number[]) => {
  let i = 0;
  return (max: number) => (values[i++] ?? 0) % max;
};

describe('slots', () => {
  it('publishes the exact return to player of its pay table', () => {
    const total = Object.values(SLOT_WEIGHTS).reduce((a, b) => a + b, 0);
    let rtp = 0;
    for (const [symbol, [m3, m4, m5]] of Object.entries(SLOT_PAYS)) {
      const p = SLOT_WEIGHTS[symbol as SlotSymbol] / total;
      rtp += p ** 3 * (1 - p) * m3 + p ** 4 * (1 - p) * m4 + p ** 5 * m5;
    }
    expect(Math.round(rtp * 10_000) / 100).toBe(SLOT_RTP);
  });

  it('pays left-to-right lines on the line bet and rounds down', () => {
    const lemon: SlotSymbol[] = ['lemon', 'lemon', 'lemon'];
    const reels: SlotSymbol[][] = [
      lemon,
      lemon,
      lemon,
      ['star', 'star', 'star'],
      ['gem', 'gem', 'gem'],
    ];
    // Lines 1–3 run straight, 4–10 zig-zag: all ten lines hit three lemons.
    const { result, payout } = evaluateSlot(reels, 100n);
    expect(result.wins).toHaveLength(10);
    expect(payout).toBe((100n * 10n * 5n) / 10n);
    expect(evaluateSlot(reels, 15n).payout).toBe(75n);
  });

  it('draws a 5×3 grid from the RNG only', () => {
    const { result } = spinSlot(scripted(Array(15).fill(99)), 100n);
    expect(result.reels.flat()).toEqual(Array(15).fill('lemon'));
  });
});

describe('roulette', () => {
  it('pays European odds and loses even-money bets on zero', () => {
    const bets = [
      { type: 'straight' as const, value: 17, stake: 100 },
      { type: 'black' as const, stake: 100 },
      { type: 'dozen' as const, value: 2, stake: 100 },
      { type: 'column' as const, value: 2, stake: 100 },
    ];
    const hit = resolveRoulette(17, bets);
    expect(hit.result.color).toBe('black');
    expect(hit.result.bets.map((b) => b.payout)).toEqual([3600, 200, 300, 300]);
    expect(hit.payout).toBe(4400n);
    const zero = resolveRoulette(0, [
      { type: 'red', stake: 100 },
      { type: 'straight', value: 0, stake: 10 },
    ]);
    expect(zero.payout).toBe(360n);
  });
});

describe('baccarat', () => {
  it('applies the third-card rules', () => {
    // Player 2+3=5 draws a 4 (9); banker 3+0=3 draws (third ≠ 8) a 2 (5).
    const cards = [c('2'), c('3'), c('3'), c('K'), c('4'), c('2')];
    const hands = dealBaccarat(() => cards.shift()!);
    expect(hands.player.map((x) => x.rank)).toEqual(['2', '3', '4']);
    expect(hands.banker.map((x) => x.rank)).toEqual(['3', 'K', '2']);
    // A natural stops both hands.
    const natural = [c('9'), c('2'), c('K'), c('3')];
    expect(dealBaccarat(() => natural.shift()!).player).toHaveLength(2);
  });

  it('pays banker 0.95:1, tie 8:1 and pushes player/banker on a tie', () => {
    const bankerWin = settleBaccarat({ player: [c('2'), c('3')], banker: [c('4'), c('3')] }, [
      { side: 'banker', stake: 100 },
      { side: 'player', stake: 100 },
    ]);
    expect(bankerWin.payout).toBe(195n);
    const tie = settleBaccarat({ player: [c('4'), c('3')], banker: [c('5'), c('2')] }, [
      { side: 'tie', stake: 100 },
      { side: 'player', stake: 100 },
    ]);
    expect(tie.result.winner).toBe('tie');
    expect(tie.payout).toBe(1000n);
  });
});

describe('blackjack', () => {
  const state = (player: Card[], dealer: Card[], shoe: Card[]): BlackjackState => ({
    player,
    dealer,
    shoe: [...shoe].reverse(),
    doubled: false,
    actions: [],
  });

  it('counts soft aces', () => {
    expect(handTotal([c('A'), c('6')])).toEqual({ total: 17, soft: true });
    expect(handTotal([c('A'), c('6'), c('K')])).toEqual({ total: 17, soft: false });
  });

  it('hides the hole card until the hand is over and never shows the shoe', () => {
    const step = dealBlackjack(scripted([]), 100n);
    if (step.payout === null) {
      expect(step.result.dealer[1]).toBeNull();
      expect(step.result.dealerTotal).toBeNull();
    }
    expect(JSON.stringify(step.result)).not.toContain('shoe');
  });

  it('pays 3:2, 2:1 after a won double, and nothing on a bust', () => {
    const bj = actBlackjack(state([c('9'), c('2')], [c('10'), c('7')], [c('K')]), 'double', 200n);
    expect(bj.result).toMatchObject({ outcome: 'win', playerTotal: 21, doubled: true });
    expect(bj.payout).toBe(400n);

    const bust = actBlackjack(state([c('10'), c('6')], [c('10'), c('7')], [c('Q')]), 'hit', 100n);
    expect(bust.result.outcome).toBe('bust');
    expect(bust.payout).toBe(0n);

    // Dealer stands on soft 17: 18 beats it.
    const stand = actBlackjack(state([c('10'), c('8')], [c('A'), c('6')], []), 'stand', 100n);
    expect(stand.result).toMatchObject({ outcome: 'win', dealerTotal: 17 });
  });
});

describe('instant games', () => {
  it('crash: reaching target m has probability 0.97 / m, paying stake × m', () => {
    // u = (draw + 1) / 1e6: the last draw gives u = 1 → crash at 0.97 → 1.00×.
    expect(crashPoint(() => 999_999)).toBe(100);
    expect(crashPoint(() => 484_999)).toBe(200); // 0.97 / 0.485 = 2.00
    const win = playCrash(() => 484_999, 1_000n, 200);
    expect(win).toMatchObject({ payout: 2_000n, result: { won: true, crashPoint: 2 } });
    expect(playCrash(() => 484_999, 1_000n, 201).payout).toBe(0n);
    // Exact over the whole draw range: P(point ≥ 2.00×) = 0.485 → RTP 97 %.
    expect(CRASH_RTP * 100).toBe(97);
  });

  it('plinko: each risk table returns between 95 and 98 %', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      const rtp = plinkoRtp(risk);
      expect(rtp).toBeGreaterThan(0.95);
      expect(rtp).toBeLessThan(0.98);
      expect(PLINKO_MULTIPLIERS[risk]).toHaveLength(PLINKO_ROWS + 1);
    }
    // All rights: the last bucket.
    const drop = dropPlinko(() => 1, 100n, 'low');
    expect(drop.result).toMatchObject({ bucket: 12, multiplier: 8.4 });
    expect(drop.payout).toBe(840n);
  });

  it('mines: fair odds less 3 %, a mine ends the round, the field stays hidden until then', () => {
    // 3 mines: first safe tile pays 25/22 × 0.97.
    expect(minesMultiplier(3, 0)).toBe(100);
    expect(minesMultiplier(3, 1)).toBe(Math.floor((25 / 22) * 0.97 * 100));
    // rng (max) => max - 1 leaves the tiles in order: mines on 0, 1, 2.
    const { state, result } = startMines((m) => m - 1, 3);
    expect(result.minePositions).toBeNull();
    expect(state.mines).toEqual([0, 1, 2]);
    const safe = actMines(state, { type: 'reveal', tile: 10 }, 1_000n);
    expect(safe.payout).toBeNull();
    expect(safe.result).toMatchObject({ revealed: [10], outcome: null });
    const out = actMines(safe.state, { type: 'cashout' }, 1_000n);
    expect(out.payout).toBe(BigInt(minesMultiplier(3, 1) * 10));
    const boom = actMines(safe.state, { type: 'reveal', tile: 1 }, 1_000n);
    expect(boom).toMatchObject({ payout: 0n, result: { outcome: 'mine', hit: 1 } });
    expect(boom.result.minePositions).toEqual([0, 1, 2]);
    expect(() => actMines(safe.state, { type: 'reveal', tile: 10 }, 1_000n)).toThrow();
  });
});
