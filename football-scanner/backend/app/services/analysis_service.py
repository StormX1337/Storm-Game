"""Runs the engine for upcoming fixtures and keeps signals up to date."""

from dataclasses import asdict
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.engine.analysis import Evaluation, MatchAnalysis, analyze
from app.engine.scoring import Rank, Risk
from app.engine.summary import team_summary
from app.models import Fixture, FixtureAnalysis, Signal
from app.services import context as context_mod
from app.services import settings_service
from app.services.sync import NOT_STARTED, upcoming

VALUE_RANKS = {Rank.BEST_VALUE.value, Rank.STRONG_VALUE.value, Rank.MODERATE_VALUE.value}
STRONG_RANKS = {Rank.BEST_VALUE.value, Rank.STRONG_VALUE.value}


def _tactics(records, lineup: dict | None, history_lineups: list[str]) -> dict:
    poss = [r.possession for r in records[:10] if r.possession is not None]
    shots = [r.shots_for for r in records[:10] if r.shots_for is not None]
    avg_poss = sum(poss) / len(poss) if poss else None
    formations = [f for f in history_lineups if f]
    common = max(set(formations), key=formations.count) if formations else None
    style = None
    if avg_poss is not None:
        if avg_poss >= 55:
            style = "Possession-oriented (derived from average possession)"
        elif avg_poss <= 45:
            style = "Direct / counter-attacking (derived from average possession)"
        else:
            style = "Balanced (derived from average possession)"
    return {
        "formation": (lineup or {}).get("formation") or common,
        "formation_source": "confirmed line-up"
        if (lineup or {}).get("formation")
        else ("most used in recent line-ups" if common else None),
        "possession": avg_poss,
        "shots_per_game": sum(shots) / len(shots) if shots else None,
        "style": style,
        # Not supplied by the configured data sources:
        "pressing": None,
        "defensive_line": None,
        "counter_attacks": None,
    }


def _lineup_formations(db: Session, fixture_ids: list[int], team_id: int) -> list[str]:
    from app.models import FixtureLineup

    if not fixture_ids:
        return []
    return [
        lu.formation
        for lu in db.scalars(
            select(FixtureLineup).where(
                FixtureLineup.fixture_id.in_(fixture_ids), FixtureLineup.team_id == team_id
            )
        )
        if lu.formation
    ]


def _h2h(db: Session, fixture: Fixture) -> list[dict]:
    rows = db.scalars(
        select(Fixture)
        .where(
            (
                (Fixture.home_team_id == fixture.home_team_id)
                & (Fixture.away_team_id == fixture.away_team_id)
            )
            | (
                (Fixture.home_team_id == fixture.away_team_id)
                & (Fixture.away_team_id == fixture.home_team_id)
            ),
            Fixture.status.in_(("FT", "AET", "PEN")),
            Fixture.kickoff_at < fixture.kickoff_at,
        )
        .order_by(Fixture.kickoff_at.desc())
        .limit(10)
    )
    return [
        {
            "fixture_id": f.id,
            "date": f.kickoff_at.isoformat(),
            "home": f.home_name,
            "away": f.away_name,
            "score": f"{f.home_goals}-{f.away_goals}",
            "league": f.league_name,
            "age_days": (fixture.kickoff_at - f.kickoff_at).days,
        }
        for f in rows
    ]


