"""Sichere Wetten: wenn die Buchmacher sich untereinander widersprechen.

Gelesen wird aus Redis - Funde sind Sekunden gültig und laufen dort von
selbst ab. Eine sichere Wette, die es seit zehn Minuten nicht mehr gibt, ist
wertloser als gar keine.
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from backend.api.deps import app_settings, get_state
from backend.models.schemas import ArbitrageResponse

router = APIRouter(prefix="/arbitrage", tags=["arbitrage"])


@router.get(
    "",
    response_model=ArbitrageResponse,
    summary="Sichere Wetten",
    description=(
        "Märkte, in denen sich die Bücher widersprechen: alle Ausgänge zum "
        "jeweils besten Preis, Summe der Gegenwahrscheinlichkeiten unter "
        "100 %.\n\n"
        "Das ist **Arithmetik, keine Schätzung** — und trotzdem kein "
        "Selbstläufer: beide Preise müssen stehen bleiben, bis beide Wetten "
        "platziert sind. `suspicious` markiert Funde, die zu gut sind, um "
        "wahr zu sein; die sind praktisch immer ein Datenfehler."
    ),
)
async def list_arbitrage(
    request: Request,
    include_suspicious: bool = Query(
        default=False,
        description="Auch unplausibel große Funde ausliefern (Datenfehlerverdacht).",
    ),
) -> ArbitrageResponse:
    settings = app_settings(request)
    if not settings.arbitrage_enabled:
        return ArbitrageResponse(enabled=False)
    state = get_state(request)
    rows = await state.get_arbitrages()
    verdaechtig = sum(1 for row in rows if row.get("suspicious"))
    if not include_suspicious:
        rows = [row for row in rows if not row.get("suspicious")]
    return ArbitrageResponse(
        enabled=True,
        found=len(rows),
        suspicious_hidden=0 if include_suspicious else verdaechtig,
        items=rows,
    )
