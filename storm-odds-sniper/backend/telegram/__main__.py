"""Telegram-Worker starten::

python -m backend.telegram
"""

from __future__ import annotations

import asyncio
import contextlib
import signal

from backend.core.config import get_settings
from backend.core.logging import configure_logging, get_logger
from backend.database.base import dispose_engine, get_session_factory, ping
from backend.database.repository import Repository
from backend.services.redis_state import RedisState
from backend.telegram.bot import run_bot

log = get_logger("telegram.main")


async def run() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    if not settings.telegram_bot_token:
        log.warning(
            "TELEGRAM_BOT_TOKEN fehlt - es werden keine Benachrichtigungen "
            "verschickt. Scanner, API und Dashboard laufen unabhängig weiter. "
            "Token in die .env eintragen und 'docker compose up -d' erneut "
            "ausführen."
        )
        # Bewusst warten statt beenden: der Container läuft mit
        # restart:unless-stopped, und das startet auch bei Exit-Code 0 neu -
        # ein sofortiges Ende wäre eine endlose Neustartschleife.
        await stop.wait()
        return

    state = RedisState(
        settings.redis_url,
        ttl=settings.odds_state_ttl_seconds,
        refresh_seconds=settings.quote_refresh_seconds,
        max_connections=10,
        channel_alerts=settings.channel_alerts,
        channel_odds=settings.channel_odds,
        channel_events=settings.channel_events,
    )
    await state.connect()

    repository: Repository | None = None
    if await ping():
        repository = Repository(get_session_factory(settings))
    else:
        log.warning("datenbank nicht erreichbar - nur der Standard-Chat bekommt Alarme")

    bot_task = asyncio.create_task(run_bot(settings, state, repository), name="telegram-bot")
    stop_task = asyncio.create_task(stop.wait(), name="stop-signal")
    done, _pending = await asyncio.wait({bot_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
    for task in (bot_task, stop_task):
        if task not in done:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
    if bot_task in done and bot_task.exception() is not None:
        log.error("telegram-bot abgestürzt", error=str(bot_task.exception()))

    await state.close()
    await dispose_engine()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:  # pragma: no cover
        pass


if __name__ == "__main__":
    main()
