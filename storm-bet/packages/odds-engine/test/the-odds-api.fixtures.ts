/**
 * Responses in the exact shape of The Odds API v4 (sports, odds, scores),
 * served by a fake fetch that also records every call and its credit cost.
 */
export const T0 = Date.parse('2026-10-03T12:00:00Z');
const iso = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();

export const SPORTS = [
  {
    key: 'soccer_germany_bundesliga',
    group: 'Soccer',
    title: 'Bundesliga - Germany',
    description: 'German Soccer',
    active: true,
    has_outrights: false,
  },
  {
    key: 'soccer_fifa_world_cup_winner',
    group: 'Soccer',
    title: 'FIFA World Cup Winner',
    description: 'Outrights',
    active: true,
    has_outrights: true,
  },
  {
    key: 'basketball_nba',
    group: 'Basketball',
    title: 'NBA',
    description: 'US Basketball',
    active: true,
    has_outrights: false,
  },
  {
    key: 'tennis_atp_paris',
    group: 'Tennis',
    title: 'ATP Paris Masters',
    description: 'Men’s Singles',
    active: true,
    has_outrights: false,
  },
  {
    key: 'tennis_wta_wuhan',
    group: 'Tennis',
    title: 'WTA Wuhan',
    description: 'Women’s Singles',
    active: false,
    has_outrights: false,
  },
  {
    key: 'americanfootball_nfl',
    group: 'American Football',
    title: 'NFL',
    description: 'US Football',
    active: true,
    has_outrights: false,
  },
];

const bookmaker = (key: string, markets: unknown[]) => ({
  key,
  title: key.toUpperCase(),
  last_update: iso(-2),
  markets,
});

export const BUNDESLIGA_ODDS = [
  {
    id: 'bl-upcoming',
    sport_key: 'soccer_germany_bundesliga',
    sport_title: 'Bundesliga - Germany',
    commence_time: iso(120),
    home_team: 'Bayern Munich',
    away_team: 'Borussia Dortmund',
    bookmakers: [
      bookmaker('unibet_eu', [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Bayern Munich', price: 1.55 },
            { name: 'Borussia Dortmund', price: 5.25 },
            { name: 'Draw', price: 4.6 },
          ],
        },
      ]),
      bookmaker('pinnacle', [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Bayern Munich', price: 1.61 },
            { name: 'Borussia Dortmund', price: 5.02 },
            { name: 'Draw', price: 4.55 },
          ],
        },
        {
          key: 'spreads',
          outcomes: [
            { name: 'Bayern Munich', price: 1.92, point: -1.5 },
            { name: 'Borussia Dortmund', price: 1.96, point: 1.5 },
          ],
        },
        {
          key: 'totals',
          outcomes: [
            { name: 'Over', price: 1.72, point: 3.5 },
            { name: 'Under', price: 2.12, point: 3.5 },
          ],
        },
      ]),
    ],
  },
  {
    id: 'bl-quarter',
    sport_key: 'soccer_germany_bundesliga',
    sport_title: 'Bundesliga - Germany',
    commence_time: iso(240),
    home_team: 'SC Freiburg',
    away_team: '1. FC Köln',
    bookmakers: [
      bookmaker('pinnacle', [
        {
          key: 'h2h',
          outcomes: [
            { name: 'SC Freiburg', price: 1.95 },
            { name: '1. FC Köln', price: 3.9 },
            { name: 'Draw', price: 3.6 },
          ],
        },
        {
          key: 'spreads',
          outcomes: [
            { name: 'SC Freiburg', price: 1.9, point: -0.25 },
            { name: '1. FC Köln', price: 1.98, point: 0.25 },
          ],
        },
        {
          key: 'totals',
          outcomes: [
            { name: 'Over', price: 1.9, point: 2.75 },
            { name: 'Under', price: 1.94, point: 2.75 },
          ],
        },
      ]),
    ],
  },
  {
    id: 'bl-live',
    sport_key: 'soccer_germany_bundesliga',
    sport_title: 'Bundesliga - Germany',
    commence_time: iso(-40),
    home_team: 'VfB Stuttgart',
    away_team: 'Werder Bremen',
    bookmakers: [
      bookmaker('pinnacle', [
        {
          key: 'h2h',
          outcomes: [
            { name: 'VfB Stuttgart', price: 1.4 },
            { name: 'Werder Bremen', price: 9.0 },
            { name: 'Draw', price: 4.2 },
          ],
        },
      ]),
    ],
  },
];

