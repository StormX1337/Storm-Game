"""Pull data from providers into the database.

Each function is idempotent: running it twice stores the same rows. Finished
fixtures are detailed once and never re-fetched, which keeps API usage flat
once the history for a league has been built.
"""

from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import (
    Fixture,
    FixtureEvent,
    FixtureLineup,
    FixtureTeamStats,
    Injury,
    InjuryCheck,
    League,
    OddsSnapshot,
    Team,
)
from app.providers.base import (
    FixtureDetailsDTO,
    FixtureDTO,
    FixtureRef,
    FootballDataProvider,
    LeagueDTO,
    OddsProvider,
    PriceDTO,
)

FINISHED = ("FT", "AET", "PEN")
LIVE = ("1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE")
NOT_STARTED = ("NS", "TBD")
VOID = ("PST", "CANC", "ABD", "AWD", "WO")


def upsert_leagues(db: Session, leagues: Iterable[LeagueDTO]) -> int:
    n = 0
    for lg in leagues:
        row = db.get(League, lg.id)
        if row is None:
            row = League(id=lg.id, name=lg.name, enabled=False)
            db.add(row)
        row.name, row.country, row.logo, row.type = lg.name, lg.country, lg.logo, lg.type
        row.season = lg.season or row.season
        n += 1
    db.commit()
    return n


def upsert_fixture(db: Session, dto: FixtureDTO) -> Fixture:
    for team in (dto.home, dto.away):
        t = db.get(Team, team.id)
        if t is None:
            db.add(Team(id=team.id, name=team.name, logo=team.logo, country=dto.country))
        else:
            t.name, t.logo = team.name, team.logo or t.logo
    row = db.get(Fixture, dto.id)
    if row is None:
        row = Fixture(id=dto.id)
        db.add(row)
    row.league_id = dto.league_id
    row.league_name = dto.league_name
    row.country = dto.country
    row.season = dto.season
    row.round = dto.round
    row.kickoff_at = dto.kickoff
    row.status = dto.status
    row.elapsed = dto.elapsed
    row.home_team_id, row.away_team_id = dto.home.id, dto.away.id
    row.home_name, row.away_name = dto.home.name, dto.away.name
    row.home_logo, row.away_logo = dto.home.logo, dto.away.logo
    row.venue = dto.venue
    row.referee = dto.referee or row.referee
    row.home_goals, row.away_goals = dto.home_goals, dto.away_goals
    row.ht_home_goals, row.ht_away_goals = dto.ht_home_goals, dto.ht_away_goals
    return row


def store_details(db: Session, d: FixtureDetailsDTO) -> None:
    fx = upsert_fixture(db, d.fixture)
    db.flush()
    if d.stats:
        db.execute(delete(FixtureTeamStats).where(FixtureTeamStats.fixture_id == fx.id))
        for s in d.stats:
            db.add(
                FixtureTeamStats(
                    fixture_id=fx.id,
                    team_id=s.team_id,
                    is_home=s.team_id == fx.home_team_id,
                    shots=s.shots,
                    shots_on_target=s.shots_on_target,
                    possession=s.possession,
                    corners=s.corners,
                    yellow_cards=s.yellow_cards,
                    red_cards=s.red_cards,
                    fouls=s.fouls,
                    xg=s.xg,
                    fh_corners=s.fh_corners,
                    fh_cards=s.fh_cards,
                    raw=s.raw,
                )
            )
    if d.events:
        db.execute(delete(FixtureEvent).where(FixtureEvent.fixture_id == fx.id))
        for e in d.events:
            db.add(
                FixtureEvent(
                    fixture_id=fx.id,
                    team_id=e.team_id,
                    minute=e.minute,
                    extra=e.extra,
                    type=e.type[:16],
                    detail=(e.detail or "")[:64] or None,
                    player_id=e.player_id,
                    player_name=e.player_name,
                    assist_id=e.assist_id,
                    assist_name=e.assist_name,
                )
            )
    for lu in d.lineups:
        row = db.get(FixtureLineup, (fx.id, lu.team_id))
        if row is None:
            row = FixtureLineup(fixture_id=fx.id, team_id=lu.team_id)
            db.add(row)
        row.formation, row.coach = lu.formation, lu.coach
        row.start_xi, row.substitutes = lu.start_xi, lu.substitutes
        row.fetched_at = utcnow()
    if fx.status in FINISHED:
        fx.details_synced_at = utcnow()


