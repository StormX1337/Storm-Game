import { decimalToNumber, oddsToMilli, type DbOrTx } from '@storm-bet/database';
import type { MarketType } from '@storm-bet/types';
import {
  fitFootballModel,
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

/**
 * The Bet Builder price for legs as the book holds them now, or undefined
 * when the legs cannot form one (the slip evaluation says why).
 */
export async function builderPriceFor(
  db: DbOrTx,
  legs: readonly BookSelection[],
): Promise<BuilderPrice | undefined> {
  const first = legs[0];
  if (
    !first ||
    legs.length < 2 ||
    legs.some(
      (l) =>
        l.eventId !== first.eventId ||
        l.eventStatus !== 'SCHEDULED' ||
        !MODEL_MARKETS.has(l.marketType),
    )
  )
    return undefined;
  const model = fitFootballModel(await loadModelMarkets(db, first.eventId));
  if (!model || model.error > MAX_MODEL_ERROR) {
    return { ok: false, message: 'Für dieses Spiel ist gerade kein Bet Builder verfügbar.' };
  }
  return priceBuilder(
    model,
    legs.map((l) => ({
      marketType: l.marketType,
      line: l.line,
      outcome: l.outcome,
      oddsMilli: l.oddsMilli,
    })),
  );
}
