"""Provider 2: Betfair Exchange (https://developer.betfair.com).

Echte, dokumentierte API. Verwendet werden ausschließlich offizielle
Endpunkte - kein Scraping, kein Login-Bypass:

* Login (Zertifikat): ``POST https://identitysso-cert.betfair.com/api/certlogin``
* Login (interaktiv):  ``POST https://identitysso.betfair.com/api/login``
* Keep-Alive:          ``POST https://identitysso.betfair.com/api/keepAlive``
* Betting JSON-RPC:    ``POST https://api.betfair.com/exchange/betting/json-rpc/v1``
  mit den Operationen ``SportsAPING/v1.0/listEvents``,
  ``listMarketCatalogue`` und ``listMarketBook``.

Eine Börse ist als Referenzquelle besonders wertvoll: die Preise enthalten
praktisch keine Marge und die verfügbaren Beträge sind ein echter
Liquiditätsindikator (``availableToBack[0].size``).

Genutzt wird der beste **Back**-Preis. Lay-Preise bleiben außen vor - sie sind
für Value-Erkennung gegen Buchmacher nicht vergleichbar.

**Grenzen:** Betfair liefert keine Spielminute und keine Tennis-Punktdetails
über diese Endpunkte; entsprechende Felder bleiben ``None``. Der Live-Status
kommt aus ``marketBook.inplay`` bzw. ``marketBook.status``.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime
from typing import Any

import httpx

from backend.core.logging import get_logger
from backend.core.normalization import normalize_selection, parse_line
from backend.models.domain import EventSnapshot, MarketKey, OddsQuote, now_ts
from backend.models.enums import EventStatus, MarketType, Period, Sport
from backend.providers.base import (
    OddsProvider,
    ProviderAuthError,
    ProviderError,
    ProviderRateLimited,
)

log = get_logger("provider.betfair")

BOOKMAKER_NAME = "betfair"

#: Betfair-Event-Type-IDs (offiziell dokumentiert).
EVENT_TYPE_SPORT: dict[str, Sport] = {"1": Sport.FOOTBALL, "2": Sport.TENNIS}

_OVER_UNDER_RE = re.compile(r"^OVER_UNDER_(\d+)$")


def map_market_type(code: str, sport: Sport) -> tuple[MarketType, float | None]:
    """Betfair-Marktcode auf interne Marktart abbilden.

    Unbekannte Codes werden als ``MarketType.OTHER`` durchgereicht statt
    geraten - so geht keine Information verloren und nichts wird erfunden.
    """
    code = (code or "").upper()
    if code == "MATCH_ODDS":
        return (
            (MarketType.MATCH_ODDS, None)
            if sport is Sport.FOOTBALL
            else (MarketType.MATCH_WINNER, None)
        )
    if (match := _OVER_UNDER_RE.match(code)) is not None:
        # OVER_UNDER_25 -> Linie 2.5, OVER_UNDER_105 -> 10.5
        digits = match.group(1)
        line = float(f"{digits[:-1]}.{digits[-1]}")
        return (
            (MarketType.OVER_UNDER, line)
            if sport is Sport.FOOTBALL
            else (MarketType.OVER_UNDER_GAMES, line)
        )
    return {
        "BOTH_TEAMS_TO_SCORE": (MarketType.BTTS, None),
        "DOUBLE_CHANCE": (MarketType.DOUBLE_CHANCE, None),
        "DRAW_NO_BET": (MarketType.DRAW_NO_BET, None),
        "ASIAN_HANDICAP": (MarketType.ASIAN_HANDICAP, None),
        "HANDICAP": (MarketType.HANDICAP, None),
        "CORRECT_SCORE": (MarketType.CORRECT_SCORE, None),
        "SET_WINNER": (MarketType.SET_WINNER, None),
    }.get(code, (MarketType.OTHER, None))


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class BetfairExchangeProvider(OddsProvider):
    """JSON-RPC-Adapter mit Session-Handling und Keep-Alive."""

    name = "betfair"
    supports_streaming = False
    sports = ("football", "tennis")

    def __init__(
        self,
        *,
        app_key: str,
        username: str = "",
        password: str = "",
        cert_file: str = "",
        key_file: str = "",
        identity_url: str = "https://identitysso-cert.betfair.com/api/certlogin",
        keepalive_url: str = "https://identitysso.betfair.com/api/keepAlive",
        api_url: str = "https://api.betfair.com/exchange/betting/json-rpc/v1",
        event_type_ids: list[str] | None = None,
        market_types: list[str] | None = None,
        poll_interval: float = 1.0,
        catalogue_interval: float = 60.0,
        keepalive_interval: float = 600.0,
        max_markets_per_request: int = 40,
        max_catalogue_results: int = 100,
        inplay_only: bool = False,
        timeout: float = 8.0,
    ) -> None:
        super().__init__()
        if not app_key:
            raise ProviderAuthError("BETFAIR_APP_KEY fehlt")
        if not username or not password:
            raise ProviderAuthError("BETFAIR_USERNAME/BETFAIR_PASSWORD fehlen")
        self._app_key = app_key
        self._username = username
        self._password = password
        self._cert = (cert_file, key_file) if cert_file and key_file else None
        self.identity_url = identity_url
        self.keepalive_url = keepalive_url
        self.api_url = api_url
        self.event_type_ids = event_type_ids or ["1", "2"]
        self.market_types = market_types or ["MATCH_ODDS"]
        self.poll_interval = poll_interval
        self.catalogue_interval = catalogue_interval
        self.keepalive_interval = keepalive_interval
        self.max_markets_per_request = max(1, min(40, max_markets_per_request))
        self.max_catalogue_results = max_catalogue_results
        self.inplay_only = inplay_only
        self.timeout = timeout

        self._session_token: str = ""
        self._client: httpx.AsyncClient | None = None
        self._catalogue: dict[str, dict[str, Any]] = {}
        self._runners: dict[str, dict[int, str]] = {}
        self._events: dict[str, EventSnapshot] = {}
        self._next_catalogue: float = 0.0
        self._next_keepalive: float = 0.0
        self._rpc_id = 0
        self._cache_ts = 0.0
        self._cached_events: list[EventSnapshot] = []
        self._cached_quotes: list[OddsQuote] = []
        self._fetch_lock = asyncio.Lock()

    # ------------------------------------------------------------ Lifecycle
    async def connect(self) -> None:
        self.reset_stop()
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout),
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                cert=self._cert,
                headers={"accept": "application/json", "user-agent": "storm-odds-sniper/1.0"},
            )
        await self._login()
        await self._refresh_catalogue(force=True)
        self.mark_connected(f"{len(self._catalogue)} Märkte")
        log.info("betfair verbunden", markets=len(self._catalogue))

    async def disconnect(self) -> None:
        self.request_stop()
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self._session_token = ""
        self.mark_disconnected("geschlossen")

    # ---------------------------------------------------------------- Login
    async def _login(self) -> None:
        assert self._client is not None
        payload = {"username": self._username, "password": self._password}
        headers = {
            "X-Application": self._app_key,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        }
        try:
            response = await self._client.post(self.identity_url, data=payload, headers=headers)
        except httpx.HTTPError as exc:
            raise ProviderError(f"Betfair-Login nicht erreichbar: {exc}") from exc
        if response.status_code >= 400:
            raise ProviderAuthError(f"Betfair-Login fehlgeschlagen: HTTP {response.status_code}")
        data = response.json()
        # certlogin -> {"sessionToken": ..., "loginStatus": "SUCCESS"}
        # interaktiv -> {"token": ..., "status": "SUCCESS", "error": ""}
        token = data.get("sessionToken") or data.get("token") or ""
        status = data.get("loginStatus") or data.get("status") or ""
        if not token or status != "SUCCESS":
            raise ProviderAuthError(f"Betfair-Login abgelehnt: {status or 'unbekannt'}")
        self._session_token = token
        self._next_keepalive = now_ts() + self.keepalive_interval
        log.info("betfair-session erstellt")

    async def _keepalive(self) -> None:
        if not self._session_token or now_ts() < self._next_keepalive:
            return
        assert self._client is not None
        try:
            response = await self._client.post(
                self.keepalive_url,
                headers={
                    "X-Application": self._app_key,
                    "X-Authentication": self._session_token,
                    "Accept": "application/json",
                },
            )
            if response.status_code == 200 and response.json().get("status") == "SUCCESS":
                self._next_keepalive = now_ts() + self.keepalive_interval
                return
        except httpx.HTTPError as exc:
            log.warning("keep-alive fehlgeschlagen", error=str(exc))
        await self._login()

    # -------------------------------------------------------------- JSON-RPC
    async def _rpc(self, method: str, params: dict[str, Any]) -> Any:
        if self._client is None:
            raise ProviderError("Client nicht verbunden")
        if not self._session_token:
            await self._login()
        self._rpc_id += 1
        body = {
            "jsonrpc": "2.0",
            "method": f"SportsAPING/v1.0/{method}",
            "params": params,
            "id": self._rpc_id,
        }
        headers = {
            "X-Application": self._app_key,
            "X-Authentication": self._session_token,
            "Content-Type": "application/json",
        }
        try:
            response = await self._client.post(self.api_url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise ProviderError(f"Betfair nicht erreichbar: {exc}") from exc
        if response.status_code == 429:
            raise ProviderRateLimited("Betfair: zu viele Anfragen (429)")
        if response.status_code >= 400:
            raise ProviderError(f"Betfair: HTTP {response.status_code} bei {method}")

        data = response.json()
        if isinstance(data, dict) and "error" in data:
            detail = data["error"]
            code = ""
            if isinstance(detail, dict):
                code = str(
                    detail.get("data", {}).get("APINGException", {}).get("errorCode", "")
                ) or str(detail.get("code", ""))
            if "INVALID_SESSION" in code or "NO_SESSION" in code:
                self._session_token = ""
                raise ProviderAuthError(f"Betfair-Session ungültig ({code})")
            if "TOO_MUCH_DATA" in code or "REQUEST_SIZE_EXCEEDS_LIMIT" in code:
                raise ProviderError(f"Betfair: Anfrage zu groß ({code})")
            raise ProviderError(f"Betfair-Fehler bei {method}: {code or detail}")
        return data.get("result") if isinstance(data, dict) else None

    # ------------------------------------------------------------- Katalog
    async def _refresh_catalogue(self, *, force: bool = False) -> None:
        """Marktkatalog holen (Namen, Startzeit, Runner) - selten nötig."""
        if not force and now_ts() < self._next_catalogue:
            return
        self._next_catalogue = now_ts() + self.catalogue_interval

        market_filter: dict[str, Any] = {
            "eventTypeIds": self.event_type_ids,
            "marketTypeCodes": self.market_types,
        }
        if self.inplay_only:
            market_filter["inPlayOnly"] = True

        result = await self._rpc(
            "listMarketCatalogue",
            {
                "filter": market_filter,
                "maxResults": self.max_catalogue_results,
                "sort": "MAXIMUM_TRADED",
                "marketProjection": [
                    "EVENT",
                    "EVENT_TYPE",
                    "COMPETITION",
                    "MARKET_START_TIME",
                    "MARKET_DESCRIPTION",
                    "RUNNER_DESCRIPTION",
                ],
            },
        )
        if not isinstance(result, list):
            return
        catalogue: dict[str, dict[str, Any]] = {}
        runners: dict[str, dict[int, str]] = {}
        for entry in result:
            market_id = entry.get("marketId")
            if not market_id:
                continue
            catalogue[market_id] = entry
            runners[market_id] = {
                int(r["selectionId"]): str(r.get("runnerName", ""))
                for r in entry.get("runners", []) or []
                if r.get("selectionId") is not None
            }
        self._catalogue = catalogue
        self._runners = runners
        log.debug("betfair-katalog aktualisiert", markets=len(catalogue))

    # ------------------------------------------------------------ MarketBook
    async def _fetch_books(self) -> list[dict[str, Any]]:
        market_ids = list(self._catalogue.keys())
        books: list[dict[str, Any]] = []
        for start in range(0, len(market_ids), self.max_markets_per_request):
            chunk = market_ids[start : start + self.max_markets_per_request]
            result = await self._rpc(
                "listMarketBook",
                {
                    "marketIds": chunk,
                    "priceProjection": {
                        "priceData": ["EX_BEST_OFFERS"],
                        "virtualise": True,
                    },
                    "orderProjection": "ALL",
                },
            )
            if isinstance(result, list):
                books.extend(result)
            await asyncio.sleep(0)
        return books

    # --------------------------------------------------------------- Mapping
    def _sport_for(self, entry: dict[str, Any]) -> Sport | None:
        event_type_id = str((entry.get("eventType") or {}).get("id", ""))
        return EVENT_TYPE_SPORT.get(event_type_id)

    def _snapshot_for(self, entry: dict[str, Any], book: dict[str, Any]) -> EventSnapshot | None:
        sport = self._sport_for(entry)
        event = entry.get("event") or {}
        name = str(event.get("name", ""))
        if sport is None or " v " not in name.lower().replace(" vs ", " v "):
            return None
        normalized = name.replace(" vs ", " v ").replace(" V ", " v ")
        home, _, away = normalized.partition(" v ")
        home, away = home.strip(), away.strip()
        if not home or not away:
            return None

        status = EventStatus.PRE_MATCH
        if str(book.get("status", "")).upper() == "SUSPENDED":
            status = EventStatus.SUSPENDED
        elif str(book.get("status", "")).upper() == "CLOSED":
            status = EventStatus.FINISHED
        elif book.get("inplay") is True:
            status = EventStatus.LIVE

        return EventSnapshot(
            event_id="",
            sport=sport,
            home=home,
            away=away,
            provider=self.name,
            provider_event_id=str(event.get("id") or entry.get("marketId")),
            league=(entry.get("competition") or {}).get("name"),
            start_time=_parse_iso(event.get("openDate") or entry.get("marketStartTime")),
            status=status,
            # Minute/Karten/Punkte liefert die Betting-API nicht -> None.
            score=None,
            football=None,
            tennis=None,
        )

    def _quotes_for(
        self, entry: dict[str, Any], book: dict[str, Any], snapshot: EventSnapshot
    ) -> list[OddsQuote]:
        market_id = str(book.get("marketId") or entry.get("marketId"))
        code = str((entry.get("description") or {}).get("marketType") or "")
        if not code:
            code = str(entry.get("marketName", "")).upper().replace(" ", "_")
        market_type, line = map_market_type(code, snapshot.sport)
        period = Period.FULL_TIME if snapshot.sport is Sport.FOOTBALL else Period.MATCH
        runner_names = self._runners.get(market_id, {})
        suspended = str(book.get("status", "")).upper() != "OPEN"
        now = now_ts()
        published = book.get("lastMatchTime")
        ts = _parse_iso(published).timestamp() if _parse_iso(published) else now

        quotes: list[OddsQuote] = []
        for runner in book.get("runners", []) or []:
            selection_id = runner.get("selectionId")
            if selection_id is None:
                continue
            offers = (runner.get("ex") or {}).get("availableToBack") or []
            if not offers:
                continue
            best = offers[0]
            price = best.get("price")
            size = best.get("size")
            if not isinstance(price, (int, float)) or price <= 1.0:
                continue

            handicap = parse_line(runner.get("handicap"))
            market_line = line
            if market_type in (
                MarketType.ASIAN_HANDICAP,
                MarketType.HANDICAP,
                MarketType.GAME_HANDICAP,
                MarketType.SET_HANDICAP,
            ):
                market_line = handicap if handicap else line

            raw_name = runner_names.get(int(selection_id), str(selection_id))
            selection = normalize_selection(
                raw_name,
                sport=snapshot.sport,
                home=snapshot.home,
                away=snapshot.away,
                market_type=market_type,
            )
            quotes.append(
                OddsQuote(
                    event_id=snapshot.provider_event_id,
                    market=MarketKey(type=market_type, line=market_line, period=period),
                    selection=selection,
                    bookmaker=BOOKMAKER_NAME,
                    price=float(price),
                    provider=self.name,
                    ts=ts,
                    received_at=now,
                    suspended=suspended or str(runner.get("status", "")).upper() != "ACTIVE",
                    liquidity=float(size) if isinstance(size, (int, float)) else None,
                    is_exchange=True,
                )
            )
        return quotes

    # ---------------------------------------------------------------- Daten
    async def _fetch_all(self) -> tuple[list[EventSnapshot], list[OddsQuote]]:
        async with self._fetch_lock:
            if now_ts() - self._cache_ts < self.poll_interval * 0.5:
                return self._cached_events, self._cached_quotes
            await self._keepalive()
            await self._refresh_catalogue()
            books = await self._fetch_books()

            events: list[EventSnapshot] = []
            quotes: list[OddsQuote] = []
            for book in books:
                entry = self._catalogue.get(str(book.get("marketId")))
                if entry is None:
                    continue
                snapshot = self._snapshot_for(entry, book)
                if snapshot is None:
                    continue
                self._events[snapshot.provider_event_id] = snapshot
                events.append(snapshot)
                quotes.extend(self._quotes_for(entry, book, snapshot))

            self._cache_ts = now_ts()
            self._cached_events, self._cached_quotes = events, quotes
            return events, quotes

    async def get_events(self) -> list[EventSnapshot]:
        events, _ = await self._fetch_all()
        return events or list(self._events.values())

    async def get_odds(self) -> list[OddsQuote]:
        _, quotes = await self._fetch_all()
        return quotes