def enabled_leagues(db: Session) -> list[League]:
    return list(db.scalars(select(League).where(League.enabled.is_(True))))


def sync_fixtures(db: Session, provider: FootballDataProvider, days_ahead: int) -> int:
    today = datetime.now(UTC).date()
    n = 0
    for lg in enabled_leagues(db):
        if not lg.season:
            continue
        for dto in provider.fixtures_between(
            lg.id, lg.season, today - timedelta(days=1), today + timedelta(days=days_ahead)
        ):
            upsert_fixture(db, dto)
            n += 1
    db.commit()
    return n


def sync_league_history(
    db: Session, provider: FootballDataProvider, detail_limit: int = 200
) -> int:
    """All fixtures of the current season (and the previous one when the
    current is too young to give a baseline), then statistics for a capped
    number of them per run. Corner and card baselines need league-wide
    statistics, not just those of the teams playing next, so the backlog is
    worked down a batch per day."""
    n = 0
    leagues = enabled_leagues(db)
    for lg in leagues:
        if not lg.season:
            continue
        dtos = provider.league_season_fixtures(lg.id, lg.season)
        finished = sum(1 for d in dtos if d.status in FINISHED)
        if finished < 60:
            dtos += provider.league_season_fixtures(lg.id, lg.season - 1)
        for dto in dtos:
            upsert_fixture(db, dto)
            n += 1
        db.commit()
    if leagues and detail_limit > 0:
        detail_missing(db, provider, league_ids={lg.id for lg in leagues}, limit=detail_limit)
    return n


def upcoming(db: Session, hours: float, statuses: tuple[str, ...] = NOT_STARTED) -> list[Fixture]:
    now = datetime.now(UTC)
    enabled = [lg.id for lg in enabled_leagues(db)]
    if not enabled:
        return []
    return list(
        db.scalars(
            select(Fixture)
            .where(
                Fixture.league_id.in_(enabled),
                Fixture.status.in_(statuses),
                Fixture.kickoff_at >= now - timedelta(hours=3),
                Fixture.kickoff_at <= now + timedelta(hours=hours),
            )
            .order_by(Fixture.kickoff_at)
        )
    )


def sync_team_history(
    db: Session, provider: FootballDataProvider, days_ahead: int, last: int
) -> int:
    teams: set[int] = set()
    for fx in upcoming(db, days_ahead * 24):
        teams.update((fx.home_team_id, fx.away_team_id))
    for team_id in teams:
        for dto in provider.team_last_fixtures(team_id, last):
            upsert_fixture(db, dto)
        db.commit()
    return detail_missing(db, provider, team_ids=teams)


def detail_missing(
    db: Session,
    provider: FootballDataProvider,
    team_ids: set[int] | None = None,
    league_ids: set[int] | None = None,
    limit: int = 400,
) -> int:
    q = select(Fixture.id).where(Fixture.status.in_(FINISHED), Fixture.details_synced_at.is_(None))
    if team_ids:
        q = q.where(Fixture.home_team_id.in_(team_ids) | Fixture.away_team_id.in_(team_ids))
    if league_ids:
        q = q.where(Fixture.league_id.in_(league_ids))
    ids = list(db.scalars(q.order_by(Fixture.kickoff_at.desc()).limit(limit)))
    for d in provider.fixture_details(ids):
        store_details(db, d)
    db.commit()
    return len(ids)


