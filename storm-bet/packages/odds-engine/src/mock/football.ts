import type { FootballStatistics, GoalEvent, Pair, Side } from '@storm-bet/types';
import type { ProviderMarket, ProviderPlayer } from '../provider';
import {
  buildMarket,
  cancelledState,
  driftFactor,
  gameMinutes,
  preMatchState,
  type Quote,
  type SportModel,
} from './model';
import { MARGINS, poissonOver, poissonPmf, priceOutcomes, priceSingle } from './pricing';
import { createRng } from './random';

const HALF = 45;
const HALF_TIME_BREAK = 15;
const GOAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const HANDICAP_LINES = [-1.5, -0.5, 0, 0.5, 1.5];
const CORNER_LINES = [8.5, 9.5, 10.5, 11.5];
const CARD_LINES = [3.5, 4.5];
/** Markets close for this many simulated minutes after a goal or a red card. */
const SUSPENSION_MINUTES = 1.5;

interface Timed {
  /** Simulated minutes since kick-off, breaks included. */
  t: number;
  side: Side;
}

interface GoalPlan extends Timed {
  minute: number;
  player: ProviderPlayer | null;
}

export interface FootballPlan {
  lambda: Pair;
  cornerRate: Pair;
  cardRate: Pair;
  stoppage: [number, number];
  goals: GoalPlan[];
  corners: Timed[];
  yellowCards: Timed[];
  redCards: Timed[];
  shots: Timed[];
  possessionHome: number;
  scoringShare: Map<string, number>;
}

function playingMinutes(plan: FootballPlan): number {
  return 2 * HALF + plan.stoppage[0] + plan.stoppage[1];
}

/** Playing time u (0 … 90+stoppage) → simulated clock t (half-time break included). */
function toClock(plan: FootballPlan, u: number): number {
  return u < HALF + plan.stoppage[0] ? u : u + HALF_TIME_BREAK;
}

/** Simulated clock → minutes of play elapsed. */
function played(plan: FootballPlan, t: number): number {
  const firstHalf = HALF + plan.stoppage[0];
  if (t < firstHalf) return Math.max(0, t);
  if (t < firstHalf + HALF_TIME_BREAK) return firstHalf;
  return Math.min(playingMinutes(plan), t - HALF_TIME_BREAK);
}

function matchMinute(plan: FootballPlan, t: number): number {
  const firstHalf = HALF + plan.stoppage[0];
  if (t < firstHalf) return Math.min(HALF, Math.floor(t) + 1);
  return Math.min(2 * HALF, HALF + Math.floor(t - firstHalf - HALF_TIME_BREAK) + 1);
}

function clockLabel(plan: FootballPlan, t: number): string {
  const firstHalf = HALF + plan.stoppage[0];
  if (t < firstHalf) {
    const m = Math.floor(t) + 1;
    return m > HALF ? `45+${m - HALF}'` : `${m}'`;
  }
  const m = HALF + Math.floor(t - firstHalf - HALF_TIME_BREAK) + 1;
  return m > 2 * HALF ? `90+${m - 2 * HALF}'` : `${m}'`;
}

const POSITION_WEIGHT: Record<string, number> = { FW: 5, MF: 2, DF: 0.7, GK: 0.02 };

function scorers(players: ProviderPlayer[]): { player: ProviderPlayer; share: number }[] {
  const total = players.reduce((s, p) => s + (POSITION_WEIGHT[p.position ?? 'MF'] ?? 1), 0);
  return players.map((player) => ({
    player,
    share: (POSITION_WEIGHT[player.position ?? 'MF'] ?? 1) / total,
  }));
}

function teamRating(seed: string, teamId: string) {
  const rng = createRng(seed, 'football-team', teamId);
  return { attack: rng.normal(0, 0.22), defence: rng.normal(0, 0.2) };
}

