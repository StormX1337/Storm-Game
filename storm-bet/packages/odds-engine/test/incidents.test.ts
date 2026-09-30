import type { FootballStatistics } from '@storm-bet/types';
import { describe, expect, it } from 'vitest';
import { detectIncidents, type IncidentSnapshot } from '../src/sync/incidents';

const stats = (over: Partial<FootballStatistics> = {}): FootballStatistics => ({
  sport: 'football',
  goals: { home: 0, away: 0 },
  corners: { home: 0, away: 0 },
  yellowCards: { home: 0, away: 0 },
  redCards: { home: 0, away: 0 },
  ...over,
});
const snap = (over: Partial<IncidentSnapshot>): IncidentSnapshot => ({
  status: 'LIVE',
  score: { home: 0, away: 0 },
  liveState: { period: '1H', clock: "10'" },
  statistics: stats(),
  ...over,
});

describe('live ticker', () => {
  it('records kick-off, goals with the scorer, cards and corners once each', () => {
    const kickOff = detectIncidents(
      'football',
      snap({ status: 'SCHEDULED', score: null, liveState: null, statistics: null }),
      snap({ liveState: { period: '1H', clock: "1'" } }),
    );
    expect(kickOff.map((i) => i.key)).toEqual(['kick-off']);

    const prev = snap({
      statistics: stats({ players: [{ playerId: 'p9', name: 'Neun', stats: { goals: 0 } }] }),
    });
    const next = snap({
      score: { home: 1, away: 0 },
      liveState: { period: '1H', clock: "23'" },
      statistics: stats({
        goals: { home: 1, away: 0 },
        corners: { home: 2, away: 0 },
        yellowCards: { home: 0, away: 1 },
        players: [{ playerId: 'p9', name: 'Neun', stats: { goals: 1 } }],
      }),
    });
    const found = detectIncidents('football', prev, next);
    expect(found.map((i) => i.key)).toEqual([
      'goal:HOME:1',
      'yellow_card:AWAY:1',
      'corner:HOME:1',
      'corner:HOME:2',
    ]);
    expect(found[0]).toMatchObject({
      kind: 'GOAL',
      side: 'HOME',
      playerName: 'Neun',
      clock: "23'",
      score: { home: 1, away: 0 },
    });
  });

  it('marks half-time, the second half and the final whistle', () => {
    const ht = detectIncidents(
      'football',
      snap({ liveState: { period: '1H', clock: "45'" } }),
      snap({ liveState: { period: 'HT', clock: null } }),
    );
    expect(ht.map((i) => i.kind)).toEqual(['HALF_TIME']);
    const second = detectIncidents(
      'football',
      snap({ liveState: { period: 'HT', clock: null } }),
      snap({ liveState: { period: '2H', clock: "46'" } }),
    );
    expect(second.map((i) => i.key)).toEqual(['period:2H']);
    const ft = detectIncidents(
      'football',
      snap({ liveState: { period: '2H', clock: "90'" } }),
      snap({ status: 'FINISHED', liveState: { period: 'FT', clock: null } }),
    );
    expect(ft.map((i) => i.kind)).toEqual(['FULL_TIME']);
  });

  it('never floods a game first seen mid-way', () => {
    const found = detectIncidents(
      'football',
      snap({ status: 'SUSPENDED', score: null, statistics: null }),
      snap({ score: { home: 3, away: 1 }, statistics: stats({ corners: { home: 7, away: 2 } }) }),
    );
    expect(found).toEqual([]);
  });

  it('reports a goal taken back', () => {
    const found = detectIncidents(
      'football',
      snap({ score: { home: 1, away: 0 } }),
      snap({ score: { home: 0, away: 0 } }),
    );
    expect(found.map((i) => i.key)).toEqual(['cancel:HOME:1']);
  });
});
