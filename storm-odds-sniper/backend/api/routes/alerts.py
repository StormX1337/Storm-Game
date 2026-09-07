"""Alarm-Endpunkte (Historie aus PostgreSQL)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Query, Request

from backend.api.deps import get_optional_repository
from backend.models.schemas import AlertResponse

router = APIRouter(prefix="/alerts", tags=["alerts"])


def _row_to_response(row) -> AlertResponse:
    payload = row.payload or {}
    event = payload.get("event", {}) or {}
    score = event.get("score") or {}
    score_text = None
    if score.get("home") is not None and score.get("away") is not None:
        score_text = f"{score['home']}:{score['away']}"
    return AlertResponse(
        id=row.id,
        kind=row.kind,
        sport=row.sport,
        event_id=row.event_id,
        event_title=f"{event.get('home', '?')} vs {event.get('away', '?')}",
        league=event.get("league"),
        status=event.get("status", "UNKNOWN"),
        score=score_text,
        market=row.market_key,
        market_label=row.market_label,
        selection=row.selection_key,
        selection_label=row.selection_label,
        bookmaker=row.bookmaker,
        odds=row.odds,
        fair_odds=row.fair_odds,
        value_percent=row.value_percent,
        deviation_percent=row.deviation_percent,
        confidence=row.confidence,
        error_score=row.error_score,
        bookmaker_count=row.bookmaker_count,
        detected_at=row.detected_at,
        provider=row.provider,
        previous_odds=payload.get("previous_odds"),
        notes=list(payload.get("notes", [])),
        fair_models=payload.get("fair_models") or {},
        score_components=payload.get("score_components") or {},
        references=payload.get("references") or {},
    )


@router.get("", response_model=list[AlertResponse], summary="Alarm-Historie")
async def list_alerts(
    request: Request,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    sport: str | None = Query(default=None, pattern="^(football|tennis)$"),
    kind: str | None = Query(default=None, pattern="^(value|fixed_error|odds_move)$"),
    min_value: float | None = Query(default=None, ge=-100, le=1000),
    since_minutes: int | None = Query(default=None, ge=1, le=10080),
) -> list[AlertResponse]:
    repo = get_optional_repository(request)
    if repo is None:
        return []
    since = datetime.now(UTC) - timedelta(minutes=since_minutes) if since_minutes else None
    rows = await repo.list_alerts(
        limit=limit, offset=offset, sport=sport, kind=kind, min_value=min_value, since=since
    )
    return [_row_to_response(row) for row in rows]
