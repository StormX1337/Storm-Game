"""Quoten-Endpunkte (aktueller Stand aus Redis)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Query, Request

from backend.api.deps import get_optional_repository, get_state
from backend.models.domain import now_ts
from backend.models.schemas import OddsHistoryPoint, OddsHistoryResponse, OddsResponse

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


@router.get(
    "/history",
    response_model=OddsHistoryResponse,
    summary="Preisverlauf einer Quotenzeile",
    description=(
        "Wie sich ein Preis **eines Buchmachers** in den letzten Minuten "
        "bewegt hat — aus den gespeicherten Snapshots, ohne zusätzlichen "
        "Abruf beim Anbieter.\n\n"
        "`bookmaker` ist Pflicht: ohne ihn lägen die Preise verschiedener "
        "Bücher in einer Kurve, und `change_percent` wäre nur der Abstand "
        "zwischen zwei Häusern statt einer Bewegung.\n\n"
        "Eine Quote, die seit zehn Minuten unverändert steht, während der "
        "Markt abrutscht, ist etwas ganz anderes als eine, die eben erst "
        "dort angekommen ist. Genau das zeigt der Verlauf."
    ),
)
async def odds_history(
    request: Request,
    event_id: str = Query(..., max_length=64),
    market: str = Query(..., max_length=96, description="z. B. over_under|2.5|full_time"),
    selection: str = Query(..., max_length=96),
    bookmaker: str = Query(
        ...,
        max_length=64,
        description=(
            "Pflicht: ohne ihn lägen Preise verschiedener Bücher in einer "
            "Kurve, und die Änderung wäre nur der Abstand zwischen ihnen."
        ),
    ),
    minutes: int = Query(default=30, ge=1, le=1440),
    limit: int = Query(default=120, ge=2, le=500),
) -> OddsHistoryResponse:
    antwort = OddsHistoryResponse(
        event_id=event_id,
        market=market,
        selection=selection,
        bookmaker=bookmaker,
        minutes=minutes,
    )
    repo = get_optional_repository(request)
    if repo is None:
        return antwort
    rows = await repo.odds_history(
        event_id=event_id,
        market_key=market,
        selection_key=selection,
        bookmaker=bookmaker,
        since=datetime.now(UTC) - timedelta(minutes=minutes),
        limit=limit,
    )
    antwort.points = [
        OddsHistoryPoint(ts=row["ts"], price=row["price"], suspended=row["suspended"])
        for row in rows
    ]
    if antwort.points:
        antwort.first_price = antwort.points[0].price
        antwort.last_price = antwort.points[-1].price
        if antwort.first_price:
            antwort.change_percent = (antwort.last_price / antwort.first_price - 1.0) * 100.0
    return antwort
