"""Scanner-Worker (eigener Prozess).

Start::

    python -m backend.scanner
"""

from __future__ import annotations

import asyncio
import contextlib
import signal

from backend.core.config import get_settings
from backend.core.logging import configure_logging, get_logger
from backend.database.base import dispose_engine, get_session_factory, ping
from backend.database.repository import Repository
from backend.providers.registry import build_providers
from backend.scanner.engine import ScannerEngine
from backend.services.redis_state import RedisState

log = get_logger("scanner.main")


async def run() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)

    state = RedisState(
        settings.redis_url,
        ttl=settings.odds_state_ttl_seconds,
        refresh_seconds=settings.quote_refresh_seconds,
        max_connections=settings.redis_max_connections,
        channel_alerts=settings.channel_alerts,
        channel_odds=settings.channel_odds,
        channel_events=settings.channel_events,
    )
    await state.connect()

    repository: Repository | None = None
    if await ping():
        repository = Repository(get_session_factory(settings))
        log.info("datenbank verbunden")
    else:
        log.warning("datenbank nicht erreichbar - Scanner läuft ohne Historie weiter")

    providers = build_providers(settings)
    engine = ScannerEngine(settings, state=state, repository=repository, providers=providers)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    await engine.start()
    log.info(
        "storm odds sniper scanner läuft",
        providers=",".join(p.name for p in providers),
        min_value=settings.min_value_percent,
        min_bookmakers=settings.min_bookmakers,
    )
    try:
        await stop.wait()
    finally:
        log.info("beende scanner")
        await engine.stop()
        await state.close()
        await dispose_engine()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:  # pragma: no cover - manueller Abbruch
        pass


if __name__ == "__main__":
    main()