def sync_injuries(db: Session, provider: FootballDataProvider, hours: float = 48) -> int:
    n = 0
    for fx in upcoming(db, hours):
        injuries = provider.injuries(fx.id)
        db.execute(delete(Injury).where(Injury.fixture_id == fx.id))
        for inj in injuries:
            db.add(
                Injury(
                    fixture_id=fx.id,
                    team_id=inj.team_id,
                    player_id=inj.player_id,
                    player_name=inj.player_name,
                    type=inj.type,
                    reason=inj.reason,
                )
            )
        check = db.get(InjuryCheck, fx.id)
        if check is None:
            db.add(InjuryCheck(fixture_id=fx.id))
        else:
            check.checked_at = utcnow()
        db.commit()
        n += len(injuries)
    return n


def sync_lineups_and_live(db: Session, provider: FootballDataProvider) -> int:
    """Line-ups appear roughly an hour before kick-off; live stats during play."""
    soon = upcoming(db, 1.5)
    live = upcoming(db, 0, statuses=LIVE) + list(
        db.scalars(select(Fixture).where(Fixture.status.in_(LIVE)))
    )
    # Recently finished fixtures still need their final statistics.
    recent = list(
        db.scalars(
            select(Fixture).where(
                Fixture.status.in_(FINISHED),
                Fixture.details_synced_at.is_(None),
                Fixture.kickoff_at >= datetime.now(UTC) - timedelta(days=2),
            )
        )
    )
    ids = sorted({f.id for f in soon + live + recent})
    if not ids:
        return 0
    for d in provider.fixture_details(ids):
        store_details(db, d)
    db.commit()
    return len(ids)


def _refs(db: Session, fixtures: list[Fixture]) -> list[FixtureRef]:
    leagues = {lg.id: lg for lg in db.scalars(select(League))}
    return [
        FixtureRef(
            id=f.id,
            league_id=f.league_id,
            season=f.season,
            kickoff=f.kickoff_at,
            home_name=f.home_name,
            away_name=f.away_name,
            odds_key=leagues[f.league_id].odds_key if f.league_id in leagues else None,
            odds_event_id=f.odds_event_id,
        )
        for f in fixtures
    ]


def store_prices(
    db: Session, fixture_id: int, prices: list[PriceDTO], source: str, at: datetime
) -> int:
    """Store one snapshot batch; unchanged prices only refresh ``last_seen_at``."""
    last: dict[tuple[str, str], OddsSnapshot] = {}
    for row in db.scalars(
        select(OddsSnapshot)
        .where(OddsSnapshot.fixture_id == fixture_id)
        .order_by(OddsSnapshot.captured_at, OddsSnapshot.id)
    ):
        last[(row.selection_key, row.bookmaker)] = row
    best: dict[tuple[str, str], PriceDTO] = {}
    for p in prices:
        k = (p.selection.key, p.bookmaker[:64])
        # A bookmaker quoting the same selection twice: keep the higher price.
        if k not in best or p.odds > best[k].odds:
            best[k] = p
    n = 0
    for (key, book), p in best.items():
        prev = last.get((key, book))
        if prev is not None and prev.odds == p.odds:
            prev.last_seen_at = at
            continue
        db.add(
            OddsSnapshot(
                fixture_id=fixture_id,
                selection_key=key,
                market=p.selection.market.value,
                bookmaker=book,
                odds=p.odds,
                captured_at=at,
                last_seen_at=at,
                source=source,
            )
        )
        n += 1
    return n


def sync_odds(db: Session, provider: OddsProvider, days_ahead: int) -> int:
    fixtures = upcoming(db, days_ahead * 24)
    if not fixtures:
        return 0
    prices = provider.prices(_refs(db, fixtures))
    at = utcnow()
    n = 0
    for fixture_id, plist in prices.items():
        n += store_prices(db, fixture_id, plist, provider.name, at)
    db.commit()
    return n


def date_range(start: date, days: int) -> list[date]:
    return [start + timedelta(days=i) for i in range(days)]
