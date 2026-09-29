"""Turns stored rows into the engine's plain inputs."""

import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.engine.markets import Kind, Selection
from app.engine.rates import baseline_from_pairs
from app.engine.types import (
    LeagueBaseline,
    MatchContext,
    MatchRecord,
    Quote,
    RefereeProfile,
    Schedule,
    SquadStatus,
)
from app.models import (
    Fixture,
    FixtureEvent,
    FixtureLineup,
    FixtureTeamStats,
    Injury,
    InjuryCheck,
    OddsSnapshot,
)
from app.services.sync import FINISHED, VOID

HISTORY_LIMIT = 20


def _cards(s: FixtureTeamStats | None) -> int | None:
    if s is None or (s.yellow_cards is None and s.red_cards is None):
        return None
    return (s.yellow_cards or 0) + (s.red_cards or 0)


def team_records(
    db: Session, team_id: int, before: datetime, limit: int = HISTORY_LIMIT
) -> list[MatchRecord]:
    fixtures = list(
        db.scalars(
            select(Fixture)
            .where(
                or_(Fixture.home_team_id == team_id, Fixture.away_team_id == team_id),
                Fixture.status.in_(FINISHED),
                Fixture.kickoff_at < before,
                Fixture.home_goals.is_not(None),
            )
            .order_by(Fixture.kickoff_at.desc())
            .limit(limit)
        )
    )
    stats = _stats_for(db, [f.id for f in fixtures])
    out = []
    for f in fixtures:
        home = f.home_team_id == team_id
        opp = f.away_team_id if home else f.home_team_id
        mine, theirs = stats.get((f.id, team_id)), stats.get((f.id, opp))
        gf, ga = (f.home_goals, f.away_goals) if home else (f.away_goals, f.home_goals)
        hf, ha = (f.ht_home_goals, f.ht_away_goals) if home else (f.ht_away_goals, f.ht_home_goals)
        out.append(
            MatchRecord(
                fixture_id=f.id,
                date=f.kickoff_at,
                is_home=home,
                opponent_id=opp,
                goals_for=gf,
                goals_against=ga,
                xg_for=mine.xg if mine and theirs else None,
                xg_against=theirs.xg if mine and theirs else None,
                corners_for=mine.corners
                if mine and theirs and theirs.corners is not None
                else None,
                corners_against=theirs.corners
                if mine and theirs and mine.corners is not None
                else None,
                cards_for=_cards(mine) if _cards(theirs) is not None else None,
                cards_against=_cards(theirs) if _cards(mine) is not None else None,
                shots_for=mine.shots if mine else None,
                shots_against=theirs.shots if theirs else None,
                sot_for=mine.shots_on_target if mine else None,
                sot_against=theirs.shots_on_target if theirs else None,
                possession=mine.possession if mine else None,
                ht_goals_for=hf,
                ht_goals_against=ha,
                fh_corners_for=mine.fh_corners if mine else None,
                fh_corners_against=theirs.fh_corners if theirs else None,
                fh_cards_for=mine.fh_cards if mine else None,
                fh_cards_against=theirs.fh_cards if theirs else None,
                competition_id=f.league_id,
                referee=f.referee,
            )
        )
    return out


def _stats_for(db: Session, fixture_ids: list[int]) -> dict[tuple[int, int], FixtureTeamStats]:
    if not fixture_ids:
        return {}
    rows = db.scalars(select(FixtureTeamStats).where(FixtureTeamStats.fixture_id.in_(fixture_ids)))
    return {(r.fixture_id, r.team_id): r for r in rows}


def league_baseline(db: Session, league_id: int | None, before: datetime) -> LeagueBaseline:
    if league_id is None:
        return LeagueBaseline(None, None, None, None)
    fixtures = list(
        db.scalars(
            select(Fixture)
            .where(
                Fixture.league_id == league_id,
                Fixture.status.in_(FINISHED),
                Fixture.kickoff_at < before,
                Fixture.kickoff_at >= before - timedelta(days=400),
                Fixture.home_goals.is_not(None),
            )
            .order_by(Fixture.kickoff_at.desc())
            .limit(800)
        )
    )
    stats = _stats_for(db, [f.id for f in fixtures])
    goals, corners, cards, xg = [], [], [], []
    for f in fixtures:
        goals.append((f.home_goals, f.away_goals))
        h, a = stats.get((f.id, f.home_team_id)), stats.get((f.id, f.away_team_id))
        if h and a:
            if h.corners is not None and a.corners is not None:
                corners.append((h.corners, a.corners))
            if _cards(h) is not None and _cards(a) is not None:
                cards.append((_cards(h), _cards(a)))
            if h.xg is not None and a.xg is not None:
                xg.append((h.xg, a.xg))
    return LeagueBaseline(
        goals=baseline_from_pairs(goals),
        xg=baseline_from_pairs(xg),
        corners=baseline_from_pairs(corners),
        cards=baseline_from_pairs(cards),
    )


