"""Event-Endpunkte.

Gelesen wird aus Redis (aktueller Zustand). Nur wenn dort nichts liegt -
z. B. direkt nach einem Neustart - greift die Datenbank als Rückfallebene.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from backend.api.deps import get_optional_repository, get_state
from backend.models.domain import EventSnapshot
from backend.models.schemas import EventResponse

router = APIRouter(prefix="/events", tags=["events"])


def _to_response(event: EventSnapshot) -> EventResponse:
    data = event.to_json()
    return EventResponse(
        event_id=data["event_id"],
        sport=data["sport"],
        league=data.get("league"),
        home=data["home"],
        away=data["away"],
        start_time=data.get("start_time"),
        status=data["status"],
        score=data.get("score"),
        football=data.get("football"),
        tennis=data.get("tennis"),
        provider=data.get("provider", ""),
        updated_at=data.get("updated_at"),
    )


def _row_to_response(row) -> EventResponse:
    live = row.live_state or {}
    return EventResponse(
        event_id=row.id,
        sport=row.sport,
        league=row.league,
        home=row.home,
        away=row.away,
        start_time=row.start_time,
        status=row.status,
        score={"home": row.score_home, "away": row.score_away}
        if row.score_home is not None or row.score_away is not None
        else None,
        football=live if row.sport == "football" and live else None,
        tennis=live if row.sport == "tennis" and live else None,
        updated_at=row.updated_at.timestamp() if row.updated_at else None,
    )


async def _load(
    request: Request, *, only_live: bool, sport: str | None, limit: int, offset: int
) -> list[EventResponse]:
    state = get_state(request)
    ids = await (state.live_event_ids() if only_live else state.all_event_ids())
    events = await state.get_events(ids)
    if sport:
        events = [e for e in events if e.sport.value == sport]
    events.sort(key=lambda e: (e.status.value != "LIVE", -(e.updated_at or 0)))

    if events:
        return [_to_response(e) for e in events[offset : offset + limit]]

    repo = get_optional_repository(request)
    if repo is None:
        return []
    rows = await repo.list_events(
        sport=sport, status="LIVE" if only_live else None, limit=limit, offset=offset
    )
    return [_row_to_response(row) for row in rows]


@router.get("", response_model=list[EventResponse], summary="Beobachtete Events")
async def list_events(
    request: Request,
    sport: str | None = Query(default=None, pattern="^(football|tennis)$"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[EventResponse]:
    return await _load(request, only_live=False, sport=sport, limit=limit, offset=offset)


@router.get("/live", response_model=list[EventResponse], summary="Nur Live-Events")
async def list_live_events(
    request: Request,
    sport: str | None = Query(default=None, pattern="^(football|tennis)$"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[EventResponse]:
    return await _load(request, only_live=True, sport=sport, limit=limit, offset=offset)


@router.get("/{event_id}", response_model=EventResponse, summary="Ein Event")
async def get_event(request: Request, event_id: str) -> EventResponse:
    state = get_state(request)
    event = await state.get_event(event_id)
    if event is not None:
        return _to_response(event)
    repo = get_optional_repository(request)
    if repo is not None:
        row = await repo.get_event(event_id)
        if row is not None:
            return _row_to_response(row)
    raise HTTPException(status_code=404, detail="Event unbekannt")
