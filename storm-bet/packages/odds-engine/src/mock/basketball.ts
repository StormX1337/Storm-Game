import type { BasketballStatistics, Pair } from '@storm-bet/types';
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
import { MARGINS, normalCdf, priceOutcomes } from './pricing';
import { createRng } from './random';

const QUARTER = 10;
const OVERTIME = 5;
/** Breaks after Q1, Q2 (half-time), Q3 and before each overtime. */
const BREAKS = [2, 10, 2];
const OT_BREAK = 2;
const SD_DIFF = 12;
const SD_TOTAL = 16;

interface Period {
  start: number;
  length: number;
  points: Pair;
  /** Cumulative scoring profile per minute, 0 → 1, per side. */
  profile: { home: number[]; away: number[] };
}

export interface BasketballPlan {
  mean: Pair;
  periods: Period[];
  spreadCentre: number;
  totalCentre: number;
}

function rating(seed: string, teamId: string) {
  const rng = createRng(seed, 'basketball-team', teamId);
  return { offence: rng.normal(0, 5), defence: rng.normal(0, 4) };
}

function profile(seed: string, id: string, index: number, side: string, minutes: number): number[] {
  const rng = createRng(seed, id, 'profile', index, side);
  const weights = Array.from({ length: minutes }, () => 0.4 + rng.next());
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return weights.map((w) => (acc += w) / total);
}

function progress(curve: number[], elapsed: number): number {
  if (elapsed <= 0) return 0;
  const whole = Math.floor(elapsed);
  const before = whole === 0 ? 0 : (curve[whole - 1] ?? 1);
  const after = curve[whole] ?? 1;
  return before + (after - before) * (elapsed - whole);
}

function totalScore(plan: BasketballPlan): Pair {
  return plan.periods.reduce(
    (acc, p) => ({ home: acc.home + p.points.home, away: acc.away + p.points.away }),
    { home: 0, away: 0 },
  );
}

/** Nearest half point, so spread and total lines can never push. */
function halfLine(value: number): number {
  return Math.floor(value) + 0.5;
}

