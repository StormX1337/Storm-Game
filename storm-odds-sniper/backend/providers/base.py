"""Provider-Schnittstelle.

Jede Datenquelle wird als Adapter hinter dieser Schnittstelle gekapselt. Der
Scanner kennt nur ``OddsProvider`` - Quellen sind damit austauschbar.

Zwei Betriebsarten:

* **Push** (bevorzugt): der Adapter überschreibt :meth:`OddsProvider.stream`
  und schiebt Nachrichten, sobald die Quelle etwas sendet (WebSocket/Stream).
* **Pull**: der Adapter implementiert nur ``get_events``/``get_odds``; die
  Basisklasse pollt asynchron im ``poll_interval``-Takt.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from typing import Any

from backend.core.logging import get_logger
from backend.models.domain import EventSnapshot, OddsQuote, ProviderMessage, now_ts
from backend.models.enums import ProviderStatus

log = get_logger("provider")


# ----------------------------------------------------------------- Fehler


class ProviderError(RuntimeError):
    """Allgemeiner, wiederholbarer Providerfehler."""


class ProviderAuthError(ProviderError):
    """Zugangsdaten fehlen oder sind ungültig - Reconnect ist zwecklos."""


class ProviderRateLimited(ProviderError):
    """Rate-Limit erreicht. ``retry_after`` in Sekunden, falls bekannt."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


# ----------------------------------------------------------------- Health


@dataclass(slots=True)
class ProviderHealth:
    name: str
    status: ProviderStatus = ProviderStatus.DISCONNECTED
    connected_since: float | None = None
    last_message_at: float | None = None
    messages: int = 0
    quotes: int = 0
    errors: int = 0
    reconnects: int = 0
    detail: str = ""
    rate_limit_remaining: int | None = None
    latency_ms: float | None = None

    @property
    def seconds_since_message(self) -> float | None:
        if self.last_message_at is None:
            return None
        return now_ts() - self.last_message_at

    @property
    def healthy(self) -> bool:
        return self.status is ProviderStatus.CONNECTED

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = self.status.value
        data["seconds_since_message"] = self.seconds_since_message
        data["healthy"] = self.healthy
        return data


# --------------------------------------------------------------- Interface


class OddsProvider(ABC):
    """Basisklasse aller Datenquellen."""

    #: Eindeutiger Name (auch Redis-/DB-Schlüssel).
    name: str = "base"
    #: True, wenn der Adapter ``stream()`` selbst mit Push bedient.
    supports_streaming: bool = False
    #: Poll-Takt der Standard-``stream()``-Implementierung in Sekunden.
    #: Untergrenze - ``next_poll_delay()`` darf ihn nach oben anpassen.
    poll_interval: float = 5.0
    #: Sportarten, die dieser Adapter liefern kann (nur informativ).
    sports: tuple[str, ...] = ()

    def __init__(self) -> None:
        self.health = ProviderHealth(name=self.name)
        self._closing = asyncio.Event()

    # ------------------------------------------------------- Pflichtmethoden
    @abstractmethod
    async def connect(self) -> None:
        """Verbindung/Session aufbauen. Wirft ``ProviderAuthError`` bei fehlendem Key."""

    @abstractmethod
    async def disconnect(self) -> None:
        """Ressourcen sauber freigeben. Muss mehrfach aufrufbar sein."""

    @abstractmethod
    async def get_events(self) -> list[EventSnapshot]:
        """Aktuelle Events der Quelle."""

    @abstractmethod
    async def get_odds(self) -> list[OddsQuote]:
        """Aktuelle Quoten der Quelle.

        Vertrag: ``OddsQuote.event_id`` und ``EventSnapshot.provider_event_id``
        tragen die **providereigene** Event-ID. Der Scanner ersetzt sie durch
        die providerübergreifende, kanonische ID (siehe ``EventMatcher``).
        Adapter dürfen und sollen keine kanonischen IDs erzeugen.
        """

    # -------------------------------------------------------------- Stream
    def next_poll_delay(self) -> float:
        """Wartezeit bis zum nächsten Poll.

        Standard ist der feste ``poll_interval``. Adapter mit begrenztem
        Kontingent überschreiben das und drosseln sich selbst.
        """
        return self.poll_interval

    async def stream(self) -> AsyncIterator[ProviderMessage]:
        """Nachrichtenstrom des Providers.

        Standard: asynchrones Polling. Push-fähige Adapter überschreiben diese
        Methode und liefern Nachrichten ohne Wartezeit.
        """
        while not self._closing.is_set():
            started = now_ts()
            events = await self.get_events()
            quotes = await self.get_odds()
            self.mark_message(len(quotes))
            self.health.latency_ms = round((now_ts() - started) * 1000, 2)
            yield ProviderMessage(provider=self.name, events=events, quotes=quotes)

            # Poll-Takt abzüglich der bereits verbrauchten Zeit.
            elapsed = now_ts() - started
            try:
                await asyncio.wait_for(
                    self._closing.wait(), timeout=max(0.0, self.next_poll_delay() - elapsed)
                )
            except TimeoutError:
                continue

    # ------------------------------------------------------------ Steuerung
    def request_stop(self) -> None:
        self._closing.set()

    def reset_stop(self) -> None:
        self._closing = asyncio.Event()

    @property
    def stopping(self) -> bool:
        return self._closing.is_set()

    # --------------------------------------------------------------- Health
    def mark_connected(self, detail: str = "") -> None:
        self.health.status = ProviderStatus.CONNECTED
        self.health.connected_since = now_ts()
        self.health.detail = detail

    def mark_disconnected(self, detail: str = "") -> None:
        self.health.status = ProviderStatus.DISCONNECTED
        self.health.connected_since = None
        self.health.detail = detail

    def mark_message(self, quotes: int = 0) -> None:
        self.health.messages += 1
        self.health.quotes += quotes
        self.health.last_message_at = now_ts()

    def mark_paused(self, detail: str) -> None:
        """Gewollte Pause - zählt nicht als Fehler.

        Ein aufgebrauchtes Kontingent ist kein Defekt. Würde es als Fehler
        gezählt, stünde die Quelle rot im Dashboard und der Fehlerzähler
        liefe hoch, obwohl alles wie vorgesehen funktioniert.
        """
        self.health.status = ProviderStatus.PAUSED
        self.health.detail = detail

    def mark_error(self, detail: str) -> None:
        self.health.errors += 1
        self.health.status = ProviderStatus.ERROR
        self.health.detail = detail

    def mark_reconnect(self) -> None:
        self.health.reconnects += 1
        self.health.status = ProviderStatus.CONNECTING

    # ------------------------------------------------------------ Komfort
    async def __aenter__(self) -> OddsProvider:
        await self.connect()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.disconnect()

    def __repr__(self) -> str:  # pragma: no cover - Debug-Hilfe
        return f"<{type(self).__name__} name={self.name} status={self.health.status.value}>"


@dataclass(slots=True)
class ProviderSpec:
    """Beschreibt einen registrierbaren Provider für das Dashboard/README."""

    key: str
    title: str
    kind: str  # "mock" | "rest" | "stream"
    requires_credentials: bool
    docs_url: str = ""
    notes: str = ""
    missing: list[str] = field(default_factory=list)
