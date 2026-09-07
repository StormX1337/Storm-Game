"""Kennzahlen fürs Dashboard."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from backend.api.deps import get_optional_repository
from backend.core.logging import get_logger
from backend.models.schemas import StatsResponse

log = get_logger("api.stats")
router = APIRouter(tags=["stats"])


@router.get("/stats", response_model=StatsResponse, summary="Systemkennzahlen")
async def stats(
    request: Request, window_hours: int = Query(default=24, ge=1, le=168)
) -> StatsResponse:
    repo = get_optional_repository(request)
    base = {
        "events_total": 0,
        "events_live": 0,
        "alerts_total": 0,
        "alerts_window": 0,
        "alerts_by_kind": {},
        "avg_value_percent": None,
        "odds_snapshots": 0,
        "bookmakers": 0,
        "window_hours": window_hours,
    }
    if repo is not None:
        base.update(await repo.stats(window_hours=window_hours))

    state = getattr(request.app.state, "redis", None)
    counters = {"live_events": 0, "tracked_events": 0}
    providers: list[dict] = []
    if state is not None:
        try:
            counters = await state.counters()
            providers = await state.get_provider_health()
        except Exception as exc:  # noqa: BLE001 - Kennzahlen dürfen nie 500 werfen
            log.debug("redis-kennzahlen nicht lesbar", error=str(exc))

    return StatsResponse(
        **base,
        tracked_events_redis=counters["tracked_events"],
        live_events_redis=counters["live_events"],
        providers_connected=sum(1 for p in providers if p.get("healthy")),
        providers_total=len(providers),
    )
