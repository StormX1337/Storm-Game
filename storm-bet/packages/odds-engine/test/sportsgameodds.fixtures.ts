/**
 * Responses in the shape of the SportsGameOdds API v2 (leagues, events,
 * account usage), served by a fake fetch that records every call and counts
 * returned event objects against a monthly quota.
 */
export const T0 = Date.parse('2026-10-03T12:00:00Z');
const iso = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();

export const LEAGUES = [
  { leagueID: 'BUNDESLIGA', sportID: 'SOCCER', name: 'Bundesliga', enabled: true },
  { leagueID: 'UEFA_CHAMPIONS_LEAGUE', sportID: 'SOCCER', name: 'Champions League', enabled: true },
  { leagueID: 'NBA', sportID: 'BASKETBALL', name: 'NBA', enabled: true },
  { leagueID: 'ATP', sportID: 'TENNIS', name: 'ATP', enabled: true },
  { leagueID: 'NFL', sportID: 'FOOTBALL', name: 'NFL', enabled: true },
];

type Side = { odds: string; spread?: string; overUnder?: string; available?: boolean };

/** One odds entry; `book` is the consensus, `by` individual bookmakers. */
function odd(
  oddID: string,
  book: Side,
  by: Record<string, Side> = {},
  extra: Record<string, unknown> = {},
) {
  const [statID, statEntityID, periodID, betTypeID, sideID] = oddID.split('-');
  return {
    oddID,
    statID,
    statEntityID,
    periodID,
    betTypeID,
    sideID,
    bookOdds: book.odds,
    bookSpread: book.spread,
    bookOverUnder: book.overUnder,
    bookOddsAvailable: book.available ?? true,
    fairOdds: '+100',
    byBookmaker: Object.fromEntries(
      Object.entries(by).map(([id, s]) => [
        id,
        {
          bookmakerID: id,
          odds: s.odds,
          spread: s.spread,
          overUnder: s.overUnder,
          available: s.available ?? true,
        },
      ]),
    ),
    ...extra,
  };
}

const odds = (...entries: ReturnType<typeof odd>[]) =>
  Object.fromEntries(entries.map((o) => [o.oddID, o]));

const team = (teamID: string, long: string, short: string, score?: number) => ({
  teamID,
  names: { long, medium: long, short },
  ...(score === undefined ? {} : { score }),
});

const player = (playerID: string, teamID: string, name: string) => ({
  [playerID]: { playerID, teamID, name },
});

/** A player prop: statEntityID is the player. */
const prop = (oddID: string, book: Side, by: Record<string, Side> = {}) =>
  odd(oddID, book, by, { playerID: oddID.split('-')[1] });

const status = (startsAt: string, flags: Record<string, unknown> = {}) => ({
  startsAt,
  started: false,
  live: false,
  ended: false,
  completed: false,
  finalized: false,
  cancelled: false,
  ...flags,
});