def referee_name(raw: str | None) -> str | None:
    if not raw:
        return None
    return raw.split(",")[0].strip() or None


def referee_profile(db: Session, raw_name: str | None, before: datetime) -> RefereeProfile | None:
    name = referee_name(raw_name)
    if not name:
        return None
    fixtures = list(
        db.scalars(
            select(Fixture)
            .where(
                Fixture.referee.is_not(None),
                Fixture.referee.like(f"{name}%"),
                Fixture.status.in_(FINISHED),
                Fixture.kickoff_at < before,
            )
            .order_by(Fixture.kickoff_at.desc())
            .limit(60)
        )
    )
    stats = _stats_for(db, [f.id for f in fixtures])
    totals, home, away, fouls = [], [], [], []
    for f in fixtures:
        h, a = stats.get((f.id, f.home_team_id)), stats.get((f.id, f.away_team_id))
        if _cards(h) is None or _cards(a) is None:
            continue
        home.append(_cards(h))
        away.append(_cards(a))
        totals.append(_cards(h) + _cards(a))
        if h.fouls is not None and a.fouls is not None:
            fouls.append(h.fouls + a.fouls)
    if not totals:
        return RefereeProfile(name=name, matches=0, avg_cards=0.0)
    return RefereeProfile(
        name=name,
        matches=len(totals),
        avg_cards=statistics.fmean(totals),
        avg_fouls=statistics.fmean(fouls) if fouls else None,
        avg_home_cards=statistics.fmean(home),
        avg_away_cards=statistics.fmean(away),
    )


def referee_distribution(db: Session, raw_name: str | None, before: datetime) -> dict[int, int]:
    """Histogram of total cards in the referee's stored matches."""
    name = referee_name(raw_name)
    if not name:
        return {}
    fixtures = list(
        db.scalars(
            select(Fixture).where(
                Fixture.referee.like(f"{name}%"),
                Fixture.status.in_(FINISHED),
                Fixture.kickoff_at < before,
            )
        )
    )
    stats = _stats_for(db, [f.id for f in fixtures])
    counts: Counter[int] = Counter()
    for f in fixtures:
        h, a = stats.get((f.id, f.home_team_id)), stats.get((f.id, f.away_team_id))
        if _cards(h) is not None and _cards(a) is not None:
            counts[_cards(h) + _cards(a)] += 1
    return dict(sorted(counts.items()))


def schedule(db: Session, team_id: int, kickoff: datetime) -> Schedule:
    fixtures = list(
        db.scalars(
            select(Fixture.kickoff_at)
            .where(
                or_(Fixture.home_team_id == team_id, Fixture.away_team_id == team_id),
                Fixture.kickoff_at < kickoff,
                Fixture.kickoff_at >= kickoff - timedelta(days=30),
                Fixture.status.not_in(VOID),
            )
            .order_by(Fixture.kickoff_at.desc())
        )
    )
    rest = (kickoff - fixtures[0]).total_seconds() / 86400 if fixtures else None
    return Schedule(
        rest_days=rest,
        matches_last_7=sum(1 for k in fixtures if k >= kickoff - timedelta(days=7)),
        matches_last_14=sum(1 for k in fixtures if k >= kickoff - timedelta(days=14)),
        travel_km=None,  # no venue coordinates from the data source
    )


@dataclass
class SquadDetail:
    status: SquadStatus
    injuries: list[dict]
    lineup: dict | None
    contributors: list[dict]