export const footballModel: SportModel<FootballPlan> = {
  plan(ctx) {
    const rng = createRng(ctx.seed, ctx.externalId, 'football');
    const home = teamRating(ctx.seed, ctx.home.externalId);
    const away = teamRating(ctx.seed, ctx.away.externalId);
    const base = 1.32;
    const lambda = {
      home: base * Math.exp(home.attack - away.defence + 0.12 + rng.normal(0, 0.05)),
      away: base * Math.exp(away.attack - home.defence + rng.normal(0, 0.05)),
    };
    const cornerRate = {
      home: 4.9 * Math.exp((home.attack - away.defence) * 0.6),
      away: 4.5 * Math.exp((away.attack - home.defence) * 0.6),
    };
    const cardRate = { home: 1.9 + rng.next() * 0.6, away: 2.0 + rng.next() * 0.7 };
    const plan: FootballPlan = {
      lambda,
      cornerRate,
      cardRate,
      stoppage: [rng.int(1, 4), rng.int(2, 6)],
      goals: [],
      corners: [],
      yellowCards: [],
      redCards: [],
      shots: [],
      possessionHome: Math.round(50 + (home.attack - away.attack) * 25 + rng.normal(0, 4)),
      scoringShare: new Map(),
    };
    const total = playingMinutes(plan);
    const timed = (side: Side, count: number): Timed[] =>
      Array.from({ length: count }, () => ({ side, t: toClock(plan, rng.next() * total) }));

    for (const side of ['HOME', 'AWAY'] as const) {
      const team = side === 'HOME' ? ctx.home : ctx.away;
      const rate = side === 'HOME' ? lambda.home : lambda.away;
      const shares = scorers(team.players);
      for (const { player, share } of shares) plan.scoringShare.set(player.externalId, share);
      for (const goal of timed(side, rng.poisson(rate))) {
        const pick = shares.length ? rng.weighted(shares, (s) => s.share).player : null;
        plan.goals.push({ ...goal, minute: matchMinute(plan, goal.t), player: pick });
      }
      plan.corners.push(
        ...timed(side, rng.poisson(side === 'HOME' ? cornerRate.home : cornerRate.away)),
      );
      plan.yellowCards.push(
        ...timed(side, rng.poisson(side === 'HOME' ? cardRate.home : cardRate.away)),
      );
      if (rng.next() < 0.06) plan.redCards.push(...timed(side, 1));
      plan.shots.push(...timed(side, rng.poisson(3.2)));
    }
    for (const list of [plan.goals, plan.corners, plan.yellowCards, plan.redCards, plan.shots]) {
      list.sort((a, b) => a.t - b.t);
    }
    return plan;
  },

  totalGameMinutes(plan) {
    return playingMinutes(plan) + HALF_TIME_BREAK;
  },

  state(ctx, plan, now) {
    const t = gameMinutes(ctx, now);
    if (ctx.cancelled && now >= ctx.kickoff - 60 * 60_000) return cancelledState();
    if (t < 0) return preMatchState();
    const end = this.totalGameMinutes(plan);
    const finished = t >= end;
    const clock = Math.min(t, end);
    const upTo = <T extends Timed>(list: T[]) => list.filter((e) => e.t <= clock);
    const count = (list: Timed[]): Pair => ({
      home: upTo(list).filter((e) => e.side === 'HOME').length,
      away: upTo(list).filter((e) => e.side === 'AWAY').length,
    });
    const goals = count(plan.goals);
    const firstHalf = HALF + plan.stoppage[0];
    let period = '2H';
    if (finished) period = 'FT';
    else if (t < firstHalf) period = '1H';
    else if (t < firstHalf + HALF_TIME_BREAK) period = 'HT';

    // Possession wanders a little over the match but stays anchored to strength.
    const wobble = createRng(ctx.seed, ctx.externalId, 'possession', Math.floor(clock / 5)).normal(
      0,
      3,
    );
    const possessionHome = Math.max(25, Math.min(75, Math.round(plan.possessionHome + wobble)));
    const goalEvents: GoalEvent[] = upTo(plan.goals).map((g) => ({
      minute: g.minute,
      side: g.side,
      playerId: g.player?.externalId ?? null,
      playerName: g.player?.name ?? null,
    }));
    const statistics: FootballStatistics = {
      sport: 'football',
      goals,
      corners: count(plan.corners),
      yellowCards: count(plan.yellowCards),
      redCards: count(plan.redCards),
      shotsOnTarget: {
        home: goals.home + count(plan.shots).home,
        away: goals.away + count(plan.shots).away,
      },
      possession: { home: possessionHome, away: 100 - possessionHome },
      goalEvents,
    };

    let suspendedReason: string | null = null;
    if (!finished) {
      const recent = (e: Timed) => e.t <= t && t - e.t < SUSPENSION_MINUTES;
      if (plan.goals.some(recent)) suspendedReason = 'Tor';
      else if (plan.redCards.some(recent)) suspendedReason = 'Rote Karte';
    }
    return {
      status: finished ? 'FINISHED' : 'LIVE',
      score: goals,
      liveState: {
        period,
        clock: finished || period === 'HT' ? null : clockLabel(plan, t),
      },
      statistics,
      resultFinal: finished,
      suspendedReason,
    };
  },

  markets(ctx, plan, state, now) {
    const stats = state.statistics?.sport === 'football' ? state.statistics : null;
    const inPlay = state.status === 'LIVE';
    const t = Math.max(0, gameMinutes(ctx, now));
    const remaining = inPlay ? 1 - played(plan, t) / playingMinutes(plan) : 1;

    // Prices drift between buckets: every 5 minutes pre-match, every 20 s in play.
    const bucket = Math.floor(now / (inPlay ? 20_000 : 300_000));
    const drift = createRng(ctx.seed, ctx.externalId, 'drift', bucket);
    const spread = inPlay ? 0.04 : 0.03;
    const redFactor = (side: Side) =>
      Math.pow(0.78, stats ? (side === 'HOME' ? stats.redCards.home : stats.redCards.away) : 0);
    const lambda = {
      home: plan.lambda.home * remaining * driftFactor(drift.next(), spread) * redFactor('HOME'),
      away: plan.lambda.away * remaining * driftFactor(drift.next(), spread) * redFactor('AWAY'),
    };
    const current = stats?.goals ?? { home: 0, away: 0 };

    const maxGoals = 10;
    const pmfHome = poissonPmf(lambda.home, maxGoals);
    const pmfAway = poissonPmf(lambda.away, maxGoals);
    let pHome = 0;
    let pDraw = 0;
    let pAway = 0;
    let pBtts = 0;
    const diff = new Map<number, number>();
    const totals = new Map<number, number>();
    for (let x = 0; x <= maxGoals; x += 1) {
      for (let y = 0; y <= maxGoals; y += 1) {
        const p = (pmfHome[x] ?? 0) * (pmfAway[y] ?? 0);
        const h = current.home + x;
        const a = current.away + y;
        if (h > a) pHome += p;
        else if (h === a) pDraw += p;
        else pAway += p;
        if (h > 0 && a > 0) pBtts += p;
        diff.set(h - a, (diff.get(h - a) ?? 0) + p);
        totals.set(h + a, (totals.get(h + a) ?? 0) + p);
      }
    }

    const home = ctx.home.name;
    const away = ctx.away.name;
    const markets: ProviderMarket[] = [];
    const quotes = (items: Omit<Quote, 'odds'>[], margin: number): Quote[] => {
      const odds = priceOutcomes(
        items.map((i) => i.probability),
        margin,
      );
      return items.map((item, i) => ({ ...item, odds: odds[i] ?? 1.01 }));
    };

    markets.push(
      buildMarket(
        'MATCH_RESULT',
        null,
        quotes(
          [
            { outcome: 'HOME', name: home, probability: pHome },
            { outcome: 'DRAW', name: 'Unentschieden', probability: pDraw },
            { outcome: 'AWAY', name: away, probability: pAway },
          ],
          MARGINS.main,
        ),
        state,
      ),
    );

    // Double chance outcomes overlap, so each is priced from its own probability.
    const dc = (outcome: Quote['outcome'], name: string, probability: number): Quote => ({
      outcome,
      name,
      probability,
      odds: priceSingle(probability, MARGINS.main / 2),
    });
    markets.push(
      buildMarket(
        'DOUBLE_CHANCE',
        null,
        [
          dc('HOME_OR_DRAW', `${home} oder Unentschieden`, pHome + pDraw),
          dc('HOME_OR_AWAY', `${home} oder ${away}`, pHome + pAway),
          dc('DRAW_OR_AWAY', `Unentschieden oder ${away}`, pDraw + pAway),
        ],
        state,
      ),
    );

    markets.push(
      buildMarket(
        'DRAW_NO_BET',
        null,
        quotes(
          [
            { outcome: 'HOME', name: home, probability: pHome },
            { outcome: 'AWAY', name: away, probability: pAway },
          ],
          MARGINS.main,
        ),
        state,
      ),
    );

    const currentTotal = current.home + current.away;
    for (const line of GOAL_LINES) {
      let over = 0;
      for (const [total, p] of totals) if (total > line) over += p;
      markets.push(
        buildMarket(
          'TOTAL_GOALS',
          line,
          quotes(
            [
              { outcome: 'OVER', name: `Über ${line}`, probability: over },
              { outcome: 'UNDER', name: `Unter ${line}`, probability: 1 - over },
            ],
            MARGINS.totals,
          ),
          state,
          { closed: currentTotal > line },
        ),
      );
    }

    for (const line of HANDICAP_LINES) {
      // With whole lines a level result is a push (stake returned), so the
      // price reflects P(win) / (P(win) + P(lose)).
      let win = 0;
      let lose = 0;
      for (const [d, p] of diff) {
        const adjusted = d + line;
        if (adjusted > 0) win += p;
        else if (adjusted < 0) lose += p;
      }
      const decisive = win + lose || 1;
      const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
      markets.push(
        buildMarket(
          'ASIAN_HANDICAP',
          line,
          quotes(
            [
              { outcome: 'HOME', name: `${home} ${fmt(line)}`, probability: win / decisive },
              { outcome: 'AWAY', name: `${away} ${fmt(-line)}`, probability: lose / decisive },
            ],
            MARGINS.totals,
          ),
          state,
        ),
      );
    }

    markets.push(
      buildMarket(
        'BOTH_TEAMS_TO_SCORE',
        null,
        quotes(
          [
            { outcome: 'YES', name: 'Ja', probability: pBtts },
            { outcome: 'NO', name: 'Nein', probability: 1 - pBtts },
          ],
          MARGINS.props,
        ),
        state,
        { closed: current.home > 0 && current.away > 0 },
      ),
    );

    const corners = stats?.corners ?? { home: 0, away: 0 };
    const cornerLambda = (plan.cornerRate.home + plan.cornerRate.away) * remaining;
    for (const line of CORNER_LINES) {
      const soFar = corners.home + corners.away;
      const over = poissonOver(soFar, cornerLambda, line);
      markets.push(
        buildMarket(
          'TOTAL_CORNERS',
          line,
          quotes(
            [
              { outcome: 'OVER', name: `Über ${line}`, probability: over },
              { outcome: 'UNDER', name: `Unter ${line}`, probability: 1 - over },
            ],
            MARGINS.props,
          ),
          state,
          { closed: soFar > line },
        ),
      );
    }

    const cards = stats
      ? stats.yellowCards.home + stats.yellowCards.away + stats.redCards.home + stats.redCards.away
      : 0;
    const cardLambda = (plan.cardRate.home + plan.cardRate.away + 0.12) * remaining;
    for (const line of CARD_LINES) {
      const over = poissonOver(cards, cardLambda, line);
      markets.push(
        buildMarket(
          'TOTAL_CARDS',
          line,
          quotes(
            [
              { outcome: 'OVER', name: `Über ${line}`, probability: over },
              { outcome: 'UNDER', name: `Unter ${line}`, probability: 1 - over },
            ],
            MARGINS.props,
          ),
          state,
          { closed: cards > line },
        ),
      );
    }

    // Anytime goalscorer: attackers and midfielders of both sides.
    const scored = new Set(stats?.goalEvents.map((g) => g.playerId) ?? []);
    const playerQuotes: Quote[] = [];
    for (const [team, rate] of [
      [ctx.home, lambda.home],
      [ctx.away, lambda.away],
    ] as const) {
      for (const player of team.players.filter((p) => p.position === 'FW' || p.position === 'MF')) {
        const share = plan.scoringShare.get(player.externalId) ?? 0;
        const probability = 1 - Math.exp(-rate * share);
        playerQuotes.push({
          outcome: 'PLAYER',
          key: `PLAYER:${player.externalId}`,
          name: player.name,
          probability: scored.has(player.externalId) ? 1 : probability,
          odds: priceSingle(probability, MARGINS.players),
          decided: scored.has(player.externalId),
          playerExternalId: player.externalId,
        });
      }
    }
    markets.push(buildMarket('PLAYER_TO_SCORE', null, playerQuotes, state));
    return markets;
  },
};
