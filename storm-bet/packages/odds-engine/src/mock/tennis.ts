import type { Pair, Side, TennisStatistics } from '@storm-bet/types';
import type { ProviderMarket } from '../provider';
import {
  buildMarket,
  cancelledState,
  driftFactor,
  gameMinutes,
  preMatchState,
  type Quote,
  type SportModel,
} from './model';
import { MARGINS, priceOutcomes } from './pricing';
import { createRng, type Rng } from './random';

const SET_BREAK = 3;
const TOTAL_GAMES_LINES = [20.5, 21.5, 22.5, 23.5];
const GAME_HANDICAP_LINES = [-4.5, -2.5, 2.5, 4.5];

interface GamePlan {
  winner: Side;
  start: number;
  length: number;
  /** Point winners in order, the last point wins the game. */
  points: Side[];
}

interface SetPlan {
  winner: Side;
  games: GamePlan[];
  start: number;
  end: number;
}

export interface TennisPlan {
  /** P(home wins a set) before the match. */
  pSet: number;
  sets: SetPlan[];
  firstServer: Side;
  aceTimes: { t: number; side: Side }[];
}

const other = (side: Side): Side => (side === 'HOME' ? 'AWAY' : 'HOME');

// ─── Probability model ───────────────────────────────────────────────────────
// A set is a race of games won with probability q; 6-6 goes to a tie-break
// that the stronger player wins slightly more often than a game. q is solved
// so that P(set) matches the pre-match set probability.

type SetDistribution = Map<string, number>; // "gamesHome:gamesAway" → probability

function tiebreak(q: number): number {
  return Math.min(0.95, Math.max(0.05, 0.5 + (q - 0.5) * 1.3));
}

function setDistribution(q: number, a: number, b: number): SetDistribution {
  const memo = new Map<string, SetDistribution>();
  const walk = (x: number, y: number): SetDistribution => {
    const id = `${x}:${y}`;
    const cached = memo.get(id);
    if (cached) return cached;
    let result: SetDistribution;
    if ((x >= 6 && x - y >= 2) || x === 7) result = new Map([[id, 1]]);
    else if ((y >= 6 && y - x >= 2) || y === 7) result = new Map([[id, 1]]);
    else if (x === 6 && y === 6) {
      const tb = tiebreak(q);
      result = new Map([
        ['7:6', tb],
        ['6:7', 1 - tb],
      ]);
    } else {
      result = new Map();
      for (const [key, p] of walk(x + 1, y)) result.set(key, (result.get(key) ?? 0) + q * p);
      for (const [key, p] of walk(x, y + 1)) result.set(key, (result.get(key) ?? 0) + (1 - q) * p);
    }
    memo.set(id, result);
    return result;
  };
  return walk(a, b);
}

function setWinProbability(q: number, a = 0, b = 0): number {
  let p = 0;
  for (const [key, prob] of setDistribution(q, a, b)) {
    const [x, y] = key.split(':').map(Number) as [number, number];
    if (x > y) p += prob;
  }
  return p;
}

