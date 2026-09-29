from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.models import JobRun, League, User
from app.providers.registry import api_key
from app.services import settings_service
from app.services.queries import (
    VALUE_RANKS,
    analyses_for,
    day_window,
    fixtures_between,
    flatten,
    sort_key,
)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def data_status(db: Session) -> dict:
    odds_source = settings_service.get(db, "odds").get("source")
    runs = {r.name: r for r in db.scalars(select(JobRun))}
    return {
        "football_api_configured": bool(api_key(db, "api_football")),
        "odds_api_configured": bool(
            api_key(db, "api_football" if odds_source == "api_football" else "the_odds_api")
        ),
        "enabled_leagues": len(list(db.scalars(select(League.id).where(League.enabled.is_(True))))),
        "last_analysis_at": runs["analysis"].last_finished_at if "analysis" in runs else None,
        "last_odds_at": runs["odds"].last_finished_at if "odds" in runs else None,
    }


@router.get("")
def dashboard(
    date: str | None = None,
    tz: str | None = Query(None, max_length=64),
    limit: int = Query(25, ge=1, le=100),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    start, end = day_window(date, tz)
    fixtures = fixtures_between(db, start, end)
    analyses = analyses_for(db, fixtures)
    evals = [ev for f in fixtures for ev in flatten(f, analyses.get(f.id))]
    value = [e for e in evals if e.get("rank") in VALUE_RANKS]
    value.sort(key=sort_key)
    return {
        "window": {"start": start, "end": end},
        "matches_today": len(fixtures),
        "analysed": len(analyses),
        "value_opportunities": len(value),
        "strong_signals": sum(1 for e in value if e["rank"] in ("BEST_VALUE", "STRONG_VALUE")),
        "high_risk": sum(1 for e in value if e.get("risk") in ("HIGH", "VERY HIGH")),
        "best_value": value[:limit],
        "data_status": data_status(db),
    }
