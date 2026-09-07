"""Verhalten des Telegram-Workers ohne Zugangsdaten.

Der Container läuft mit ``restart: unless-stopped``. Docker startet damit
auch bei Exit-Code 0 neu - ein Worker, der sich ohne Token sofort beendet,
erzeugt deshalb eine endlose Neustartschleife.
"""

from __future__ import annotations

import asyncio

import pytest

from backend.core.config import Settings
from backend.telegram.__main__ import run


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch):
    """Settings ohne .env und ohne echte Umgebungsvariablen."""

    def factory() -> Settings:
        return Settings(_env_file=None, telegram_bot_token="", log_json=True)

    monkeypatch.setattr("backend.telegram.__main__.get_settings", factory)


class TestMissingToken:
    async def test_worker_keeps_running_instead_of_exiting(self):
        """Sonst: Neustartschleife, bis jemand den Container stoppt."""
        task = asyncio.create_task(run())
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(task), timeout=0.4)
        assert not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    async def test_it_says_why(self, capsys):
        task = asyncio.create_task(run())
        await asyncio.sleep(0.2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        out = capsys.readouterr().out
        assert "TELEGRAM_BOT_TOKEN" in out
        assert "docker compose up -d" in out

    async def test_no_redis_connection_is_attempted(self, monkeypatch):
        """Ohne Token darf der Worker gar nicht erst Redis anfassen."""
        touched = False

        class Boom:
            def __init__(self, *args, **kwargs):
                nonlocal touched
                touched = True

        monkeypatch.setattr("backend.telegram.__main__.RedisState", Boom)
        task = asyncio.create_task(run())
        await asyncio.sleep(0.2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert touched is False
