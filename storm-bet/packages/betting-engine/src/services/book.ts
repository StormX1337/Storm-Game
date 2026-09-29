import { decimalToNumber, oddsToMilli, type DbOrTx, type Tx } from '@storm-bet/database';
import type { BookSelection } from '../domain/slip';

const BOOK_INCLUDE = {
  market: {
    include: {
      event: {
        include: {
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      },
    },
  },
} as const;

/** Loads the book's view of the given selections in a single query. */
export async function loadBook(
  db: DbOrTx,
  selectionIds: string[],
): Promise<Map<string, BookSelection>> {
  const rows = await db.selection.findMany({
    where: { id: { in: selectionIds } },
    include: BOOK_INCLUDE,
  });
  const out = new Map<string, BookSelection>();
  for (const s of rows) {
    const { market } = s;
    const { event } = market;
    out.set(s.id, {
      selectionId: s.id,
      selectionName: s.name,
      outcome: s.outcome,
      selectionStatus: s.status,
      oddsMilli: oddsToMilli(s.odds),
      oddsVersion: s.oddsVersion,
      marketId: market.id,
      marketName: market.name,
      marketType: market.type,
      line: decimalToNumber(market.line),
      marketStatus: market.status,
      marketTradingSuspended: market.tradingSuspended,
      eventId: event.id,
      eventName: `${event.homeTeam.name} – ${event.awayTeam.name}`,
      eventStatus: event.status,
      eventIsActive: event.isActive,
      eventTradingSuspended: event.tradingSuspended,
      startTime: event.startTime,
      homeScore: event.homeScore,
      awayScore: event.awayScore,
      provider: event.provider,
    });
  }
  return out;
}

/**
 * Share-locks every row a bet depends on — events, then markets, then
 * selections, each in id order — and then reads them. Until the transaction
 * ends, no price, status or suspension can change underneath the bet; an odds
 * update arriving meanwhile waits and applies right after.
 */
export async function lockAndLoadBook(
  tx: Tx,
  selectionIds: string[],
): Promise<Map<string, BookSelection>> {
  const ids = [...new Set(selectionIds)].sort();
  const refs = await tx.$queryRaw<{ id: string; market_id: string; event_id: string }[]>`
    SELECT s."id", s."market_id", m."event_id"
    FROM "selections" s JOIN "markets" m ON m."id" = s."market_id"
    WHERE s."id" = ANY(${ids}::uuid[])`;
  const eventIds = [...new Set(refs.map((r) => r.event_id))].sort();
  const marketIds = [...new Set(refs.map((r) => r.market_id))].sort();
  if (eventIds.length) {
    await tx.$queryRaw`SELECT "id" FROM "events" WHERE "id" = ANY(${eventIds}::uuid[]) ORDER BY "id" FOR SHARE`;
  }
  if (marketIds.length) {
    await tx.$queryRaw`SELECT "id" FROM "markets" WHERE "id" = ANY(${marketIds}::uuid[]) ORDER BY "id" FOR SHARE`;
  }
  if (refs.length) {
    await tx.$queryRaw`SELECT "id" FROM "selections" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR SHARE`;
  }
  return loadBook(tx, ids);
}