def squad(db: Session, fixture: Fixture, team_id: int, history: list[MatchRecord]) -> SquadDetail:
    lineup = db.get(FixtureLineup, (fixture.id, team_id))
    confirmed = bool(lineup and lineup.start_xi)
    checked = db.get(InjuryCheck, fixture.id) is not None
    injuries = list(
        db.scalars(select(Injury).where(Injury.fixture_id == fixture.id, Injury.team_id == team_id))
    )
    out_ids = {i.player_id for i in injuries if (i.type or "").lower() != "questionable"}

    hist_ids = [r.fixture_id for r in history]
    contributions: Counter[int] = Counter()
    names: dict[int, str] = {}
    if hist_ids:
        for e in db.scalars(
            select(FixtureEvent).where(
                FixtureEvent.fixture_id.in_(hist_ids),
                FixtureEvent.team_id == team_id,
                FixtureEvent.type == "Goal",
            )
        ):
            if (e.detail or "").lower().startswith(("own goal", "missed")):
                continue
            if e.player_id:
                contributions[e.player_id] += 1
                names[e.player_id] = e.player_name or str(e.player_id)
            if e.assist_id:
                contributions[e.assist_id] += 1
                names[e.assist_id] = e.assist_name or str(e.assist_id)

    in_squad: set[int] | None = None
    if confirmed and lineup is not None:
        in_squad = {
            p["id"] for p in (lineup.start_xi or []) + (lineup.substitutes or []) if p.get("id")
        }
        absent = {pid for pid in contributions if pid not in in_squad} | out_ids
    else:
        absent = out_ids

    total = sum(contributions.values())
    share = (
        sum(contributions[p] for p in absent) / total if total and (confirmed or checked) else None
    )

    # Regular defenders and goalkeepers from past line-ups.
    starts: Counter[int] = Counter()
    lineups = (
        list(
            db.scalars(
                select(FixtureLineup).where(
                    FixtureLineup.fixture_id.in_(hist_ids), FixtureLineup.team_id == team_id
                )
            )
        )
        if hist_ids
        else []
    )
    for lu in lineups:
        for p in lu.start_xi or []:
            if p.get("pos") in ("D", "G") and p.get("id"):
                starts[p["id"]] += 1
                names.setdefault(p["id"], p.get("name") or str(p["id"]))
    regulars = {pid for pid, n in starts.items() if len(lineups) >= 3 and n >= 0.6 * len(lineups)}
    if in_squad is not None:
        starting = {p["id"] for p in lineup.start_xi or [] if p.get("id")}  # type: ignore[union-attr]
        key_def_missing = len({p for p in regulars if p not in starting})
    else:
        key_def_missing = len(regulars & out_ids)

    status = SquadStatus(
        lineup_confirmed=confirmed if (confirmed or checked) else None,
        injuries_known=checked,
        missing_players=[i.player_name for i in injuries if i.player_id in out_ids],
        missing_goal_share=share,
        missing_key_defenders=key_def_missing,
        returning_players=_returning(db, fixture, team_id, out_ids),
    )
    return SquadDetail(
        status=status,
        injuries=[
            {"player": i.player_name, "type": i.type, "reason": i.reason, "player_id": i.player_id}
            for i in injuries
        ],
        lineup=None
        if lineup is None
        else {
            "formation": lineup.formation,
            "coach": lineup.coach,
            "start_xi": lineup.start_xi,
            "substitutes": lineup.substitutes,
        },
        contributors=[
            {"player": names[p], "contributions": c, "missing": p in absent}
            for p, c in contributions.most_common(8)
        ],
    )


def _returning(db: Session, fixture: Fixture, team_id: int, out_now: set[int]) -> list[str]:
    prev = db.scalar(
        select(Fixture)
        .where(
            or_(Fixture.home_team_id == team_id, Fixture.away_team_id == team_id),
            Fixture.kickoff_at < fixture.kickoff_at,
        )
        .order_by(Fixture.kickoff_at.desc())
        .limit(1)
    )
    if (
        prev is None
        or db.get(InjuryCheck, prev.id) is None
        or db.get(InjuryCheck, fixture.id) is None
    ):
        return []
    before = db.scalars(
        select(Injury).where(Injury.fixture_id == prev.id, Injury.team_id == team_id)
    )
    return [i.player_name for i in before if i.player_id not in out_now]


# ------------------------------------------------------------------ odds


def _group_key(sel: Selection) -> str | None:
    """Mutually exclusive outcome groups whose margin can be removed."""
    if sel.kind is Kind.RESULT:
        return "1x2" if sel.market.value == "1x2" else None
    if sel.kind is Kind.BTTS:
        return "btts"
    if sel.kind is Kind.HANDICAP:
        home_line = sel.line if sel.side == "home" else -(sel.line or 0)
        return f"{sel.market.value}:{home_line:g}"
    return f"{sel.market.value}:{sel.team or ''}:{sel.line:g}"


