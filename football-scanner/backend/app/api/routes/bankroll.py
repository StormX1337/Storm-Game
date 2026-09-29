from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.db import get_db
from app.engine.bankroll import StakeMethod, recommend
from app.models import User
from app.services import settings_service

router = APIRouter(prefix="/api/bankroll", tags=["bankroll"])


class StakeRequest(BaseModel):
    bankroll: float = Field(gt=0, le=1e9)
    method: StakeMethod = StakeMethod.HALF_KELLY
    percent: float | None = Field(None, ge=0, le=100)
    fixed_amount: float | None = Field(None, ge=0)
    probability: float | None = Field(None, gt=0, lt=1)
    odds: float | None = Field(None, gt=1, le=1000)
    cap_percent: float | None = Field(None, ge=0, le=100)


@router.get("/defaults")
def defaults(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return (user.preferences or {}).get("bankroll") or settings_service.get(db, "bankroll_defaults")


@router.post("/calculate")
def calculate(
    body: StakeRequest, user: User = Depends(current_user), db: Session = Depends(get_db)
):
    cap = body.cap_percent
    if cap is None:
        cap = float(settings_service.get(db, "bankroll_defaults").get("cap_percent", 2.0))
    try:
        rec = recommend(
            body.bankroll,
            body.method,
            fixed_amount=body.fixed_amount,
            percent=body.percent,
            probability=body.probability,
            odds=body.odds,
            cap_percent=cap,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    prefs = dict(user.preferences or {})
    prefs["bankroll"] = {
        "bankroll": body.bankroll,
        "method": body.method.value,
        "percent": body.percent,
        "fixed_amount": body.fixed_amount,
        "cap_percent": cap,
    }
    user.preferences = prefs
    db.commit()
    return {
        **asdict(rec),
        "policy": (
            "Stakes never increase after a loss. "
            "Recommendations are sizing guidance, not a promise of profit."
        ),
    }