export function events(): Record<string, unknown>[] {
  return [
    {
      eventID: 'sgo-upcoming',
      sportID: 'SOCCER',
      leagueID: 'BUNDESLIGA',
      type: 'match',
      teams: {
        home: team('BAYERN_MUNICH_BUNDESLIGA', 'Bayern Munich', 'BAY'),
        away: team('BORUSSIA_DORTMUND_BUNDESLIGA', 'Borussia Dortmund', 'BVB'),
      },
      status: status(iso(120)),
      players: {
        ...player('HARRY_KANE_1_BUNDESLIGA', 'BAYERN_MUNICH_BUNDESLIGA', 'Harry Kane'),
        ...player('JAMAL_MUSIALA_1_BUNDESLIGA', 'BAYERN_MUNICH_BUNDESLIGA', 'Jamal Musiala'),
        ...player(
          'SERHOU_GUIRASSY_1_BUNDESLIGA',
          'BORUSSIA_DORTMUND_BUNDESLIGA',
          'Serhou Guirassy',
        ),
        // Listed, but not on either team of this match.
        ...player('LEROY_SANE_1_SUPERLIG', 'GALATASARAY_SUPERLIG', 'Leroy Sané'),
      },
      odds: odds(
        // Halves.
        odd('points-home-1h-ml3way-home', { odds: '+120' }),
        odd('points-all-1h-ml3way-draw', { odds: '+130' }),
        odd('points-away-1h-ml3way-away', { odds: '+300' }),
        odd('points-home-1h-sp-home', { odds: '-105', spread: '-0.5' }),
        odd('points-away-1h-sp-away', { odds: '-115', spread: '+0.5' }),
        odd('points-all-1h-ou-over', { odds: '+105', overUnder: '1.5' }),
        odd('points-all-1h-ou-under', { odds: '-125', overUnder: '1.5' }),
        odd('points-home-2h-ml3way-home', { odds: '+105' }),
        odd('points-all-2h-ml3way-draw', { odds: '+220' }),
        odd('points-away-2h-ml3way-away', { odds: '+320' }),
        odd('points-all-2h-ou-over', { odds: '-110', overUnder: '1.5' }),
        odd('points-all-2h-ou-under', { odds: '-110', overUnder: '1.5' }),
        // Anytime goalscorer: yes/no or over 0.5 goals.
        prop('goals-HARRY_KANE_1_BUNDESLIGA-game-yn-yes', { odds: '-120' }),
        prop('goals-HARRY_KANE_1_BUNDESLIGA-game-yn-no', { odds: '-105' }),
        prop('goals-JAMAL_MUSIALA_1_BUNDESLIGA-game-ou-over', { odds: '+210', overUnder: '0.5' }),
        prop('goals-SERHOU_GUIRASSY_1_BUNDESLIGA-game-yn-yes', { odds: '+250' }),
        prop('goals-LEROY_SANE_1_SUPERLIG-game-yn-yes', { odds: '+300' }),
        odd(
          'points-home-reg-ml3way-home',
          { odds: '-160' },
          { pinnacle: { odds: '-155' }, draftkings: { odds: '-170' } },
        ),
        odd(
          'points-all-reg-ml3way-draw',
          { odds: '+360' },
          { pinnacle: { odds: '+355' }, draftkings: { odds: '+340' } },
        ),
        odd(
          'points-away-reg-ml3way-away',
          { odds: '+400' },
          { pinnacle: { odds: '+402' }, draftkings: { odds: '+390' } },
        ),
        // Same market over the full game incl. extra time: regular time wins.
        odd('points-home-game-ml3way-home', { odds: '-250' }),
        odd('points-all-game-ml3way-draw', { odds: '+500' }),
        odd('points-away-game-ml3way-away', { odds: '+600' }),
        odd(
          'points-home-reg-sp-home',
          { odds: '-108', spread: '-1.5' },
          { pinnacle: { odds: '-110', spread: '-1.5' } },
        ),
        odd(
          'points-away-reg-sp-away',
          { odds: '-112', spread: '+1.5' },
          { pinnacle: { odds: '-104', spread: '+1.5' } },
        ),
        odd(
          'points-all-reg-ou-over',
          { odds: '-138', overUnder: '3.5' },
          { pinnacle: { odds: '-139', overUnder: '3.5' } },
        ),
        odd(
          'points-all-reg-ou-under',
          { odds: '+112', overUnder: '3.5' },
          { pinnacle: { odds: '+112', overUnder: '3.5' } },
        ),
        // Team total and a player prop: not offered.
        odd('points-home-reg-ou-over', { odds: '-120', overUnder: '2.5' }),
        odd('points-home-reg-ou-under', { odds: '-105', overUnder: '2.5' }),
        odd(
          'points-HARRY_KANE_1_BUNDESLIGA-game-ou-over',
          { odds: '+150', overUnder: '0.5' },
          {},
          { playerID: 'HARRY_KANE_1_BUNDESLIGA' },
        ),
      ),
    },
    {
      eventID: 'sgo-quarter',
      sportID: 'SOCCER',
      leagueID: 'BUNDESLIGA',
      type: 'match',
      teams: {
        home: team('SC_FREIBURG_BUNDESLIGA', 'SC Freiburg', 'SCF'),
        away: team('FC_KOLN_BUNDESLIGA', '1. FC Köln', 'KOE'),
      },
      status: status(iso(240)),
      odds: odds(
        odd('points-home-reg-ml3way-home', { odds: '-105' }),
        odd('points-all-reg-ml3way-draw', { odds: '+260' }),
        odd('points-away-reg-ml3way-away', { odds: '+290' }),
        odd('points-home-reg-sp-home', { odds: '-110', spread: '-0.25' }),
        odd('points-away-reg-sp-away', { odds: '-102', spread: '+0.25' }),
        odd('points-all-reg-ou-over', { odds: '-111', overUnder: '2.75' }),
        odd('points-all-reg-ou-under', { odds: '-106', overUnder: '2.75' }),
      ),
    },
    {
      // Consensus prices from different books that together leave no margin.
      eventID: 'sgo-no-margin',
      sportID: 'SOCCER',
      leagueID: 'BUNDESLIGA',
      type: 'match',
      teams: {
        home: team('UNION_BERLIN_BUNDESLIGA', 'Union Berlin', 'FCU'),
        away: team('MAINZ_05_BUNDESLIGA', 'Mainz 05', 'M05'),
      },
      status: status(iso(300)),
      odds: odds(
        odd('points-home-reg-ml3way-home', { odds: '+210' }),
        odd('points-all-reg-ml3way-draw', { odds: '+210' }),
        odd('points-away-reg-ml3way-away', { odds: '+210' }),
      ),
    },
    {
      eventID: 'sgo-live',
      sportID: 'SOCCER',
      leagueID: 'BUNDESLIGA',
      type: 'match',
      teams: {
        home: team('VFB_STUTTGART_BUNDESLIGA', 'VfB Stuttgart', 'VFB', 1),
        away: team('WERDER_BREMEN_BUNDESLIGA', 'Werder Bremen', 'SVW', 0),
      },
      status: status(iso(-40), { started: true, live: true, currentPeriodID: '1h' }),
      odds: odds(
        odd('points-home-reg-ml3way-home', { odds: '-250' }),
        odd('points-all-reg-ml3way-draw', { odds: '+320' }),
        odd('points-away-reg-ml3way-away', { odds: '+800' }),
      ),
    },
    {
      eventID: 'nba-1',
      sportID: 'BASKETBALL',
      leagueID: 'NBA',
      type: 'match',
      teams: {
        home: team('BOSTON_CELTICS_NBA', 'Boston Celtics', 'BOS'),
        away: team('MIAMI_HEAT_NBA', 'Miami Heat', 'MIA'),
      },
      status: status(iso(600)),
      players: {
        ...player('JAYSON_TATUM_1_NBA', 'BOSTON_CELTICS_NBA', 'Jayson Tatum'),
        ...player('JIMMY_BUTLER_1_NBA', 'MIAMI_HEAT_NBA', 'Jimmy Butler'),
      },
      odds: odds(
        odd('points-home-1h-ml-home', { odds: '-240' }),
        odd('points-away-1h-ml-away', { odds: '+195' }),
        odd('points-home-1h-sp-home', { odds: '-110', spread: '-4.5' }),
        odd('points-away-1h-sp-away', { odds: '-110', spread: '+4.5' }),
        odd('points-all-1h-ou-over', { odds: '-110', overUnder: '108.5' }),
        odd('points-all-1h-ou-under', { odds: '-110', overUnder: '108.5' }),
        prop('points-JAYSON_TATUM_1_NBA-game-ou-over', { odds: '-115', overUnder: '27.5' }),
        prop('points-JAYSON_TATUM_1_NBA-game-ou-under', { odds: '-105', overUnder: '27.5' }),
        prop('rebounds-JAYSON_TATUM_1_NBA-game-ou-over', { odds: '+100', overUnder: '8.5' }),
        prop('rebounds-JAYSON_TATUM_1_NBA-game-ou-under', { odds: '-130', overUnder: '8.5' }),
        prop('assists-JIMMY_BUTLER_1_NBA-game-ou-over', { odds: '-110', overUnder: '5.5' }),
        prop('assists-JIMMY_BUTLER_1_NBA-game-ou-under', { odds: '-110', overUnder: '5.5' }),
        // Over and under on different lines: not one market.
        prop('rebounds-JIMMY_BUTLER_1_NBA-game-ou-over', { odds: '-110', overUnder: '6.5' }),
        prop('rebounds-JIMMY_BUTLER_1_NBA-game-ou-under', { odds: '-110', overUnder: '7.5' }),
        odd('points-home-game-ml-home', { odds: '-275' }),
        odd('points-away-game-ml-away', { odds: '+220' }),
        odd('points-home-game-sp-home', { odds: '-110', spread: '-7.5' }),
        odd('points-away-game-sp-away', { odds: '-110', spread: '+7.5' }),
        odd('points-all-game-ou-over', { odds: '-110', overUnder: '214.5' }),
        odd('points-all-game-ou-under', { odds: '-110', overUnder: '214.5' }),
      ),
    },
    {
      eventID: 'atp-1',
      sportID: 'TENNIS',
      leagueID: 'ATP',
      type: 'match',
      teams: {
        home: team('NOVAK_DJOKOVIC_ATP', 'Novak Djokovic', 'DJO'),
        away: team('HOLGER_RUNE_ATP', 'Holger Rune', 'RUN'),
      },
      status: status(iso(90)),
      odds: odds(
        odd('points-home-game-ml-home', { odds: '-333' }),
        odd('points-away-game-ml-away', { odds: '+260' }),
      ),
    },
    {
      eventID: 'sgo-finished',
      sportID: 'SOCCER',
      leagueID: 'BUNDESLIGA',
      type: 'match',
      teams: {
        home: team('RB_LEIPZIG_BUNDESLIGA', 'RB Leipzig', 'RBL', 2),
        away: team('BAYER_LEVERKUSEN_BUNDESLIGA', 'Bayer Leverkusen', 'B04', 2),
      },
      status: status(iso(-180), {
        started: true,
        ended: true,
        completed: true,
        finalized: true,
        periods: { started: ['1h', '2h'], ended: ['1h', '2h'] },
      }),
      players: {
        ...player('LOIS_OPENDA_1_BUNDESLIGA', 'RB_LEIPZIG_BUNDESLIGA', 'Loïs Openda'),
        ...player('XAVI_SIMONS_1_BUNDESLIGA', 'RB_LEIPZIG_BUNDESLIGA', 'Xavi Simons'),
        ...player('PATRIK_SCHICK_1_BUNDESLIGA', 'BAYER_LEVERKUSEN_BUNDESLIGA', 'Patrik Schick'),
      },
      results: {
        game: {
          home: { points: 2 },
          away: { points: 2 },
          LOIS_OPENDA_1_BUNDESLIGA: { goals: 2, shots: 4 },
          XAVI_SIMONS_1_BUNDESLIGA: { goals: 0, assists: 1 },
          PATRIK_SCHICK_1_BUNDESLIGA: { goals: 2 },
        },
        reg: { home: { points: 2 }, away: { points: 2 } },
        '1h': { home: { points: 1 }, away: { points: 0 } },
        '2h': { home: { points: 1 }, away: { points: 2 } },
      },
      odds: {},
    },
    {
      // A cup tie decided in extra time: regular-time bets need a manual result.
      eventID: 'ucl-extra-time',
      sportID: 'SOCCER',
      leagueID: 'UEFA_CHAMPIONS_LEAGUE',
      type: 'match',
      teams: {
        home: team('REAL_MADRID_UCL', 'Real Madrid', 'RMA', 2),
        away: team('ARSENAL_UCL', 'Arsenal', 'ARS', 1),
      },
      status: status(iso(-200), {
        started: true,
        ended: true,
        completed: true,
        finalized: true,
        periods: { started: ['1h', '2h', 'ot'], ended: ['1h', '2h', 'ot'] },
      }),
      results: {
        game: { home: { points: 2 }, away: { points: 1 } },
        reg: { home: { points: 1 }, away: { points: 1 } },
        ot: { home: { points: 1 }, away: { points: 0 } },
      },
      odds: {},
    },
    {
      eventID: 'nba-finished',
      sportID: 'BASKETBALL',
      leagueID: 'NBA',
      type: 'match',
      teams: {
        home: team('DENVER_NUGGETS_NBA', 'Denver Nuggets', 'DEN', 112),
        away: team('LA_LAKERS_NBA', 'Los Angeles Lakers', 'LAL', 104),
      },
      status: status(iso(-240), { started: true, ended: true, completed: true, finalized: true }),
      players: {
        ...player('NIKOLA_JOKIC_1_NBA', 'DENVER_NUGGETS_NBA', 'Nikola Jokić'),
        ...player('LEBRON_JAMES_1_NBA', 'LA_LAKERS_NBA', 'LeBron James'),
      },
      results: {
        game: {
          home: { points: 112 },
          away: { points: 104 },
          NIKOLA_JOKIC_1_NBA: { points: 31, rebounds: 13, assists: 9, steals: 2 },
          LEBRON_JAMES_1_NBA: { points: 27, rebounds: 8, assists: 11 },
        },
        '1q': { home: { points: 30 }, away: { points: 24 } },
        '2q': { home: { points: 26 }, away: { points: 28 } },
        '3q': { home: { points: 29 }, away: { points: 25 } },
        '4q': { home: { points: 27 }, away: { points: 27 } },
        '1h': { home: { points: 56 }, away: { points: 52 } },
      },
      odds: {},
    },
    {
      eventID: 'sgo-cancelled',
      sportID: 'SOCCER',
      leagueID: 'BUNDESLIGA',
      type: 'match',
      teams: {
        home: team('VFL_WOLFSBURG_BUNDESLIGA', 'VfL Wolfsburg', 'WOB'),
        away: team('FC_AUGSBURG_BUNDESLIGA', 'FC Augsburg', 'FCA'),
      },
      status: status(iso(-30), { cancelled: true }),
      odds: {},
    },
  ];
}

