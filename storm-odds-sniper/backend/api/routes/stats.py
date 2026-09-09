"""Kennzahlen fürs Dashboard."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from backend.api.deps import get_optional_repository
from backend.core.filters import SUPPRESSION_LABELS
from backend.core.logging import get_logger
from backend.core.recommendation import GRADE_LABELS, PLAYABLE_GRADES
from backend.core.verdict import VERDICT_LABELS
from backend.models.schemas import StatsResponse, SuppressionReason, VerdictCount

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
    suppressed: dict[str, int] = {}
    verdicts: dict[str, int] = {}
    grades: dict[str, int] = {}
    followups_pending = 0
    if state is not None:
        try:
            counters = await state.counters()
            providers = await state.get_provider_health()
            suppressed = await state.get_suppressions()
            verdicts = await state.get_verdicts()
            grades = await state.get_grades()
            followups_pending = await state.pending_followups()
        except Exception as exc:  # noqa: BLE001 - Kennzahlen dürfen nie 500 werfen
            log.debug("redis-kennzahlen nicht lesbar", error=str(exc))

    avg_clv: float | None = None
    if repo is not None:
        try:
            avg_clv = (await repo.scorecard(window_hours=window_hours))["avg_clv_percent"]
        except Exception as exc:  # noqa: BLE001 - Bilanz ist ein Extra, kein Muss
            log.debug("trefferbilanz nicht lesbar", error=str(exc))

    reasons = [
        SuppressionReason(code=code, label=SUPPRESSION_LABELS.get(code, code), count=count)
        for code, count in sorted(suppressed.items(), key=lambda kv: kv[1], reverse=True)
    ]

    return StatsResponse(
        **base,
        tracked_events_redis=counters["tracked_events"],
        live_events_redis=counters["live_events"],
        providers_connected=sum(1 for p in providers if p.get("healthy")),
        providers_total=len(providers),
        suppressed=reasons,
        suppressed_total=sum(suppressed.values()),
        verdicts=[
            VerdictCount(verdict=code, label=VERDICT_LABELS.get(code, code), count=count)
            for code, count in sorted(verdicts.items(), key=lambda kv: kv[1], reverse=True)
        ],
        followups_pending=followups_pending,
        avg_clv_percent=avg_clv,
        grades=[
            SuppressionReason(code=code, label=GRADE_LABELS.get(code, code), count=count)
            for code, count in sorted(grades.items(), key=lambda kv: kv[1], reverse=True)
        ],
        playable_alerts=sum(
            count for code, count in grades.items() if code in {g.value for g in PLAYABLE_GRADES}
        ),
    )