@dataclass
class OddsState:
    quotes: list[Quote]
    series: dict[str, list[tuple[datetime, float]]]  # best price over time per selection
    by_bookmaker: dict[str, dict[str, float]]  # key -> bookmaker -> current odds


def odds_state(db: Session, fixture_id: int, max_age_hours: float, now: datetime) -> OddsState:
    rows = list(
        db.scalars(
            select(OddsSnapshot)
            .where(OddsSnapshot.fixture_id == fixture_id)
            .order_by(OddsSnapshot.captured_at, OddsSnapshot.id)
        )
    )
    if not rows:
        return OddsState([], {}, {})
    latest_seen = max(r.last_seen_at for r in rows)
    fresh_after = latest_seen - timedelta(minutes=5)
    stale = now - latest_seen > timedelta(hours=max_age_hours)

    current: dict[tuple[str, str], OddsSnapshot] = {}
    for r in rows:
        current[(r.selection_key, r.bookmaker)] = r

    # Replay changes to get the best price at every batch time.
    state: dict[str, dict[str, float]] = defaultdict(dict)
    series: dict[str, list[tuple[datetime, float]]] = defaultdict(list)
    for r in rows:
        state[r.selection_key][r.bookmaker] = r.odds
        best = max(state[r.selection_key].values())
        s = series[r.selection_key]
        if s and s[-1][0] == r.captured_at:
            s[-1] = (r.captured_at, best)
        elif not s or s[-1][1] != best:
            s.append((r.captured_at, best))

    live: dict[str, dict[str, float]] = defaultdict(dict)
    for (key, book), r in current.items():
        if r.last_seen_at >= fresh_after and not stale:
            live[key][book] = r.odds

    selections = {k: Selection.from_key(k) for k in live}
    # Consensus no-vig probability per selection, from bookmakers that price
    # every outcome of the group.
    groups: dict[str, list[str]] = defaultdict(list)
    for k, sel in selections.items():
        g = _group_key(sel)
        if g:
            groups[g].append(k)
    no_vig: dict[str, float] = {}
    for keys in groups.values():
        if len(keys) < 2:
            continue
        books = set.intersection(*(set(live[k]) for k in keys))
        if not books:
            continue
        acc: dict[str, list[float]] = defaultdict(list)
        for b in books:
            inv = {k: 1 / live[k][b] for k in keys}
            total = sum(inv.values())
            for k in keys:
                acc[k].append(inv[k] / total)
        for k, vals in acc.items():
            no_vig[k] = statistics.fmean(vals)

    quotes = []
    for k, books in live.items():
        book, odds = max(books.items(), key=lambda kv: kv[1])
        opening = series[k][0][1] if series.get(k) else None
        quotes.append(
            Quote(
                selection=selections[k],
                odds=odds,
                bookmaker=book,
                bookmakers=len(books),
                prices=tuple(sorted(books.values())),
                opening_odds=opening,
                no_vig_probability=no_vig.get(k),
            )
        )
    return OddsState(
        quotes=quotes, series=dict(series), by_bookmaker={k: dict(v) for k, v in live.items()}
    )


# ------------------------------------------------------------------ context


@dataclass
class FullContext:
    ctx: MatchContext
    home_squad: SquadDetail
    away_squad: SquadDetail
    odds: OddsState


def build(
    db: Session, fixture: Fixture, now: datetime, max_odds_age_hours: float = 6
) -> FullContext:
    home_hist = team_records(db, fixture.home_team_id, fixture.kickoff_at)
    away_hist = team_records(db, fixture.away_team_id, fixture.kickoff_at)
    hs = squad(db, fixture, fixture.home_team_id, home_hist)
    as_ = squad(db, fixture, fixture.away_team_id, away_hist)
    odds = odds_state(db, fixture.id, max_odds_age_hours, now)
    ctx = MatchContext(
        fixture_id=fixture.id,
        kickoff=fixture.kickoff_at,
        home_id=fixture.home_team_id,
        away_id=fixture.away_team_id,
        home_history=home_hist,
        away_history=away_hist,
        league=league_baseline(db, fixture.league_id, fixture.kickoff_at),
        home_squad=hs.status,
        away_squad=as_.status,
        referee=referee_profile(db, fixture.referee, fixture.kickoff_at),
        home_schedule=schedule(db, fixture.home_team_id, fixture.kickoff_at),
        away_schedule=schedule(db, fixture.away_team_id, fixture.kickoff_at),
        quotes=odds.quotes,
    )
    return FullContext(ctx=ctx, home_squad=hs, away_squad=as_, odds=odds)
