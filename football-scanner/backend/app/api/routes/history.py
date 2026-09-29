from collections import defaultdict
from dataclasses import asdict
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.engine.performance import SettledBet, calibration, summarize
from app.models import Fixture, Signal, User

router = APIRouter(prefix="/api/history", tags=["history"])

GRADED = ("won", "half_won", "push", "half_lost", "lost", "void")
CATEGORIES = ("1X2", "GOALS", "CORNERS", "CARDS", "ASIAN", "BTTS")


def _parse(d: str | None) -> datetime | None:
    if not d:
        return None
    dt = datetime.fromisoformat(d)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _query(
    category: str | None,
    status: str | None,
    start: datetime | None,
    end: datetime | None,
    rank: str | None,
):
    q = (
        select(Signal, Fixture)
        .join(Fixture, Fixture.id == Signal.fixture_id)
        .where(Signal.status != "withdrawn")
    )
    if category:
        q = q.where(Signal.category == category)
    if status == "pending":
        q = q.where(Signal.status == "pending")
    elif status == "settled":
        q = q.where(Signal.status.in_(GRADED))
    elif status:
        q = q.where(Signal.status == status)
    if rank:
        q = q.where(Signal.rank == rank)
    if start:
        q = q.where(Fixture.kickoff_at >= start)
    if end:
        q = q.where(Fixture.kickoff_at < end)
    return q


@router.get("")
def history(
    category: str | None = Query(None, max_length=16),
    status: str | None = Query(None, max_length=16),
    rank: str | None = Query(None, max_length=24),
    start: str | None = None,
    end: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    q = _query(category, status, _parse(start), _parse(end), rank).order_by(
        Fixture.kickoff_at.desc(), Signal.id
    )
    rows = db.execute(q.offset((page - 1) * page_size).limit(page_size + 1)).all()
    items = [
        {
            "id": s.id,
            "date": f.kickoff_at,
            "fixture_id": f.id,
            "match": f"{f.home_name} vs {f.away_name}",
            "league": f.league_name,
            "score": None if f.home_goals is None else f"{f.home_goals}-{f.away_goals}",
            "market": s.market,
            "category": s.category,
            "label": s.label,
            "odds": s.odds,
            "bookmaker": s.bookmaker,
            "probability": s.probability,
            "fair_odds": s.fair_odds,
            "value_pct": s.value_pct,
            "confidence": s.confidence,
            "risk": s.risk,
            "rank": s.rank,
            "status": s.status,
            "result": s.result_detail,
            "profit": s.profit_units,
        }
        for s, f in rows[:page_size]
    ]
    return {"items": items, "page": page, "has_more": len(rows) > page_size}


@router.get("/stats")
def stats(
    start: str | None = None,
    end: str | None = None,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    rows = db.execute(_query(None, None, _parse(start), _parse(end), None)).all()
    graded = sorted(
        (r for r in rows if r[0].status in GRADED),
        key=lambda r: (r[0].settled_at or r[1].kickoff_at, r[0].id),
    )
    bets = [
        SettledBet(s.odds, s.probability, s.status, s.profit_units or 0.0, s.category)
        for s, _ in graded
    ]
    by_rank: dict[str, list[SettledBet]] = defaultdict(list)
    curve, running = [], 0.0
    for bet, (s, f) in zip(bets, graded, strict=True):
        by_rank[s.rank].append(bet)
        running += bet.profit
        curve.append({"date": s.settled_at or f.kickoff_at, "profit": round(running, 4)})
    return {
        "overall": asdict(summarize(bets)),
        "pending": sum(1 for s, _ in rows if s.status == "pending"),
        "by_category": {
            c: asdict(summarize([b for b in bets if b.category == c])) for c in CATEGORIES
        },
        "by_rank": {r: asdict(summarize(v)) for r, v in by_rank.items()},
        "calibration": calibration(bets),
        "equity_curve": curve,
        "stake_note": "All figures assume a flat one-unit stake per signal.",
    }
