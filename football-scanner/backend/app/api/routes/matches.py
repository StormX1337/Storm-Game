from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, require_admin
from app.db import get_db
from app.engine.markets import Selection
from app.engine.movement import summarize
from app.models import Fixture, FixtureAnalysis, FixtureEvent, FixtureTeamStats, User
from app.services import analysis_service, settings_service
from app.services.context import odds_state
from app.services.queries import (
    analyses_for,
    day_window,
    fixture_card,
    fixture_meta,
    fixtures_between,
)
from app.services.sync import NOT_STARTED

router = APIRouter(prefix="/api/matches", tags=["matches"])


@router.get("")
def list_matches(
    date: str | None = None,
    tz: str | None = Query(None, max_length=64),
    league_id: list[int] | None = Query(None),
    country: list[str] | None = Query(None),
    q: str | None = Query(None, max_length=64),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    start, end = day_window(date, tz)
    fixtures = fixtures_between(db, start, end, league_id, country)
    if q:
        needle = q.lower()
        fixtures = [
            f for f in fixtures if needle in f"{f.home_name} {f.away_name} {f.league_name}".lower()
        ]
    analyses = analyses_for(db, fixtures)
    return {"matches": [fixture_card(f, analyses.get(f.id)) for f in fixtures]}


def _fixture_or_404(db: Session, fixture_id: int) -> Fixture:
    fx = db.get(Fixture, fixture_id)
    if fx is None:
        raise HTTPException(404, "Match not found")
    return fx


@router.get("/{fixture_id}")
def match_detail(
    fixture_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
):
    fx = _fixture_or_404(db, fixture_id)
    analysis = db.get(FixtureAnalysis, fixture_id)
    if analysis is None and fx.status in NOT_STARTED and fx.kickoff_at > datetime.now(UTC):
        analysis_service.analyse_fixture(db, fx)
        analysis = db.get(FixtureAnalysis, fixture_id)
    return {
        "fixture": {
            **fixture_meta(fx),
            "venue": fx.venue,
            "referee": fx.referee,
            "round": fx.round,
            "ht_home_goals": fx.ht_home_goals,
            "ht_away_goals": fx.ht_away_goals,
        },
        "analysis": None
        if analysis is None
        else {**analysis.payload, "computed_at": analysis.computed_at},
    }


@router.get("/{fixture_id}/odds")
def match_odds(
    fixture_id: int,
    key: str | None = Query(None, max_length=64),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    _fixture_or_404(db, fixture_id)
    cfg = settings_service.get(db, "odds")
    state = odds_state(
        db, fixture_id, float(cfg.get("max_snapshot_age_hours", 6)), datetime.now(UTC)
    )
    strong = float(cfg.get("movement_alert_pct", 10))

    def describe(k: str) -> dict:
        m = summarize(state.series.get(k, []), strong)
        sel = Selection.from_key(k)
        return {
            "key": k,
            "label": sel.label(),
            "market": sel.market.value,
            "bookmakers": state.by_bookmaker.get(k, {}),
            "movement": None
            if m is None
            else {
                "opening": m.opening,
                "current": m.current,
                "lowest": m.lowest,
                "highest": m.highest,
                "movement_pct": m.movement_pct,
                "direction": m.direction,
                "alert": m.alert,
                "opened_at": m.opened_at,
                "updated_at": m.updated_at,
                "samples": m.samples,
            },
        }

    if key:
        if key not in state.series:
            raise HTTPException(404, "No prices recorded for this selection")
        out = describe(key)
        out["series"] = [{"time": t, "odds": o} for t, o in state.series[key]]
        return out
    return {"selections": [describe(k) for k in sorted(state.series)]}


@router.get("/{fixture_id}/statistics")
def match_statistics(
    fixture_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
):
    fx = _fixture_or_404(db, fixture_id)
    stats = {
        r.team_id: r
        for r in db.scalars(
            select(FixtureTeamStats).where(FixtureTeamStats.fixture_id == fixture_id)
        )
    }

    def team(team_id: int) -> dict | None:
        s = stats.get(team_id)
        if s is None:
            return None
        return {
            "shots": s.shots,
            "shots_on_target": s.shots_on_target,
            "possession": s.possession,
            "corners": s.corners,
            "yellow_cards": s.yellow_cards,
            "red_cards": s.red_cards,
            "fouls": s.fouls,
            "xg": s.xg,
        }

    events = db.scalars(
        select(FixtureEvent)
        .where(FixtureEvent.fixture_id == fixture_id)
        .order_by(FixtureEvent.minute)
    )
    return {
        "status": fx.status,
        "elapsed": fx.elapsed,
        "score": {"home": fx.home_goals, "away": fx.away_goals},
        "home": team(fx.home_team_id),
        "away": team(fx.away_team_id),
        "events": [
            {
                "minute": e.minute,
                "extra": e.extra,
                "type": e.type,
                "detail": e.detail,
                "player": e.player_name,
                "assist": e.assist_name,
                "side": "home" if e.team_id == fx.home_team_id else "away",
            }
            for e in events
        ],
    }


@router.post("/{fixture_id}/refresh")
def refresh(fixture_id: int, user: User = Depends(require_admin), db: Session = Depends(get_db)):
    fx = _fixture_or_404(db, fixture_id)
    analysis_service.analyse_fixture(db, fx)
    return {"ok": True}
