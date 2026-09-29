import {
  isSupportedLine,
  marketKey,
  MARKET_DEFINITIONS,
  type BasketballStatistics,
  type EventStatistics,
  type FootballStatistics,
  type MarketStatus,
  type MarketType,
  type Pair,
  type SportKey,
  type TennisStatistics,
} from '@storm-bet/types';
import type { ProviderEvent, ProviderMarket, ProviderSelection } from '../provider';

/** Helpers shared by the providers for real (observed) data feeds. */

export interface ProviderQuota {
  remaining: number | null;
  used: number | null;
  lastCost: number | null;
  exhausted: boolean;
}

export const SPORT_NAMES: Record<SportKey, string> = {
  football: 'Fußball',
  tennis: 'Tennis',
  basketball: 'Basketball',
};

export function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Three decimals at most — the precision the book stores and compares. */
export function price(value: number): number | null {
  if (!Number.isFinite(value) || value <= 1) return null;
  return Math.round(value * 1000) / 1000;
}

/** American odds ("+150", "-115") as a decimal price. */
export function americanToDecimal(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
  return price(n > 0 ? 1 + n / 100 : 1 + 100 / -n);
}

export function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** A short, log-safe reason from an error response (API JSON `message`/`error` or plain text). */
export async function errorDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return '';
  }
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof body.message === 'string') text = body.message;
    else if (typeof body.error === 'string') text = body.error;
  } catch {
    // plain text
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Only what the feed reports: the score. Details stay absent, not zero. */
export function scoreStatistics(sport: SportKey, pair: Pair): EventStatistics {
  if (sport === 'football') {
    const stats: FootballStatistics = { sport: 'football', goals: pair };
    return stats;
  }
  if (sport === 'tennis') {
    const stats: TennisStatistics = {
      sport: 'tennis',
      sets: [],
      setsWon: pair,
      currentGame: null,
      server: null,
    };
    return stats;
  }
  const stats: BasketballStatistics = { sport: 'basketball', points: pair, periods: [] };
  return stats;
}

export interface MarketGate {
  status: MarketStatus;
  reason: string | null;
}

/**
 * Whether a real feed's prices may be bet on right now. In-play prices from a
 * snapshot go stale within seconds, so live markets stay suspended unless live
 * betting is enabled and the snapshot is fresh enough.
 */
export function marketGate(input: {
  eventStatus: ProviderEvent['status'];
  exhausted: boolean;
  liveBetting: boolean;
  ageMs: number;
  liveMaxAgeMs: number;
}): MarketGate {
  if (
    input.eventStatus === 'FINISHED' ||
    input.eventStatus === 'CANCELLED' ||
    input.eventStatus === 'POSTPONED'
  )
    return { status: 'CLOSED', reason: null };
  if (input.exhausted) return { status: 'SUSPENDED', reason: 'Datenkontingent erschöpft' };
  if (input.eventStatus === 'LIVE' && (!input.liveBetting || input.ageMs > input.liveMaxAgeMs))
    return { status: 'SUSPENDED', reason: 'Live-Quoten nicht aktuell genug' };
  return { status: 'OPEN', reason: null };
}

/** Decimal prices of one market as the feed quotes them, before validation. */
export type RawMarket =
  | { kind: 'THREE_WAY'; home: number | null; draw: number | null; away: number | null }
  | { kind: 'TWO_WAY'; home: number | null; away: number | null }
  | { kind: 'TOTAL'; line: number; over: number | null; under: number | null }
  | { kind: 'HANDICAP'; line: number; home: number | null; away: number | null };

function lineLabel(line: number, signed: boolean): string {
  const text = Number.isInteger(line) ? line.toFixed(1) : String(line);
  return signed && line > 0 ? `+${text}` : text;
}

/**
 * A validated market, or null when it must not be offered: a missing price,
 * an unsupported line (quarter lines split the stake) or a book without margin
 * (sum of implied probabilities below 100 % — prices mixed from different
 * bookmakers can do that, and the book would then pay out more than it takes).
 */
export function buildMarket(
  type: MarketType,
  raw: RawMarket,
  names: { home: string; away: string },
  gate: MarketGate,
): ProviderMarket | null {
  const definition = MARKET_DEFINITIONS[type];
  if (definition.kind !== raw.kind) return null;
  let line: number | null = null;
  let quotes: [ProviderSelection['outcome'], string, number | null][];
  switch (raw.kind) {
    case 'THREE_WAY':
      quotes = [
        ['HOME', names.home, raw.home],
        ['DRAW', 'Unentschieden', raw.draw],
        ['AWAY', names.away, raw.away],
      ];
      break;
    case 'TWO_WAY':
      quotes = [
        ['HOME', names.home, raw.home],
        ['AWAY', names.away, raw.away],
      ];
      break;
    case 'TOTAL':
      if (!isSupportedLine(raw.line) || raw.line <= 0) return null;
      line = raw.line;
      quotes = [
        ['OVER', `Über ${raw.line}`, raw.over],
        ['UNDER', `Unter ${raw.line}`, raw.under],
      ];
      break;
    case 'HANDICAP': {
      if (!isSupportedLine(raw.line)) return null;
      line = raw.line;
      const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
      quotes = [
        ['HOME', `${names.home} ${fmt(raw.line)}`, raw.home],
        ['AWAY', `${names.away} ${fmt(-raw.line)}`, raw.away],
      ];
      break;
    }
  }
  const prices = quotes.map(([, , odds]) => (odds === null ? null : price(odds)));
  if (prices.some((p) => p === null)) return null;
  const overround = prices.reduce<number>((sum, p) => sum + 1 / p!, 0);
  if (overround < 1) return null;

  const selectionStatus =
    gate.status === 'OPEN' ? 'OPEN' : gate.status === 'CLOSED' ? 'CLOSED' : 'SUSPENDED';
  return {
    key: marketKey(type, line),
    type,
    name:
      line == null
        ? definition.label
        : `${definition.label} ${lineLabel(line, definition.kind === 'HANDICAP')}`,
    line,
    status: gate.status,
    suspensionReason: gate.status === 'SUSPENDED' ? gate.reason : null,
    selections: quotes.map(([outcome, name], i) => ({
      key: outcome,
      name,
      outcome,
      odds: prices[i]!,
      status: selectionStatus,
      playerExternalId: null,
    })),
  };
}
