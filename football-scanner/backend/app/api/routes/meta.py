from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.engine.markets import CATEGORY_OF, MARKET_LABELS, TAB_OF, Market
from app.engine.scoring import Rank, Risk
from app.models import League, User
from app.services import settings_service

router = APIRouter(prefix="/api/meta", tags=["meta"])


@router.get("")
def meta(user: User = Depends(current_user), db: Session = Depends(get_db)):
    enabled = set(settings_service.get(db, "markets").get("enabled") or [])
    leagues = list(
        db.scalars(
            select(League).where(League.enabled.is_(True)).order_by(League.country, League.name)
        )
    )
    return {
        "user": {"id": user.id, "email": user.email, "role": user.role},
        "markets": [
            {
                "key": m.value,
                "label": MARKET_LABELS[m],
                "category": CATEGORY_OF[m],
                "tab": TAB_OF[m],
                "enabled": m.value in enabled,
            }
            for m in Market
        ],
        "categories": ["1X2", "GOALS", "BTTS", "ASIAN", "CORNERS", "CARDS"],
        "risks": [r.label for r in Risk],
        "ranks": [r.value for r in Rank],
        "leagues": [
            {"id": lg.id, "name": lg.name, "country": lg.country, "logo": lg.logo} for lg in leagues
        ],
        "countries": sorted({lg.country for lg in leagues if lg.country}),
    }
