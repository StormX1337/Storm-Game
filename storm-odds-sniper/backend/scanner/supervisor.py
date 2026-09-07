"""Provider-Supervisor: hält eine Datenquelle dauerhaft am Leben.

Verantwortlich für Verbindung, Reconnect mit exponentiellem Backoff,
Rate-Limit-Beachtung und Health-Meldungen. Ein abstürzender Provider darf
niemals den Scanner mitreißen.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from backend.core.backoff import ExponentialBackoff
from backend.core.logging import get_logger
from backend.core.metrics import PROVIDER_ERRORS, PROVIDER_RECONNECTS, PROVIDER_UP, QUOTES_RECEIVED
from backend.models.domain import ProviderMessage
from backend.models.enums import ProviderStatus
from backend.providers.base import (
    OddsProvider,
    ProviderAuthError,
    ProviderRateLimited,
)

log = get_logger("scanner.supervisor")

Sink = Callable[[ProviderMessage], Awaitable[None]]


class ProviderSupervisor:
    """Ein Supervisor je Provider."""

    def __init__(
        self,
        provider: OddsProvider,
        sink: Sink,
        *,
        backoff_base: float = 0.5,
        backoff_cap: float = 60.0,
        stall_timeout: float = 120.0,
    ) -> None:
        self.provider = provider
        self.sink = sink
        self.backoff = ExponentialBackoff(base=backoff_base, cap=backoff_cap)
        self.stall_timeout = stall_timeout
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

    # ------------------------------------------------------------- Steuerung
    def start(self) -> asyncio.Task:
        self._stopped.clear()
        self._task = asyncio.create_task(self.run(), name=f"supervisor-{self.provider.name}")
        return self._task

    async def stop(self) -> None:
        self._stopped.set()
        self.provider.request_stop()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        try:
            await self.provider.disconnect()
        except Exception as exc:  # noqa: BLE001 - Shutdown darf nie werfen
            log.warning("disconnect fehlgeschlagen", provider=self.provider.name, error=str(exc))
        PROVIDER_UP.labels(self.provider.name).set(0)

    # ---------------------------------------------------------------- Schleife
    async def run(self) -> None:
        name = self.provider.name
        disabled_reason: str | None = None
        while not self._stopped.is_set():
            try:
                self.provider.health.status = ProviderStatus.CONNECTING
                await self.provider.connect()
                PROVIDER_UP.labels(name).set(1)
                self.backoff.reset()
                log.info("provider verbunden", provider=name)
                await self._consume()
            except asyncio.CancelledError:
                raise
            except ProviderAuthError as exc:
                # Zugangsdaten sind falsch/fehlen - Wiederholen bringt nichts.
                disabled_reason = str(exc)
                PROVIDER_ERRORS.labels(name).inc()
                PROVIDER_UP.labels(name).set(0)
                log.error("provider deaktiviert", provider=name, error=str(exc))
            except ProviderRateLimited as exc:
                PROVIDER_ERRORS.labels(name).inc()
                delay = exc.retry_after or self.backoff.next_delay()
                self.provider.mark_error(f"Rate-Limit: {exc}")
                log.warning("rate-limit - warte", provider=name, seconds=round(delay, 1))
                await self._sleep(delay)
            except Exception as exc:  # noqa: BLE001 - jeder Fehler führt zum Reconnect
                PROVIDER_ERRORS.labels(name).inc()
                PROVIDER_UP.labels(name).set(0)
                self.provider.mark_error(str(exc))
                delay = self.backoff.next_delay()
                log.warning(
                    "provider-fehler - reconnect",
                    provider=name,
                    error=str(exc),
                    retry_in=round(delay, 1),
                )
                await self._sleep(delay)
            finally:
                await self._safe_disconnect()

            if disabled_reason is not None:
                # Nach dem disconnect() setzen - sonst überschreibt
                # mark_disconnected() den Grund und das Dashboard zeigt
                # "getrennt" statt "deaktiviert: Key fehlt".
                self.provider.health.status = ProviderStatus.DISABLED
                self.provider.health.detail = disabled_reason
                return
            if self._stopped.is_set():
                break
            self.provider.mark_reconnect()
            PROVIDER_RECONNECTS.labels(name).inc()

    async def _consume(self) -> None:
        """Nachrichten des Providers weiterreichen und Stillstand erkennen."""
        name = self.provider.name
        stream = self.provider.stream()
        while not self._stopped.is_set():
            try:
                message = await asyncio.wait_for(stream.__anext__(), timeout=self.stall_timeout)
            except StopAsyncIteration:
                log.info("provider-stream beendet", provider=name)
                return
            except TimeoutError as exc:
                raise RuntimeError(
                    f"keine Daten seit {self.stall_timeout:.0f}s - Verbindung gilt als tot"
                ) from exc
            if message.is_empty:
                continue
            if message.quotes:
                QUOTES_RECEIVED.labels(name).inc(len(message.quotes))
            self.provider.health.status = ProviderStatus.CONNECTED
            await self.sink(message)

    async def _safe_disconnect(self) -> None:
        try:
            await self.provider.disconnect()
        except Exception as exc:  # noqa: BLE001 - Shutdown darf nie werfen
            log.debug("disconnect meldete Fehler", provider=self.provider.name, error=str(exc))

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stopped.wait(), timeout=seconds)
        except TimeoutError:
            return
