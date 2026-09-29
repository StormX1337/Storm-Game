"""Read-side helpers shared by the dashboard, match list and scanner."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engine.scoring import RANK_ORDER, Rank, Risk
from app.models import Fixture, FixtureAnalysis, League

VALUE_RANKS = {Rank.BEST_VALUE.value, Rank.STRONG_VALUE.value, Rank.MODERATE_VALUE.value}


def zone(tz: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def day_window(day: str | None, tz: str | None) -> tuple[datetime, datetime]:
    z = zone(tz)
    d = date.fromisoformat(day) if day else datetime.now(z).date()
    start = datetime.combine(d, time.min, tzinfo=z)
    return start.astimezone(UTC), (start + timedelta(days=1)).astimezone(UTC)


def fixtures_between(
    db: Session,
    start: datetime,
    end: datetime,
    league_ids: list[int] | None = None,
    countries: list[str] | None = None,
) -> list[Fixture]:
    enabled = [lg.id for lg in db.scalars(select(League).where(League.enabled.is_(True)))]
    q = select(Fixture).where(Fixture.kickoff_at >= start, Fixture.kickoff_at < end)
    q = q.where(Fixture.league_id.in_(league_ids or enabled or [-1]))
    if countries:
        q = q.where(Fixture.country.in_(countries))
    return list(db.scalars(q.order_by(Fixture.kickoff_at, Fixture.id)))


def analyses_for(db: Session, fixtures: list[Fixture]) -> dict[int, FixtureAnalysis]:
    if not fixtures:
        return {}
    rows = db.scalars(
        select(FixtureAnalysis).where(FixtureAnalysis.fixture_id.in_([f.id for f in fixtures]))
    )
    return {r.fixture_id: r for r in rows}


def fixture_meta(f: Fixture) -> dict:
    return {
        "fixture_id": f.id,
        "kickoff": f.kickoff_at.isoformat(),
        "status": f.status,
        "elapsed": f.elapsed,
        "league_id": f.league_id,
        "league": f.league_name,
        "country": f.country,
        "home": f.home_name,
        "away": f.away_name,
        "home_logo": f.home_logo,
        "away_logo": f.away_logo,
        "home_goals": f.home_goals,
        "away_goals": f.away_goals,
    }


def flatten(f: Fixture, analysis: FixtureAnalysis | None) -> list[dict]:
    if analysis is None:
        return []
    meta = fixture_meta(f)
    meta["match"] = f"{f.home_name} vs {f.away_name}"
    return [{**meta, **ev} for ev in analysis.payload.get("evaluations", [])]


def sort_key(ev: dict):
    return (
        RANK_ORDER.get(Rank(ev.get("rank", Rank.NO_VALUE.value)), 9),
        -(ev.get("value_pct") or -1e9),
        -(ev.get("confidence") or 0),
    )


def matches_filter(
    ev: dict,
    *,
    markets: set[str] | None = None,
    categories: set[str] | None = None,
    min_probability: float | None = None,
    min_value: float | None = None,
    max_risk: str | None = None,
    min_confidence: int | None = None,
    ranks: set[str] | None = None,
) -> bool:
    if markets and ev["market"] not in markets:
        return False
    if categories and ev["category"] not in categories:
        return False
    if ranks and ev.get("rank") not in ranks:
        return False
    if ev.get("status") != "OK":
        return False
    if min_probability is not None and (ev.get("probability") or 0) < min_probability:
        return False
    if min_value is not None and (ev.get("value_pct") is None or ev["value_pct"] < min_value):
        return False
    if min_confidence is not None and (ev.get("confidence") or 0) < min_confidence:
        return False
    return not (
        max_risk is not None
        and (ev.get("risk") is None or Risk.parse(ev["risk"]) > Risk.parse(max_risk))
    )


def fixture_card(f: Fixture, a: FixtureAnalysis | None) -> dict:
    card = fixture_meta(f)
    if a is None:
        card.update(analysed=False, value_count=0, strong_count=0, best=None, insufficient=None)
        return card
    evals = a.payload.get("evaluations", [])
    best = min((e for e in evals if e.get("rank") in VALUE_RANKS), key=sort_key, default=None)
    stats = a.payload.get("stats", {})
    card.update(
        analysed=True,
        computed_at=a.computed_at.isoformat(),
        value_count=a.value_count,
        strong_count=a.strong_count,
        high_risk_count=a.high_risk_count,
        has_odds=any(e.get("odds") for e in evals),
        insufficient=[k for k, s in stats.items() if s.get("status") != "OK"],
        best=None
        if best is None
        else {
            k: best.get(k)
            for k in (
                "label",
                "market_label",
                "odds",
                "probability",
                "fair_odds",
                "value_pct",
                "confidence",
                "risk",
                "rank",
            )
        },
    )
    return card
