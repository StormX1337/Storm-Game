"""Event-Endpunkte.

Gelesen wird aus Redis (aktueller Zustand). Nur wenn dort nichts liegt -
z. B. direkt nach einem Neustart - greift die Datenbank als Rückfallebene.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Request

from backend.api.deps import app_settings, get_optional_repository, get_state
from backend.models.domain import EventSnapshot, now_ts
from backend.models.schemas import EventResponse

router = APIRouter(prefix="/events", tags=["events"])


def _to_response(event: EventSnapshot, *, max_age: float, reference: float) -> EventResponse:
    data = event.to_json()
    age = event.age(reference)
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
        seconds_since_update=round(age, 1),
        stale=age > max_age,
    )


def _row_age(updated_at: datetime | None) -> float | None:
    """Alter einer Datenbankzeile in Sekunden.

    PostgreSQL liefert den Zeitstempel mit Zeitzone, SQLite (Tests) ohne.
    Ohne diese Angleichung wirft der Vergleich - und der Rückfallpfad der
    API wäre genau dann kaputt, wenn er gebraucht wird.
    """
    if updated_at is None:
        return None
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=UTC)
    return max(0.0, (datetime.now(UTC) - updated_at).total_seconds())


def _row_to_response(row, *, max_age: float) -> EventResponse:
    live = row.live_state or {}
    age = _row_age(row.updated_at)
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
        seconds_since_update=round(age, 1) if age is not None else None,
        stale=age is not None and age > max_age,
    )


async def _load(
    request: Request, *, only_live: bool, sport: str | None, limit: int, offset: int
) -> list[EventResponse]:
    max_age = app_settings(request).event_stale_seconds
    reference = now_ts()
    state = get_state(request)
    ids = await (state.live_event_ids() if only_live else state.all_event_ids())
    events = await state.get_events(ids)
    if sport:
        events = [e for e in events if e.sport.value == sport]
    # Ein beendetes Spiel meldet kein "beendet", es hört auf zu erscheinen.
    # In der Live-Liste hat es deshalb nichts verloren, sobald die Daten alt
    # sind - der Aufräumer im Scanner räumt es kurz darauf auch aus Redis.
    known = len(events)
    if only_live:
        events = [e for e in events if e.age(reference) <= max_age]
    events.sort(key=lambda e: (e.status.value != "LIVE", -(e.updated_at or 0)))

    if events:
        return [
            _to_response(e, max_age=max_age, reference=reference)
            for e in events[offset : offset + limit]
        ]
    # Die Datenbank ist nur Rückfallebene für den leeren Redis (z. B. direkt
    # nach einem Neustart). Wenn Redis Events kennt und alle nur zu alt sind,
    # ist die richtige Antwort "nichts läuft" - und nicht dieselben veralteten
    # Zeilen noch einmal aus der Datenbank.
    if known:
        return []

    repo = get_optional_repository(request)
    if repo is None:
        return []
    rows = await repo.list_events(
        sport=sport, status="LIVE" if only_live else None, limit=limit, offset=offset
    )
    responses = [_row_to_response(row, max_age=max_age) for row in rows]
    return [r for r in responses if not (only_live and r.stale)]


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
    max_age = app_settings(request).event_stale_seconds
    state = get_state(request)
    event = await state.get_event(event_id)
    if event is not None:
        return _to_response(event, max_age=max_age, reference=now_ts())
    repo = get_optional_repository(request)
    if repo is not None:
        row = await repo.get_event(event_id)
        if row is not None:
            return _row_to_response(row, max_age=max_age)
    raise HTTPException(status_code=404, detail="Event unbekannt")