def analyse_fixture(db: Session, fixture: Fixture, now: datetime | None = None) -> MatchAnalysis:
    now = now or datetime.now(UTC)
    odds_cfg = settings_service.get(db, "odds")
    full = context_mod.build(db, fixture, now, float(odds_cfg.get("max_snapshot_age_hours", 6)))
    result = analyze(full.ctx, settings_service.engine_settings(db))
    ctx = full.ctx

    home_forms = _lineup_formations(db, [r.fixture_id for r in ctx.home_history], ctx.home_id)
    away_forms = _lineup_formations(db, [r.fixture_id for r in ctx.away_history], ctx.away_id)
    payload = result.public()
    payload["context"] = {
        "home": team_summary(ctx.home_history, ctx.kickoff, venue_home=True),
        "away": team_summary(ctx.away_history, ctx.kickoff, venue_home=False),
        "home_squad": {
            **asdict(ctx.home_squad),
            "injuries": full.home_squad.injuries,
            "lineup": full.home_squad.lineup,
            "contributors": full.home_squad.contributors,
        },
        "away_squad": {
            **asdict(ctx.away_squad),
            "injuries": full.away_squad.injuries,
            "lineup": full.away_squad.lineup,
            "contributors": full.away_squad.contributors,
        },
        "home_tactics": _tactics(ctx.home_history, full.home_squad.lineup, home_forms),
        "away_tactics": _tactics(ctx.away_history, full.away_squad.lineup, away_forms),
        "home_schedule": asdict(ctx.home_schedule) if ctx.home_schedule else None,
        "away_schedule": asdict(ctx.away_schedule) if ctx.away_schedule else None,
        "referee": asdict(ctx.referee) if ctx.referee else None,
        "referee_distribution": context_mod.referee_distribution(
            db, fixture.referee, fixture.kickoff_at
        ),
        "league_baseline": asdict(ctx.league),
        "h2h": _h2h(db, fixture),
        "odds_updated_at": max(
            (pts[-1][0] for pts in full.odds.series.values() if pts), default=None
        ),
    }
    evals = result.evaluations
    row = db.get(FixtureAnalysis, fixture.id)
    if row is None:
        row = FixtureAnalysis(fixture_id=fixture.id, payload={})
        db.add(row)
    row.payload = _jsonable(payload)
    row.computed_at = utcnow()
    row.value_count = sum(1 for e in evals if e.rank in VALUE_RANKS)
    row.strong_count = sum(1 for e in evals if e.rank in STRONG_RANKS)
    row.high_risk_count = sum(
        1 for e in evals if e.rank in VALUE_RANKS and e.risk in ("HIGH", "VERY HIGH")
    )
    row.best_value_pct = max((e.value_pct for e in evals if e.rank in VALUE_RANKS), default=None)
    update_signals(db, fixture, evals)
    db.commit()
    return result


def _jsonable(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list | tuple | set):
        return [_jsonable(v) for v in obj]
    return obj


def qualifies(ev: Evaluation, policy: dict) -> bool:
    if ev.rank not in VALUE_RANKS or ev.odds is None or ev.value_pct is None:
        return False
    return (
        (ev.probability or 0) >= float(policy.get("min_probability", 0))
        and ev.value_pct >= float(policy.get("min_value", 0))
        and (ev.confidence or 0) >= int(policy.get("min_confidence", 0))
        and Risk.parse(ev.risk or "VERY HIGH") <= Risk.parse(str(policy.get("max_risk", "HIGH")))
    )


def update_signals(db: Session, fixture: Fixture, evals: list[Evaluation]) -> None:
    if fixture.status not in NOT_STARTED or fixture.kickoff_at <= datetime.now(UTC):
        return
    policy = settings_service.get(db, "signal_policy")
    existing = {
        s.selection_key: s
        for s in db.scalars(select(Signal).where(Signal.fixture_id == fixture.id))
    }
    for ev in evals:
        sig = existing.get(ev.key)
        if not qualifies(ev, policy):
            # Value that disappears before kick-off is withdrawn, and does not
            # count in the track record unless it comes back.
            if sig is not None and not sig.locked and sig.status == "pending":
                sig.status = "withdrawn"
            continue
        if sig is None:
            sig = Signal(fixture_id=fixture.id, selection_key=ev.key)
            db.add(sig)
        elif sig.locked:
            continue
        sig.market = ev.market
        sig.category = ev.category
        sig.label = ev.label
        sig.odds = ev.odds
        sig.bookmaker = ev.bookmaker
        sig.probability = ev.probability
        sig.fair_odds = ev.fair_odds
        sig.implied_probability = ev.implied_probability
        sig.edge_pp = ev.edge_pp
        sig.value_pct = ev.value_pct
        sig.confidence = ev.confidence
        sig.risk = ev.risk
        sig.rank = ev.rank
        sig.status = "pending"


def lock_started(db: Session) -> int:
    """Freeze signals at kick-off so the record uses prices that were available."""
    now = datetime.now(UTC)
    n = 0
    for sig in db.scalars(
        select(Signal)
        .join(Fixture, Fixture.id == Signal.fixture_id)
        .where(Signal.locked.is_(False), Fixture.kickoff_at <= now)
    ):
        sig.locked = True
        n += 1
    db.commit()
    return n


def run_analysis(db: Session, days_ahead: int) -> int:
    lock_started(db)
    fixtures = upcoming(db, days_ahead * 24)
    for f in fixtures:
        analyse_fixture(db, f)
    return len(fixtures)
