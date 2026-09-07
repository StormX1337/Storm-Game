"""Quoten-Endpunkte (aktueller Stand aus Redis)."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from backend.api.deps import get_state
from backend.models.domain import now_ts
from backend.models.schemas import OddsResponse

router = APIRouter(prefix="/odds", tags=["odds"])


@router.get("", response_model=list[OddsResponse], summary="Aktuelle Quoten")
async def list_odds(
    request: Request,
    event_id: str = Query(..., description="Kanonische Event-ID"),
    market: str | None = Query(
        default=None, description="Marktschlüssel, z. B. over_under|2.5|full_time"
    ),
    include_stale: bool = Query(default=True, description="Auch veraltete Quoten zurückgeben"),
    max_age_seconds: float = Query(default=60.0, ge=0.1, le=3600.0),
) -> list[OddsResponse]:
    state = get_state(request)
    market_keys = [market] if market else await state.market_keys(event_id)

    reference = now_ts()
    out: list[OddsResponse] = []
    for market_key in market_keys:
        for quote in await state.get_market(event_id, market_key):
            age = quote.age(reference)
            if not include_stale and age > max_age_seconds:
                continue
            out.append(
                OddsResponse(
                    event_id=quote.event_id,
                    market=quote.market.key,
                    market_label=quote.market.label,
                    selection=quote.selection.key,
                    selection_label=quote.selection.display,
                    bookmaker=quote.bookmaker,
                    price=quote.price,
                    ts=quote.ts,
                    age_seconds=round(age, 2),
                    suspended=quote.suspended,
                    liquidity=quote.liquidity,
                    is_exchange=quote.is_exchange,
                )
            )
    out.sort(key=lambda q: (q.market, q.selection, q.price), reverse=False)
    return out