export const basketballModel: SportModel<BasketballPlan> = {
  plan(ctx) {
    const rng = createRng(ctx.seed, ctx.externalId, 'basketball');
    const home = rating(ctx.seed, ctx.home.externalId);
    const away = rating(ctx.seed, ctx.away.externalId);
    const mean = {
      home: 84 + home.offence - away.defence + 2.5,
      away: 84 + away.offence - home.defence,
    };
    const periods: Period[] = [];
    let t = 0;
    const addPeriod = (length: number, perMinute: Pair, index: number) => {
      const points = {
        home: Math.max(
          0,
          Math.round(rng.normal(perMinute.home * length, 3.2 * Math.sqrt(length / QUARTER))),
        ),
        away: Math.max(
          0,
          Math.round(rng.normal(perMinute.away * length, 3.2 * Math.sqrt(length / QUARTER))),
        ),
      };
      periods.push({
        start: t,
        length,
        points,
        profile: {
          home: profile(ctx.seed, ctx.externalId, index, 'home', length),
          away: profile(ctx.seed, ctx.externalId, index, 'away', length),
        },
      });
      t += length;
    };
    const perMinute = { home: mean.home / 40, away: mean.away / 40 };
    for (let q = 0; q < 4; q += 1) {
      addPeriod(QUARTER, perMinute, q);
      if (q < 3) t += BREAKS[q] ?? 2;
    }
    let index = 4;
    while (true) {
      const score = periods.reduce(
        (acc, p) => ({ home: acc.home + p.points.home, away: acc.away + p.points.away }),
        { home: 0, away: 0 },
      );
      if (score.home !== score.away || index > 8) break;
      t += OT_BREAK;
      addPeriod(OVERTIME, perMinute, index);
      index += 1;
    }
    // Guarantee a winner even in the (astronomically rare) tie after 5 OTs.
    const final = periods.reduce((acc, p) => acc + p.points.home - p.points.away, 0);
    const last = periods[periods.length - 1];
    if (final === 0 && last) last.points.home += 1;
    return {
      mean,
      periods,
      spreadCentre: halfLine(mean.home - mean.away),
      totalCentre: halfLine(mean.home + mean.away),
    };
  },

  totalGameMinutes(plan) {
    const last = plan.periods[plan.periods.length - 1];
    return last ? last.start + last.length : 0;
  },

  state(ctx, plan, now) {
    if (ctx.cancelled && now >= ctx.kickoff - 60 * 60_000) return cancelledState();
    const t = gameMinutes(ctx, now);
    if (t < 0) return preMatchState();
    const finished = t >= this.totalGameMinutes(plan);
    const periods: Pair[] = [];
    let current: { label: string; clock: string | null } = { label: 'Q1', clock: '10:00' };
    plan.periods.forEach((period, i) => {
      if (!finished && period.start > t) return;
      const elapsed = finished ? period.length : Math.min(period.length, t - period.start);
      periods.push({
        home: Math.floor(period.points.home * progress(period.profile.home, elapsed) + 1e-9),
        away: Math.floor(period.points.away * progress(period.profile.away, elapsed) + 1e-9),
      });
      const label = i < 4 ? `Q${i + 1}` : 'OT';
      const left = Math.max(0, period.length - elapsed);
      const mm = Math.floor(left);
      const ss = Math.floor((left - mm) * 60);
      current = {
        label,
        clock: left > 0 ? `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : null,
      };
    });
    const points = periods.reduce(
      (acc, p) => ({ home: acc.home + p.home, away: acc.away + p.away }),
      { home: 0, away: 0 },
    );
    const foulRng = createRng(ctx.seed, ctx.externalId, 'fouls');
    const share = finished ? 1 : Math.min(1, t / this.totalGameMinutes(plan));
    const statistics: BasketballStatistics = {
      sport: 'basketball',
      points,
      periods,
      fouls: {
        home: Math.round((15 + foulRng.next() * 8) * share),
        away: Math.round((15 + foulRng.next() * 8) * share),
      },
    };
    return {
      status: finished ? 'FINISHED' : 'LIVE',
      score: points,
      liveState: {
        period: finished ? 'FT' : current.label,
        clock: finished ? null : current.clock,
      },
      statistics,
      resultFinal: finished,
      suspendedReason: null,
    };
  },

  markets(ctx, plan, state, now) {
    const stats = state.statistics?.sport === 'basketball' ? state.statistics : null;
    const inPlay = state.status === 'LIVE';
    const t = Math.max(0, gameMinutes(ctx, now));
    const regulationMinutes = 4 * QUARTER;
    const played = inPlay
      ? plan.periods.reduce((acc, p) => acc + Math.max(0, Math.min(p.length, t - p.start)), 0)
      : 0;
    const remaining = Math.max(0.02, 1 - Math.min(played, regulationMinutes) / regulationMinutes);
    const bucket = Math.floor(now / (inPlay ? 15_000 : 300_000));
    const drift = createRng(ctx.seed, ctx.externalId, 'drift', bucket);
    const meanHome = plan.mean.home * remaining * driftFactor(drift.next(), 0.02);
    const meanAway = plan.mean.away * remaining * driftFactor(drift.next(), 0.02);
    const soFar = stats?.points ?? { home: 0, away: 0 };
    const diffMean = soFar.home - soFar.away + meanHome - meanAway;
    const totalMean = soFar.home + soFar.away + meanHome + meanAway;
    const sdDiff = SD_DIFF * Math.sqrt(remaining);
    const sdTotal = SD_TOTAL * Math.sqrt(remaining);

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
    const pHome = normalCdf(diffMean / sdDiff);
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
    const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
    for (const offset of [-3, 0, 3]) {
      // Home line: home covers when (home - away) + line > 0.
      const line = -(plan.spreadCentre + offset);
      const cover = normalCdf((diffMean + line) / sdDiff);
      markets.push(
        buildMarket(
          'POINT_SPREAD',
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
    for (const offset of [-5, 0, 5]) {
      const line = plan.totalCentre + offset;
      const over = 1 - normalCdf((line - totalMean) / sdTotal);
      markets.push(
        buildMarket(
          'TOTAL_POINTS',
          line,
          quotes(
            [
              { outcome: 'OVER', name: `Über ${line}`, probability: over },
              { outcome: 'UNDER', name: `Unter ${line}`, probability: 1 - over },
            ],
            MARGINS.totals,
          ),
          state,
          { closed: soFar.home + soFar.away > line },
        ),
      );
    }
    return markets;
  },
};

export const __testing = { totalScore };