export const BUNDESLIGA_SCORES = [
  {
    id: 'bl-live',
    sport_key: 'soccer_germany_bundesliga',
    commence_time: iso(-40),
    completed: false,
    home_team: 'VfB Stuttgart',
    away_team: 'Werder Bremen',
    scores: [
      { name: 'VfB Stuttgart', score: '1' },
      { name: 'Werder Bremen', score: '0' },
    ],
    last_update: iso(-1),
  },
  {
    id: 'bl-finished',
    sport_key: 'soccer_germany_bundesliga',
    commence_time: iso(-180),
    completed: true,
    home_team: 'RB Leipzig',
    away_team: 'Bayer Leverkusen',
    scores: [
      { name: 'RB Leipzig', score: '2' },
      { name: 'Bayer Leverkusen', score: '2' },
    ],
    last_update: iso(-60),
  },
];

export const NBA_ODDS = [
  {
    id: 'nba-1',
    sport_key: 'basketball_nba',
    sport_title: 'NBA',
    commence_time: iso(600),
    home_team: 'Boston Celtics',
    away_team: 'Miami Heat',
    bookmakers: [
      bookmaker('draftkings', [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Boston Celtics', price: 1.36 },
            { name: 'Miami Heat', price: 3.2 },
          ],
        },
        {
          key: 'spreads',
          outcomes: [
            { name: 'Boston Celtics', price: 1.91, point: -7.5 },
            { name: 'Miami Heat', price: 1.91, point: 7.5 },
          ],
        },
        {
          key: 'totals',
          outcomes: [
            { name: 'Over', price: 1.91, point: 214.5 },
            { name: 'Under', price: 1.91, point: 214.5 },
          ],
        },
      ]),
    ],
  },
];

export const TENNIS_ODDS = [
  {
    id: 'atp-1',
    sport_key: 'tennis_atp_paris',
    sport_title: 'ATP Paris Masters',
    commence_time: iso(90),
    home_team: 'Novak Djokovic',
    away_team: 'Holger Rune',
    bookmakers: [
      bookmaker('pinnacle', [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Novak Djokovic', price: 1.3 },
            { name: 'Holger Rune', price: 3.6 },
          ],
        },
      ]),
    ],
  },
];

export interface Call {
  path: string;
  params: URLSearchParams;
}

export function fakeApi(
  overrides: { remaining?: number; status?: number; scores?: unknown[] } = {},
) {
  const calls: Call[] = [];
  let remaining = overrides.remaining ?? 480;
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/v4', '');
    calls.push({ path, params: url.searchParams });
    let body: unknown = [];
    let cost = 0;
    if (path === '/sports') body = SPORTS;
    else if (path.endsWith('/odds')) {
      cost = (url.searchParams.get('markets') ?? 'h2h').split(',').length;
      body = path.includes('bundesliga')
        ? BUNDESLIGA_ODDS
        : path.includes('nba')
          ? NBA_ODDS
          : path.includes('tennis')
            ? TENNIS_ODDS
            : [];
    } else if (path.endsWith('/scores')) {
      cost = 2;
      body = path.includes('bundesliga') ? (overrides.scores ?? BUNDESLIGA_SCORES) : [];
    }
    remaining -= cost;
    const headers = new Headers({
      'content-type': 'application/json',
      'x-requests-remaining': String(remaining),
      'x-requests-used': String(500 - remaining),
      'x-requests-last': String(cost),
    });
    return new Response(
      JSON.stringify(overrides.status && overrides.status >= 400 ? { message: 'error' } : body),
      {
        status: overrides.status ?? 200,
        headers,
      },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}
