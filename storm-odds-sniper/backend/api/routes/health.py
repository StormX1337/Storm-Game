"""Health- und Provider-Endpunkte."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Request

from backend.api.deps import get_optional_repository, get_state
from backend.core.config import get_settings
from backend.core.logging import get_logger
from backend.database.base import ping as db_ping
from backend.models.domain import now_ts
from backend.models.schemas import HealthComponent, HealthResponse, ProviderHealthResponse
from backend.providers.registry import PROVIDER_SPECS, describe_providers

log = get_logger("api.health")
router = APIRouter(tags=["health"])


def _dt(ts: float | None) -> datetime | None:
    return datetime.fromtimestamp(ts, tz=UTC) if ts else None


@router.get("/health", response_model=HealthResponse, summary="Gesamtstatus der API")
async def health(request: Request) -> HealthResponse:
    settings = get_settings()
    components: list[HealthComponent] = []

    state = getattr(request.app.state, "redis", None)
    redis_ok = bool(state) and await state.ping()
    components.append(
        HealthComponent(
            name="redis", healthy=redis_ok, detail="" if redis_ok else "nicht erreichbar"
        )
    )

    db_ok = await db_ping()
    components.append(
        HealthComponent(name="database", healthy=db_ok, detail="" if db_ok else "nicht erreichbar")
    )

    started = getattr(request.app.state, "started_at", now_ts())
    return HealthResponse(
        status="ok" if all(c.healthy for c in components) else "degraded",
        version=settings.app_version,
        environment=settings.environment,
        uptime_seconds=round(now_ts() - started, 1),
        prematch_enabled=settings.prematch_enabled,
        threshold_bands=settings.threshold_bands(),
        silence_alert_seconds=(
            settings.silence_alert_seconds if settings.silence_alert_enabled else None
        ),
        components=components,
    )


@router.get(
    "/health/providers",
    response_model=list[ProviderHealthResponse],
    summary="Status aller Datenquellen",
)
async def provider_health(request: Request) -> list[ProviderHealthResponse]:
    settings = get_settings()
    state = getattr(request.app.state, "redis", None)
    live: dict[str, dict] = {}
    if state is not None:
        try:
            live = {row.get("name"): row for row in await state.get_provider_health()}
        except Exception:  # noqa: BLE001 - Health darf nie 500 liefern
            live = {}

    if not live:
        repo = get_optional_repository(request)
        if repo is not None:
            try:
                for row in await repo.list_provider_health():
                    live[row.provider] = {
                        "status": row.status,
                        "healthy": row.status == "connected",
                        "messages": row.messages,
                        "quotes": row.quotes,
                        "errors": row.errors,
                        "reconnects": row.reconnects,
                        "rate_limit_remaining": row.rate_limit_remaining,
                        "latency_ms": row.latency_ms,
                        "detail": row.detail,
                        "connected_since": row.connected_since.timestamp()
                        if row.connected_since
                        else None,
                        "last_message_at": row.last_message_at.timestamp()
                        if row.last_message_at
                        else None,
                    }
            except Exception as exc:  # noqa: BLE001 - Health darf nie 500 liefern
                log.debug("provider-health aus der Datenbank nicht lesbar", error=str(exc))

    out: list[ProviderHealthResponse] = []
    for spec in describe_providers(settings):
        row = live.get(spec.key, {})
        enabled = spec.key in settings.provider_names
        status = row.get("status") or ("disabled" if not enabled else "unknown")
        connected_since = row.get("connected_since")
        last_message = row.get("last_message_at")
        out.append(
            ProviderHealthResponse(
                key=spec.key,
                title=spec.title,
                kind=spec.kind,
                status=status,
                healthy=bool(row.get("healthy", False)),
                requires_credentials=spec.requires_credentials,
                missing_credentials=spec.missing,
                docs_url=spec.docs_url,
                notes=spec.notes,
                connected_since=_dt(connected_since)
                if isinstance(connected_since, (int, float))
                else None,
                last_message_at=_dt(last_message)
                if isinstance(last_message, (int, float))
                else None,
                seconds_since_message=row.get("seconds_since_message"),
                messages=int(row.get("messages", 0) or 0),
                quotes=int(row.get("quotes", 0) or 0),
                errors=int(row.get("errors", 0) or 0),
                reconnects=int(row.get("reconnects", 0) or 0),
                rate_limit_remaining=row.get("rate_limit_remaining"),
                latency_ms=row.get("latency_ms"),
                detail=str(row.get("detail", "") or ""),
            )
        )
    return out


@router.get("/providers", summary="Katalog der verfügbaren Datenquellen")
async def providers() -> list[dict]:
    settings = get_settings()
    return [
        {
            "key": spec.key,
            "title": spec.title,
            "kind": spec.kind,
            "requires_credentials": spec.requires_credentials,
            "missing_credentials": spec.missing,
            "docs_url": spec.docs_url,
            "notes": spec.notes,
            "enabled": spec.key in settings.provider_names,
        }
        for spec in describe_providers(settings)
    ]


__all__ = ["router", "PROVIDER_SPECS", "get_state"]
