import { describe, expect, it } from 'vitest';
import {
  decimalOdds,
  eventStatisticsSchema,
  placeBetSchema,
  registerSchema,
  streamQuery,
} from '../src';

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe('register', () => {
  it('normalises the email and requires consent', () => {
    const ok = registerSchema.parse({
      email: '  Player@Example.COM ',
      password: 'secret-pass-1',
      displayName: 'Player One',
      ageConfirmed: true,
      termsAccepted: true,
    });
    expect(ok.email).toBe('player@example.com');
    expect(
      registerSchema.safeParse({ ...ok, password: 'secret-pass-1', ageConfirmed: false }).success,
    ).toBe(false);
  });

  it('enforces password strength', () => {
    const r = registerSchema.safeParse({
      email: 'a@b.de',
      password: 'onlyletters',
      displayName: 'Abc',
      ageConfirmed: true,
      termsAccepted: true,
    });
    expect(r.success).toBe(false);
  });
});

describe('odds and slips', () => {
  it('accepts at most three decimals', () => {
    expect(decimalOdds.safeParse(1.65).success).toBe(true);
    expect(decimalOdds.safeParse(1.833).success).toBe(true);
    expect(decimalOdds.safeParse(1.8333).success).toBe(false);
    expect(decimalOdds.safeParse(1).success).toBe(false);
  });

  it('rejects duplicate selections and fractional stakes', () => {
    const base = { idempotencyKey: id(9), oddsChangePolicy: 'REJECT' as const };
    expect(
      placeBetSchema.safeParse({
        ...base,
        mode: 'COMBO',
        stake: 1000,
        selections: [
          { selectionId: id(1), odds: 1.5 },
          { selectionId: id(1), odds: 1.5 },
        ],
      }).success,
    ).toBe(false);
    expect(
      placeBetSchema.safeParse({
        ...base,
        mode: 'COMBO',
        stake: 10.5,
        selections: [{ selectionId: id(1), odds: 1.5 }],
      }).success,
    ).toBe(false);
    expect(
      placeBetSchema.safeParse({
        ...base,
        mode: 'SINGLES',
        selections: [{ selectionId: id(1), odds: 1.5, stake: 100 }],
      }).success,
    ).toBe(true);
  });

  it('never defaults to accepting changed odds', () => {
    const parsed = placeBetSchema.parse({
      idempotencyKey: id(9),
      mode: 'COMBO',
      stake: 100,
      selections: [{ selectionId: id(1), odds: 1.5 }],
    });
    expect(parsed.oddsChangePolicy).toBe('REJECT');
  });
});

describe('stream topics', () => {
  it('parses and bounds topics', () => {
    expect(streamQuery.parse({ topics: `live,event:${id(1)}` }).topics).toEqual([
      'live',
      `event:${id(1)}`,
    ]);
    expect(streamQuery.safeParse({ topics: 'event:../../etc' }).success).toBe(false);
  });
});

describe('statistics', () => {
  it('validates football statistics', () => {
    const stats = {
      sport: 'football',
      goals: { home: 2, away: 1 },
      corners: { home: 5, away: 3 },
      yellowCards: { home: 1, away: 2 },
      redCards: { home: 0, away: 0 },
      shotsOnTarget: { home: 6, away: 4 },
      possession: { home: 55, away: 45 },
      goalEvents: [],
    };
    expect(eventStatisticsSchema.safeParse(stats).success).toBe(true);
    expect(
      eventStatisticsSchema.safeParse({ ...stats, goals: { home: -1, away: 0 } }).success,
    ).toBe(false);
  });
});
