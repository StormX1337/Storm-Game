import { randomUUID } from 'node:crypto';
import { JsonCache } from '@storm-bet/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InsightsService } from '../src/services/insights';
import { createTestApp } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

async function fixture() {
  const sport = await t.db.sport.upsert({
    where: { key: 'football' },
    create: { key: 'football', name: 'Fußball' },
    update: {},
  });
  const tag = randomUUID().slice(0, 8);
  const league = await t.db.league.create({
    data: { sportId: sport.id, provider: `insights-${tag}`, externalId: `EPL-${tag}`, name: 'PL' },
  });
  const team = (name: string) =>
    t.db.team.create({
      data: {
        sportId: sport.id,
        provider: 'test',
        externalId: `${name}-${tag}`,
        name,
        shortName: name.slice(0, 3),
      },
    });
  const [a, b, c] = await Promise.all([
    team('Manchester United'),
    team('Arsenal'),
    team('Chelsea'),
  ]);
  let n = 0;
  const game = (home: string, away: string, days: number, score?: [number, number]) =>
    t.db.event.create({
      data: {
        sportId: sport.id,
        leagueId: league.id,
        homeTeamId: home,
        awayTeamId: away,
        provider: 'test',
        externalId: `g-${tag}-${(n += 1)}`,
        startTime: new Date(Date.now() + days * 86_400_000),
        status: score ? 'FINISHED' : 'SCHEDULED',
        homeScore: score?.[0] ?? null,
        awayScore: score?.[1] ?? null,
      },
    });
  await game(a!.id, b!.id, -20, [2, 1]);
  await game(c!.id, a!.id, -10, [0, 0]);
  await game(b!.id, c!.id, -5, [3, 0]);
  const next = await game(b!.id, a!.id, 1);
  return { league, next, a: a!, b: b! };
}

describe('match insights', () => {
  it('shows form and head-to-head from recorded games, a table only with a source', async () => {
    const { next, league } = await fixture();
    const plain = new InsightsService(t.db, new JsonCache(t.redis), {
      apiUrl: 'https://example.invalid',
    });
    const view = await plain.insights(next.id);
    expect(view.form.away.map((g) => [g.result, g.goalsFor, g.goalsAgainst])).toEqual([
      ['D', 0, 0],
      ['W', 2, 1],
    ]);
    expect(view.form.home.map((g) => g.result)).toEqual(['W', 'L']);
    expect(view.headToHead).toHaveLength(1);
    expect(view.headToHead[0]).toMatchObject({ score: { home: 2, away: 1 } });
    expect(view.standings).toBeNull();

    // With a source (league mapped to a competition) the table marks both teams.
    await t.db.league.update({ where: { id: league.id }, data: { externalId: 'EPL' } });
    const calls: string[] = [];
    const withTable = new InsightsService(t.db, new JsonCache(t.redis), {
      apiKey: 'test-key-123',
      apiUrl: 'https://fd.test/v4',
      fetch: (async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            competition: { name: 'Premier League' },
            standings: [
              {
                type: 'TOTAL',
                table: [
                  { position: 1, team: { name: 'Arsenal FC', shortName: 'Arsenal' }, points: 20 },
                  { position: 2, team: { name: 'Chelsea FC', shortName: 'Chelsea' }, points: 18 },
                  {
                    position: 3,
                    team: { name: 'Manchester United FC', shortName: 'Man United' },
                    points: 15,
                  },
                ],
              },
            ],
          }),
        );
      }) as typeof fetch,
    });
    await t.redis.del('sb:cache:standings:PL').catch(() => undefined);
    await new JsonCache(t.redis).del('standings:PL');
    const table = (await withTable.insights(next.id)).standings!;
    expect(table.competition).toBe('Premier League');
    expect(table.rows.filter((r) => r.highlight).map((r) => r.team)).toEqual([
      'Arsenal',
      'Man United',
    ]);
    expect(JSON.stringify(table)).not.toContain('alt');
    // Cached: the source is asked once.
    await withTable.insights(next.id);
    expect(calls).toEqual(['https://fd.test/v4/competitions/PL/standings']);
    await t.db.league.update({ where: { id: league.id }, data: { externalId: `x-${league.id}` } });
    await new JsonCache(t.redis).del('standings:PL');
  });
});