export interface SgoCall {
  path: string;
  params: URLSearchParams;
  apiKey: string | null;
}

export function fakeSgo(
  overrides: {
    max?: number | 'unlimited';
    used?: number;
    status?: number;
    leaguesStatus?: number;
    data?: Record<string, unknown>[];
  } = {},
) {
  const calls: SgoCall[] = [];
  const data = overrides.data ?? events();
  let used = overrides.used ?? 100;
  const max = overrides.max ?? 2_500;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/v2', '');
    const apiKey = new Headers(init?.headers).get('x-api-key');
    calls.push({ path, params: url.searchParams, apiKey });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (overrides.status && overrides.status >= 400)
      return json({ success: false, error: 'API key is invalid' }, overrides.status);

    if (path === '/account/usage') {
      return json({
        success: true,
        data: {
          tier: 'amateur',
          rateLimits: { 'per-month': { 'current-entities': used, 'max-entities': max } },
        },
      });
    }
    if (path === '/leagues') {
      if (overrides.leaguesStatus)
        return json({ success: false, error: 'down' }, overrides.leaguesStatus);
      return json({ success: true, data: LEAGUES });
    }
    if (path === '/events') {
      const p = url.searchParams;
      let rows = data as {
        eventID: string;
        leagueID: string;
        status: { startsAt: string; finalized: boolean };
      }[];
      if (p.get('eventIDs')) {
        const ids = new Set(p.get('eventIDs')!.split(','));
        rows = rows.filter((e) => ids.has(e.eventID));
      } else {
        const leagues = new Set((p.get('leagueID') ?? '').split(','));
        const after = Date.parse(p.get('startsAfter') ?? '1970-01-01');
        const before = Date.parse(p.get('startsBefore') ?? '2999-01-01');
        rows = rows.filter(
          (e) =>
            leagues.has(e.leagueID) &&
            (p.get('finalized') !== 'false' || !e.status.finalized) &&
            Date.parse(e.status.startsAt) >= after &&
            Date.parse(e.status.startsAt) <= before,
        );
      }
      const limit = Number(p.get('limit') ?? 10);
      const offset = Number(p.get('cursor') ?? 0);
      const page = rows.slice(offset, offset + limit);
      used += page.length;
      return json({
        success: true,
        data: page,
        nextCursor: offset + limit < rows.length ? String(offset + limit) : undefined,
      });
    }
    return json({ success: false, error: 'not found' }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls, data, usedObjects: () => used };
}