function solveGameProbability(pSet: number): number {
  let lo = 0.2;
  let hi = 0.8;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (setWinProbability(mid) < pSet) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

interface MatchOutcome {
  sets: Pair;
  games: Pair;
  firstSetWinner: Side;
}

/** Distribution over final outcomes from the current state (best of three). */
function matchDistribution(
  q: number,
  setsWon: Pair,
  current: Pair,
  gamesSoFar: Pair,
  firstSetWinner: Side | null,
): { outcome: MatchOutcome; p: number }[] {
  const out: { outcome: MatchOutcome; p: number }[] = [];
  const recurse = (sets: Pair, start: Pair, games: Pair, first: Side | null, p: number) => {
    if (sets.home === 2 || sets.away === 2) {
      out.push({ outcome: { sets, games, firstSetWinner: first ?? 'HOME' }, p });
      return;
    }
    for (const [key, prob] of setDistribution(q, start.home, start.away)) {
      const [x, y] = key.split(':').map(Number) as [number, number];
      const winner: Side = x > y ? 'HOME' : 'AWAY';
      recurse(
        {
          home: sets.home + (winner === 'HOME' ? 1 : 0),
          away: sets.away + (winner === 'AWAY' ? 1 : 0),
        },
        { home: 0, away: 0 },
        { home: games.home + x, away: games.away + y },
        first ?? winner,
        p * prob,
      );
    }
  };
  recurse(setsWon, current, gamesSoFar, firstSetWinner, 1);
  return out;
}

// ─── Simulation ──────────────────────────────────────────────────────────────

function finalSetScore(rng: Rng, winner: Side, q: number): Pair {
  const strength = winner === 'HOME' ? q : 1 - q;
  const dist = setDistribution(strength, 0, 0);
  const wins = [...dist].filter(([key]) => {
    const [x, y] = key.split(':').map(Number) as [number, number];
    return x > y;
  });
  const [key] = rng.weighted(wins, ([, p]) => p);
  const [w, l] = key.split(':').map(Number) as [number, number];
  return winner === 'HOME' ? { home: w, away: l } : { home: l, away: w };
}

/** Game winners in an order that reaches exactly the final score. */
function gameSequence(rng: Rng, score: Pair, winner: Side): Side[] {
  const loser = other(winner);
  const w = winner === 'HOME' ? score.home : score.away;
  const l = winner === 'HOME' ? score.away : score.home;
  if (w === 6) {
    // Any order of 5 winner and l loser games, then the winner closes it out.
    return [
      ...rng.shuffle([...Array<Side>(5).fill(winner), ...Array<Side>(l).fill(loser)]),
      winner,
    ];
  }
  // 7-5 and 7-6: pairs keep the set level until 5-5 / 6-6.
  const pairs = l === 5 ? 5 : 6;
  const seq: Side[] = [];
  for (let i = 0; i < pairs; i += 1) {
    seq.push(...(rng.next() < 0.5 ? [winner, loser] : [loser, winner]));
  }
  if (l === 5) seq.push(winner, winner);
  else seq.push(winner);
  return seq;
}

function pointSequence(rng: Rng, winner: Side): Side[] {
  const loser = other(winner);
  const loserPoints = rng.weighted([0, 1, 2, 3], (k) => [0.25, 0.3, 0.25, 0.2][k] ?? 0);
  if (loserPoints < 3) {
    return [
      ...rng.shuffle([...Array<Side>(3).fill(winner), ...Array<Side>(loserPoints).fill(loser)]),
      winner,
    ];
  }
  const seq: Side[] = [];
  for (let i = 0; i < 3; i += 1)
    seq.push(...(rng.next() < 0.5 ? [winner, loser] : [loser, winner]));
  seq.push(winner, winner);
  return seq;
}

const POINT_LABELS = ['0', '15', '30', '40'];

function pointLabels(points: Side[], upTo: number): { home: string; away: string } {
  let h = 0;
  let a = 0;
  for (const side of points.slice(0, upTo)) {
    if (side === 'HOME') h += 1;
    else a += 1;
  }
  if (h >= 3 && a >= 3) {
    if (h === a) return { home: '40', away: '40' };
    return h > a ? { home: 'AD', away: '40' } : { home: '40', away: 'AD' };
  }
  return { home: POINT_LABELS[Math.min(h, 3)] ?? '40', away: POINT_LABELS[Math.min(a, 3)] ?? '40' };
}

function rating(seed: string, playerId: string): number {
  return createRng(seed, 'tennis-player', playerId).normal(0, 0.6);
}

export const tennisModel: SportModel<TennisPlan> = {
  plan(ctx) {
    const rng = createRng(ctx.seed, ctx.externalId, 'tennis');
    const diff = rating(ctx.seed, ctx.home.externalId) - rating(ctx.seed, ctx.away.externalId);
    const pSet = 1 / (1 + Math.exp(-1.1 * diff));
    const q = solveGameProbability(pSet);
    const sets: SetPlan[] = [];
    const won: Pair = { home: 0, away: 0 };
    let t = 0;
    while (won.home < 2 && won.away < 2) {
      const winner: Side = rng.next() < pSet ? 'HOME' : 'AWAY';
      const score = finalSetScore(rng, winner, q);
      const games: GamePlan[] = gameSequence(rng, score, winner).map((gameWinner) => {
        const length = 3 + rng.next() * 2.5;
        const game: GamePlan = {
          winner: gameWinner,
          start: t,
          length,
          points: pointSequence(rng, gameWinner),
        };
        t += length;
        return game;
      });
      sets.push({ winner, games, start: games[0]?.start ?? t, end: t });
      if (winner === 'HOME') won.home += 1;
      else won.away += 1;
      t += SET_BREAK;
    }
    const end = sets[sets.length - 1]?.end ?? 0;
    const aceTimes = (['HOME', 'AWAY'] as const).flatMap((side) =>
      Array.from({ length: rng.poisson(5) }, () => ({ t: rng.next() * end, side })),
    );
    return { pSet, sets, firstServer: rng.next() < 0.5 ? 'HOME' : 'AWAY', aceTimes };
  },

  totalGameMinutes(plan) {
    return plan.sets[plan.sets.length - 1]?.end ?? 0;
  },

  state(ctx, plan, now) {
    if (ctx.cancelled && now >= ctx.kickoff - 60 * 60_000) return cancelledState();
    const t = gameMinutes(ctx, now);
    if (t < 0) return preMatchState();
    const finished = t >= this.totalGameMinutes(plan);
    const sets: Pair[] = [];
    const setsWon: Pair = { home: 0, away: 0 };
    let currentGame: { home: string; away: string } | null = null;
    let gamesPlayed = 0;
    let setIndex = 0;
    for (const set of plan.sets) {
      if (set.start > t && !finished) break;
      const score: Pair = { home: 0, away: 0 };
      for (const game of set.games) {
        if (finished || game.start + game.length <= t) {
          if (game.winner === 'HOME') score.home += 1;
          else score.away += 1;
          gamesPlayed += 1;
        } else if (game.start <= t) {
          const progress = (t - game.start) / game.length;
          currentGame = pointLabels(game.points, Math.floor(progress * game.points.length));
        }
      }
      sets.push(score);
      if (finished || set.end <= t) {
        if (set.winner === 'HOME') setsWon.home += 1;
        else setsWon.away += 1;
      }
      setIndex += 1;
    }
    const server: Side = gamesPlayed % 2 === 0 ? plan.firstServer : other(plan.firstServer);
    const aces = {
      home: plan.aceTimes.filter((a) => a.side === 'HOME' && (finished || a.t <= t)).length,
      away: plan.aceTimes.filter((a) => a.side === 'AWAY' && (finished || a.t <= t)).length,
    };
    const statistics: TennisStatistics = {
      sport: 'tennis',
      sets,
      setsWon,
      currentGame: finished ? null : (currentGame ?? { home: '0', away: '0' }),
      server: finished ? null : server,
      aces,
    };
    return {
      status: finished ? 'FINISHED' : 'LIVE',
      score: setsWon,
      liveState: {
        period: finished ? 'FT' : `S${Math.max(1, Math.min(3, setIndex))}`,
        clock: null,
      },
      statistics,
      resultFinal: finished,
      suspendedReason: null,
    };
  },

  markets(ctx, plan, state, now) {
    const stats = state.statistics?.sport === 'tennis' ? state.statistics : null;
    const inPlay = state.status === 'LIVE';
    const bucket = Math.floor(now / (inPlay ? 20_000 : 300_000));
    const drift = createRng(ctx.seed, ctx.externalId, 'drift', bucket);
    const pSet = Math.min(
      0.97,
      Math.max(0.03, plan.pSet * driftFactor(drift.next(), inPlay ? 0.05 : 0.03)),
    );
    const q = solveGameProbability(pSet);

    const setsWon = stats?.setsWon ?? { home: 0, away: 0 };
    const completed = stats ? stats.sets.slice(0, setsWon.home + setsWon.away) : [];
    const inProgress = stats?.sets[setsWon.home + setsWon.away] ?? { home: 0, away: 0 };
    const gamesSoFar = completed.reduce(
      (acc, s) => ({ home: acc.home + s.home, away: acc.away + s.away }),
      { home: 0, away: 0 },
    );
    const firstDone = completed[0];
    const firstSetWinner: Side | null = firstDone
      ? firstDone.home > firstDone.away
        ? 'HOME'
        : 'AWAY'
      : null;
    const dist = matchDistribution(q, setsWon, inProgress, gamesSoFar, firstSetWinner);

    const sum = (pred: (o: MatchOutcome) => boolean) =>
      dist.reduce((acc, { outcome, p }) => acc + (pred(outcome) ? p : 0), 0);
    const home = ctx.home.name;
    const away = ctx.away.name;
    const quotes = (items: Omit<Quote, 'odds'>[], margin: number): Quote[] => {
      const odds = priceOutcomes(
        items.map((i) => i.probability),
        margin,
      );
      return items.map((item, i) => ({ ...item, odds: odds[i] ?? 1.01 }));
    };
    const markets: ProviderMarket[] = [];
    const pHome = sum((o) => o.sets.home === 2);
    markets.push(
      buildMarket(
        'MATCH_WINNER',
        null,
        quotes(
          [
            { outcome: 'HOME', name: home, probability: pHome },
            { outcome: 'AWAY', name: away, probability: 1 - pHome },
          ],
          MARGINS.main,
        ),
        state,
      ),
    );
    const pFirst = sum((o) => o.firstSetWinner === 'HOME');
    markets.push(
      buildMarket(
        'FIRST_SET_WINNER',
        null,
        quotes(
          [
            { outcome: 'HOME', name: home, probability: pFirst },
            { outcome: 'AWAY', name: away, probability: 1 - pFirst },
          ],
          MARGINS.main,
        ),
        state,
        { closed: firstSetWinner !== null },
      ),
    );
    markets.push(
      buildMarket(
        'SET_BETTING',
        null,
        quotes(
          [
            {
              outcome: 'SETS_2_0',
              name: `${home} 2:0`,
              probability: sum((o) => o.sets.home === 2 && o.sets.away === 0),
            },
            {
              outcome: 'SETS_2_1',
              name: `${home} 2:1`,
              probability: sum((o) => o.sets.home === 2 && o.sets.away === 1),
            },
            {
              outcome: 'SETS_1_2',
              name: `${away} 2:1`,
              probability: sum((o) => o.sets.home === 1 && o.sets.away === 2),
            },
            {
              outcome: 'SETS_0_2',
              name: `${away} 2:0`,
              probability: sum((o) => o.sets.home === 0 && o.sets.away === 2),
            },
          ],
          MARGINS.props,
        ),
        state,
      ),
    );
    const playedGames = gamesSoFar.home + gamesSoFar.away + inProgress.home + inProgress.away;
    for (const line of TOTAL_GAMES_LINES) {
      const over = sum((o) => o.games.home + o.games.away > line);
      markets.push(
        buildMarket(
          'TOTAL_GAMES',
          line,
          quotes(
            [
              { outcome: 'OVER', name: `Über ${line}`, probability: over },
              { outcome: 'UNDER', name: `Unter ${line}`, probability: 1 - over },
            ],
            MARGINS.totals,
          ),
          state,
          { closed: playedGames > line },
        ),
      );
    }
    for (const line of GAME_HANDICAP_LINES) {
      const cover = sum((o) => o.games.home + line > o.games.away);
      const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
      markets.push(
        buildMarket(
          'GAME_HANDICAP',
          line,
          quotes(
            [
              { outcome: 'HOME', name: `${home} ${fmt(line)}`, probability: cover },
              { outcome: 'AWAY', name: `${away} ${fmt(-line)}`, probability: 1 - cover },
            ],
            MARGINS.totals,
          ),
          state,
        ),
      );
    }
    return markets;
  },
};

export const __testing = { setWinProbability, solveGameProbability, setDistribution };
