import type { PrismaClient } from '@storm-bet/database';
import type { JsonCache } from '@storm-bet/redis';
import {
  AppError,
  type EventInsightsDto,
  type FormEntryDto,
  type IncidentDto,
  type StandingRowDto,
} from '@storm-bet/types';

/** SportsGameOdds leagueID → football-data.org competition code. */
const COMPETITIONS: Record<string, string> = {
  BUNDESLIGA: 'BL1',
  EPL: 'PL',
  LA_LIGA: 'PD',
  IT_SERIE_A: 'SA',
  FR_LIGUE_1: 'FL1',
  UEFA_CHAMPIONS_LEAGUE: 'CL',
};

const FORM_GAMES = 5;
const STANDINGS_TTL_SECONDS = 3600;

export interface StandingsSource {
  apiKey?: string;
  apiUrl: string;
  fetch?: typeof fetch;
}

interface FdTableRow {
  position?: number;
  team?: { name?: string; shortName?: string };
  playedGames?: number;
  won?: number;
  draw?: number;
  lost?: number;
  goalsFor?: number;
  goalsAgainst?: number;
  points?: number;
}

type CachedTable = {
  competition: string;
  /** `alt`: the full club name, used only to recognise the match's teams. */
  rows: (Omit<StandingRowDto, 'highlight'> & { alt?: string })[];
} | null;

const STOP_WORDS = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'ssc', 'sv', 'club', 'de', 'the', '1']);

/** Lower case, no accents or punctuation, without "FC"-style words. */
function tokens(name: string): Set<string> {
  return new Set(
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t)),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

/** Index of the table row that clearly is `team`, or -1 when none (or several) fit. */
export function matchTeam(team: string, rows: { team: string; alt?: string }[]): number {
  const wanted = tokens(team);
  const scores = rows.map((r) =>
    Math.max(similarity(wanted, tokens(r.team)), r.alt ? similarity(wanted, tokens(r.alt)) : 0),
  );
  const best = Math.max(0, ...scores);
  if (best < 0.5) return -1;
  const at = scores.indexOf(best);
  return scores.filter((s) => s === best).length === 1 ? at : -1;
}

/**
 * Match page extras: the live ticker, recent form and head-to-head from the
 * games recorded here, and — only when a standings source is configured —
 * the league table. Nothing is invented: without data a part stays empty.
 */
export class InsightsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly cache: JsonCache,
    private readonly standings: StandingsSource,
  ) {}

  async incidents(eventId: string): Promise<{ items: IncidentDto[] }> {
    const rows = await this.db.eventIncident.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        side: r.side === 'HOME' || r.side === 'AWAY' ? r.side : null,
        clock: r.clock,
        period: r.period,
        playerName: r.playerName,
        score: r.homeScore == null ? null : { home: r.homeScore, away: r.awayScore ?? 0 },
        at: r.createdAt.toISOString(),
      })),
    };
  }

  async insights(eventId: string): Promise<EventInsightsDto> {
    const event = await this.db.event.findUnique({
      where: { id: eventId },
      include: {
        homeTeam: { select: { id: true, name: true } },
        awayTeam: { select: { id: true, name: true } },
        league: { select: { externalId: true, provider: true, name: true } },
        sport: { select: { key: true } },
      },
    });
    if (!event || !event.isActive) throw new AppError('NOT_FOUND', 'Event nicht gefunden.');
    const finished = {
      status: 'FINISHED' as const,
      homeScore: { not: null },
      awayScore: { not: null },
      startTime: { lt: event.startTime },
      id: { not: event.id },
    };
    const select = {
      id: true,
      startTime: true,
      homeScore: true,
      awayScore: true,
      homeTeamId: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    } as const;
    const formOf = async (teamId: string): Promise<FormEntryDto[]> => {
      const games = await this.db.event.findMany({
        where: { ...finished, OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] },
        orderBy: { startTime: 'desc' },
        take: FORM_GAMES,
        select,
      });
      return games.map((g) => {
        const home = g.homeTeamId === teamId;
        const goalsFor = (home ? g.homeScore : g.awayScore) ?? 0;
        const goalsAgainst = (home ? g.awayScore : g.homeScore) ?? 0;
        return {
          eventId: g.id,
          startTime: g.startTime.toISOString(),
          opponent: home ? g.awayTeam.name : g.homeTeam.name,
          home,
          goalsFor,
          goalsAgainst,
          result: goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D',
        };
      });
    };
    const [homeForm, awayForm, meetings] = await Promise.all([
      formOf(event.homeTeamId),
      formOf(event.awayTeamId),
      this.db.event.findMany({
        where: {
          ...finished,
          OR: [
            { homeTeamId: event.homeTeamId, awayTeamId: event.awayTeamId },
            { homeTeamId: event.awayTeamId, awayTeamId: event.homeTeamId },
          ],
        },
        orderBy: { startTime: 'desc' },
        take: FORM_GAMES,
        select,
      }),
    ]);

    const table = event.sport.key === 'football' ? await this.table(event.league.externalId) : null;
    let standings: EventInsightsDto['standings'] = null;
    if (table) {
      const named = table.rows.map((r) => ({ team: r.team, alt: r.alt }));
      const marked = new Set(
        [matchTeam(event.homeTeam.name, named), matchTeam(event.awayTeam.name, named)].filter(
          (i) => i >= 0,
        ),
      );
      standings = {
        competition: table.competition,
        source: 'football-data.org',
        rows: table.rows.map(({ alt: _alt, ...r }, i) => ({ ...r, highlight: marked.has(i) })),
      };
    }

    return {
      form: { home: homeForm, away: awayForm },
      headToHead: meetings.map((g) => ({
        eventId: g.id,
        startTime: g.startTime.toISOString(),
        homeTeam: g.homeTeam.name,
        awayTeam: g.awayTeam.name,
        score: { home: g.homeScore ?? 0, away: g.awayScore ?? 0 },
      })),
      standings,
    };
  }

  /** The league table from football-data.org, cached for an hour (also a miss). */
  private async table(leagueExternalId: string): Promise<CachedTable> {
    const code = COMPETITIONS[leagueExternalId];
    if (!code || !this.standings.apiKey) return null;
    const key = `standings:${code}`;
    const cached = await this.cache.get<{ table: CachedTable }>(key);
    if (cached) return cached.table;
    let table: CachedTable = null;
    try {
      const res = await (this.standings.fetch ?? fetch)(
        `${this.standings.apiUrl}/competitions/${code}/standings`,
        {
          headers: { 'X-Auth-Token': this.standings.apiKey },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          competition?: { name?: string };
          standings?: { type?: string; table?: FdTableRow[] }[];
        };
        const total = body.standings?.find((s) => s.type === 'TOTAL')?.table ?? [];
        if (total.length) {
          table = {
            competition: body.competition?.name ?? code,
            rows: total.map((r, i) => ({
              position: r.position ?? i + 1,
              team: r.team?.shortName || r.team?.name || '–',
              alt: r.team?.name,
              played: r.playedGames ?? 0,
              won: r.won ?? 0,
              draw: r.draw ?? 0,
              lost: r.lost ?? 0,
              goalsFor: r.goalsFor ?? 0,
              goalsAgainst: r.goalsAgainst ?? 0,
              points: r.points ?? 0,
            })),
          };
        }
      }
    } catch {
      table = null;
    }
    // A failure is cached briefly, so a down source is not asked on every view.
    await this.cache.set(key, { table }, table ? STANDINGS_TTL_SECONDS : 300);
    return table;
  }
}
