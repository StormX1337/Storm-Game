"""WebSocket-Verteiler fürs Dashboard.

Ein einziger Redis-Subscriber je API-Prozess verteilt an alle verbundenen
Clients. So skaliert die Anzahl der Browser-Tabs ohne zusätzliche
Redis-Verbindungen.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import orjson
from starlette.websockets import WebSocket, WebSocketState

from backend.core.logging import get_logger
from backend.core.metrics import WS_CLIENTS
from backend.services.redis_state import RedisState

log = get_logger("api.ws")


class WebSocketHub:
    def __init__(self, state: RedisState, *, max_clients: int = 200) -> None:
        self.state = state
        self.max_clients = max_clients
        self._clients: set[WebSocket] = set()
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    # ---------------------------------------------------------------- Clients
    async def connect(self, websocket: WebSocket) -> bool:
        if len(self._clients) >= self.max_clients:
            await websocket.close(code=1013, reason="Zu viele Verbindungen")
            return False
        await websocket.accept()
        async with self._lock:
            self._clients.add(websocket)
        WS_CLIENTS.set(len(self._clients))
        await self.send_to(websocket, "hello", {"clients": len(self._clients)})
        return True

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)
        WS_CLIENTS.set(len(self._clients))

    @property
    def client_count(self) -> int:
        return len(self._clients)

    # -------------------------------------------------------------- Versand
    async def send_to(self, websocket: WebSocket, kind: str, payload: dict[str, Any]) -> None:
        if websocket.client_state is not WebSocketState.CONNECTED:
            return
        with contextlib.suppress(Exception):
            await websocket.send_bytes(orjson.dumps({"type": kind, "payload": payload}))

    async def broadcast(self, kind: str, payload: dict[str, Any]) -> None:
        if not self._clients:
            return
        message = orjson.dumps({"type": kind, "payload": payload})
        dead: list[WebSocket] = []
        for client in list(self._clients):
            if client.client_state is not WebSocketState.CONNECTED:
                dead.append(client)
                continue
            try:
                await client.send_bytes(message)
            except Exception:  # noqa: BLE001 - toter Client wird entfernt
                dead.append(client)
        if dead:
            async with self._lock:
                for client in dead:
                    self._clients.discard(client)
            WS_CLIENTS.set(len(self._clients))

    # ------------------------------------------------------------- Pub/Sub
    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._pump(), name="ws-pump")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        for client in list(self._clients):
            with contextlib.suppress(Exception):
                await client.close()
        self._clients.clear()
        WS_CLIENTS.set(0)

    async def _pump(self) -> None:
        channels = (
            self.state.channel_alerts,
            self.state.channel_events,
            self.state.channel_odds,
        )
        mapping = {
            self.state.channel_alerts: "alert",
            self.state.channel_events: "event",
            self.state.channel_odds: "odds",
        }
        while True:
            try:
                async for channel, payload in self.state.subscribe(*channels):
                    await self.broadcast(mapping.get(channel, "event"), payload or {})
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - Pub/Sub neu aufbauen
                log.warning("ws-pump neu gestartet", error=str(exc))
                await asyncio.sleep(2.0)
