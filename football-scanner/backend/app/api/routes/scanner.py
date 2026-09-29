from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.engine.markets import Market
from app.engine.scoring import Rank, Risk
from app.models import User
from app.services import settings_service
from app.services.queries import (
    analyses_for,
    day_window,
    fixtures_between,
    flatten,
    matches_filter,
    sort_key,
)

router = APIRouter(prefix="/api/scanner", tags=["scanner"])

CATEGORIES = {"1X2", "GOALS", "BTTS", "ASIAN", "CORNERS", "CARDS"}


class Filters(BaseModel):
    min_probability: float = Field(0.0, ge=0, le=1)
    min_value: float = Field(0.0, ge=-100, le=1000)
    max_risk: str = "VERY HIGH"
    min_confidence: int = Field(0, ge=0, le=100)

    @field_validator("max_risk")
    @classmethod
    def _risk(cls, v: str) -> str:
        return Risk.parse(v).label


class ScanRequest(Filters):
    date: str | None = None
    tz: str | None = Field(None, max_length=64)
    league_ids: list[int] = []
    countries: list[str] = []
    markets: list[str] = []  # market keys (e.g. over_under) or categories (e.g. CORNERS)
    ranks: list[str] = []
    limit: int = Field(200, ge=1, le=1000)


@router.post("/scan")
def scan(body: ScanRequest, user: User = Depends(current_user), db: Session = Depends(get_db)):
    start, end = day_window(body.date, body.tz)
    fixtures = fixtures_between(db, start, end, body.league_ids or None, body.countries or None)
    analyses = analyses_for(db, fixtures)
    market_keys = {m for m in body.markets if m in {x.value for x in Market}}
    categories = {m.upper() for m in body.markets if m.upper() in CATEGORIES}
    ranks = {r for r in body.ranks if r in {x.value for x in Rank}}
    results = [
        ev
        for f in fixtures
        for ev in flatten(f, analyses.get(f.id))
        if matches_filter(
            ev,
            markets=market_keys or None,
            categories=categories or None,
            min_probability=body.min_probability,
            min_value=body.min_value,
            max_risk=body.max_risk,
            min_confidence=body.min_confidence,
            ranks=ranks or None,
        )
    ]
    results.sort(key=sort_key)
    return {
        "scanned_matches": len(fixtures),
        "analysed_matches": len(analyses),
        "results": results[: body.limit],
        "total": len(results),
    }


@router.get("/defaults")
def get_defaults(user: User = Depends(current_user), db: Session = Depends(get_db)):
    saved = (user.preferences or {}).get("scanner")
    return saved or settings_service.get(db, "scanner_defaults")


@router.put("/defaults")
def save_defaults(body: Filters, user: User = Depends(current_user), db: Session = Depends(get_db)):
    prefs = dict(user.preferences or {})
    prefs["scanner"] = body.model_dump()
    user.preferences = prefs
    db.commit()
    return prefs["scanner"]
