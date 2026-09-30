import { decimalToNumber, oddsToMilli, type DbOrTx } from '@storm-bet/database';
import type { MarketType, Pair } from '@storm-bet/types';
import {
  BUILDER_MARGIN,
  fitFootballModel,
  LIVE_BUILDER_MARGIN,
  LIVE_MODEL_MARKETS,
  MAX_MODEL_ERROR,
  MODEL_MARKETS,
  priceBuilder,
  type BuilderPrice,
  type ModelMarket,
} from '../domain/football-model';
import type { BookSelection } from '../domain/slip';

/** The markets the model is fitted to. */
const FIT_MARKETS: MarketType[] = [
  'MATCH_RESULT',
  'TOTAL_GOALS',
  'HALF_TIME_RESULT',
  'FIRST_HALF_TOTAL_GOALS',
  'TOTAL_CORNERS',
  'TOTAL_CARDS',
];

/** The open prices of a match the model is fitted to, in a stable order. */
export async function loadModelMarkets(db: DbOrTx, eventId: string): Promise<ModelMarket[]> {
  const markets = await db.market.findMany({
    where: { eventId, status: 'OPEN', tradingSuspended: false, type: { in: FIT_MARKETS } },
    select: {
      type: true,
      line: true,
      selections: { where: { status: 'OPEN' }, select: { outcome: true, odds: true } },
    },
    orderBy: { key: 'asc' },
  });
  return markets.map((m) => ({
    type: m.type,
    line: decimalToNumber(m.line),
    selections: m.selections.map((s) => ({ outcome: s.outcome, odds: oddsToMilli(s.odds) / 1000 })),
  }));
}

/** Home or away for each goalscorer selection, from the player's team. */
async function scorerSides(
  db: DbOrTx,
  eventId: string,
  selectionIds: string[],
): Promise<Map<string, 'HOME' | 'AWAY'>> {
  const out = new Map<string, 'HOME' | 'AWAY'>();
  if (!selectionIds.length) return out;
  const [event, selections] = await Promise.all([
    db.event.findUniqueOrThrow({
      where: { id: eventId },
      select: { homeTeamId: true, awayTeamId: true },
    }),
    db.selection.findMany({
      where: { id: { in: selectionIds } },
      select: { id: true, player: { select: { teamId: true } } },
    }),
  ]);
  for (const s of selections) {
    if (s.player?.teamId === event.homeTeamId) out.set(s.id, 'HOME');
    else if (s.player?.teamId === event.awayTeamId) out.set(s.id, 'AWAY');
  }
  return out;
}

/**
 * The Bet Builder price for legs as the book holds them now, or undefined
 * when the legs cannot form one (the slip evaluation says why). In play the
 * model starts from the current score.
 */
export async function builderPriceFor(
  db: DbOrTx,
  legs: readonly BookSelection[],
): Promise<BuilderPrice | undefined> {
  const first = legs[0];
  if (!first || legs.length < 2) return undefined;
  const live = first.eventStatus === 'LIVE';
  const allowed = live ? LIVE_MODEL_MARKETS : MODEL_MARKETS;
  if (
    legs.some(
      (l) =>
        l.eventId !== first.eventId ||
        l.eventStatus !== first.eventStatus ||
        !(l.eventStatus === 'SCHEDULED' || l.eventStatus === 'LIVE') ||
        !allowed.has(l.marketType),
    )
  )
    return undefined;
  const score: Pair | undefined = live
    ? { home: first.homeScore ?? 0, away: first.awayScore ?? 0 }
    : undefined;
  const model = fitFootballModel(await loadModelMarkets(db, first.eventId), score);
  if (!model || model.error > MAX_MODEL_ERROR) {
    return { ok: false, message: 'Für dieses Spiel ist gerade kein Bet Builder verfügbar.' };
  }
  const scorers = legs.filter((l) => l.marketType === 'PLAYER_TO_SCORE');
  const sides = await scorerSides(
    db,
    first.eventId,
    scorers.map((l) => l.selectionId),
  );
  if (scorers.some((l) => !sides.has(l.selectionId))) {
    return { ok: false, message: 'Dieser Torschütze kann nicht im Bet Builder gewählt werden.' };
  }
  return priceBuilder(
    model,
    legs.map((l) => ({
      marketType: l.marketType,
      line: l.line,
      outcome: l.outcome,
      oddsMilli: l.oddsMilli,
      ...(l.marketType === 'PLAYER_TO_SCORE'
        ? { player: { side: sides.get(l.selectionId)!, probability: 1000 / l.oddsMilli } }
        : {}),
    })),
    live ? LIVE_BUILDER_MARGIN : BUILDER_MARGIN,
  );
}
