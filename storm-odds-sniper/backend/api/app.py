"""FastAPI-Anwendung.

Die API schreibt keine Quoten und startet keinen Scanner. Dadurch können API
und Scanner unabhängig neu gestartet und skaliert werden, ohne sich
gegenseitig zu blockieren.

Die einzige Ausnahme vom Nur-Lesen ist das Wett-Tagebuch, und die ist
standardmäßig zu: ``BETLOG_API_WRITES`` schaltet sie frei. Grund siehe
``routes/bets.py`` - die API ist genau so geschützt wie das Dashboard davor.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from backend.api.middleware import (
    RateLimitMiddleware,
    RequestContextMiddleware,
    SecurityHeadersMiddleware,
)
from backend.api.routes import alerts, arbitrage, bets, events, health, odds, stats
from backend.api.ws import WebSocketHub
from backend.core.config import Settings, get_settings
from backend.core.logging import configure_logging, get_logger
from backend.database.base import dispose_engine, get_session_factory
from backend.database.base import ping as db_ping
from backend.database.repository import Repository
from backend.models.domain import now_ts
from backend.services.redis_state import RedisState

log = get_logger("api")

DESCRIPTION = """
**Storm Odds Sniper** - Analyse-API für Fußball- und Tennisquoten.

Der Dienst überwacht Quoten mehrerer Anbieter, berechnet faire Quoten aus dem
Marktkonsens und meldet Ausreißer, Value und Quotenbewegungen.

Es werden **keine Wetten platziert** und keine Buchmacherseiten manipuliert -
die API ist reine Analyse.
"""


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.started_at = now_ts()
        state = RedisState(
            settings.redis_url,
            ttl=settings.odds_state_ttl_seconds,
            refresh_seconds=settings.quote_refresh_seconds,
            max_connections=settings.redis_max_connections,
            channel_alerts=settings.channel_alerts,
            channel_odds=settings.channel_odds,
            channel_events=settings.channel_events,
        )
        try:
            await state.connect()
            app.state.redis = state
        except Exception as exc:  # noqa: BLE001 - API startet auch ohne Redis
            log.error("redis nicht erreichbar", error=str(exc))
            app.state.redis = None

        app.state.repository = None
        if await db_ping():
            app.state.repository = Repository(get_session_factory(settings))
        else:
            log.warning("datenbank nicht erreichbar - Historie-Endpunkte liefern leere Listen")

        hub: WebSocketHub | None = None
        if app.state.redis is not None:
            hub = WebSocketHub(app.state.redis, max_clients=settings.api_ws_max_clients)
            hub.start()
        app.state.hub = hub
        log.info("api bereit", version=settings.app_version, environment=settings.environment)
        if settings.betlog_enabled and settings.betlog_api_writes:
            # Kein Fehler, aber nichts, was man versehentlich anhaben will.
            log.warning(
                "WETT-TAGEBUCH: schreibzugriff über die API ist offen. "
                "Er ist genau so geschützt wie das Dashboard davor - ohne "
                "DASHBOARD_AUTH kann jeder im Netz Wetten eintragen.",
                origins=settings.cors_origins,
            )

        try:
            yield
        finally:
            if hub is not None:
                await hub.stop()
            if app.state.redis is not None:
                await app.state.redis.close()
            await dispose_engine()
            log.info("api beendet")

    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description=DESCRIPTION,
        lifespan=lifespan,
        docs_url="/docs" if settings.api_docs_enabled else None,
        redoc_url="/redoc" if settings.api_docs_enabled else None,
        openapi_url="/openapi.json" if settings.api_docs_enabled else None,
    )

    # Die Routen brauchen *diese* Settings, nicht die aus der Umgebung.
    # Ohne das ließe sich eine App gar nicht abweichend konfigurieren - und
    # Tests, die genau das tun, liefen stumm gegen die Standardwerte.
    app.state.settings = settings

    # Reihenfolge zählt: zuerst registrierte Middleware läuft außen.
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RateLimitMiddleware, limit_per_minute=settings.api_rate_limit_per_minute)
    app.add_middleware(RequestContextMiddleware)
    # Schreibende Methoden nur, wenn das Wett-Tagebuch sie überhaupt
    # annimmt - sonst bliebe eine offene Tür stehen, hinter der nichts ist.
    methods = ["GET", "OPTIONS"]
    if settings.betlog_enabled and settings.betlog_api_writes:
        methods += ["POST", "DELETE"]
    app.add_middleware(
        CORSMiddleware,
        # Bewusst keine Wildcard: nur die konfigurierten Dashboard-Origins.
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=methods,
        allow_headers=["*"],
        max_age=600,
    )

    app.include_router(health.router)
    app.include_router(events.router)
    app.include_router(odds.router)
    app.include_router(alerts.router)
    app.include_router(bets.router)
    app.include_router(arbitrage.router)
    app.include_router(stats.router)

    @app.get("/", include_in_schema=False)
    async def root() -> dict:
        return {
            "name": settings.app_name,
            "version": settings.app_version,
            "docs": "/docs" if settings.api_docs_enabled else None,
            "hinweis": "Reine Analyse-API - es werden keine Wetten platziert.",
        }

    @app.get("/metrics", include_in_schema=False)
    async def metrics() -> PlainTextResponse:
        return PlainTextResponse(generate_latest().decode(), media_type=CONTENT_TYPE_LATEST)

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        """Live-Stream für das Dashboard: Alarme, Events und Quotenbewegungen."""
        hub: WebSocketHub | None = getattr(websocket.app.state, "hub", None)
        if hub is None:
            await websocket.close(code=1011, reason="Redis nicht verfügbar")
            return
        if not await hub.connect(websocket):
            return
        try:
            while True:
                # Der Client sendet nur Keep-Alives; Nutzdaten fließen nur raus.
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001 - Client-Fehler beenden nur diese Verbindung
            log.debug("websocket beendet", error=str(exc))
        finally:
            await hub.disconnect(websocket)

    return app


app = create_app()
