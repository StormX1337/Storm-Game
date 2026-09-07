"""Provider 1: The Odds API (https://the-odds-api.com).

Echte, dokumentierte REST-API mit kostenlosem Einstiegskontingent. Endpunkte
(Version v4, Stand der Implementierung):

* ``GET /v4/sports`` - verfügbare Sport-Keys
* ``GET /v4/sports/{sport}/odds`` - Quoten mehrerer Buchmacher je Event
* ``GET /v4/sports/{sport}/scores`` - Spielstände inkl. Live-Kennzeichnung

Kontingent: jede Quotenabfrage kostet ``Anzahl Märkte x Anzahl Regionen``
Credits; der Restwert steht im Antwort-Header ``x-requests-remaining``. Der
Adapter pausiert selbstständig, bevor das Kontingent aufgebraucht ist.

**Grenzen der Quelle (nicht umgehbar, deshalb dokumentiert):**

* Kein WebSocket/Streaming - nur HTTP-Polling.
* Keine Spielminute, keine Karten, keine Tennis-Game-/Punktdetails. Diese
  Felder bleiben ``None`` und werden **nicht** geschätzt.
* Der Live-Status wird aus ``commence_time`` und dem ``scores``-Endpunkt
  abgeleitet.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

import httpx

from backend.core.logging import get_logger
from backend.core.normalization import normalize_bookmaker, normalize_selection, parse_line
from backend.models.domain import (
    EventSnapshot,
    MarketKey,
    OddsQuote,
    Score,
    now_ts,
)
from backend.models.enums import EventStatus, MarketType, Period, Sport
from backend.providers.base import (
    OddsProvider,
    ProviderAuthError,
    ProviderError,
    ProviderRateLimited,
)

log = get_logger("provider.the_odds_api")

#: Sport-Key-Präfixe der API -> interne Sportart.
_SPORT_PREFIX: dict[str, Sport] = {"soccer": Sport.FOOTBALL, "tennis": Sport.TENNIS}

#: Marktschlüssel der API -> interne Marktart (je Sportart).
_MARKET_MAP: dict[tuple[Sport, str], MarketType] = {
    (Sport.FOOTBALL, "h2h"): MarketType.MATCH_ODDS,
    (Sport.FOOTBALL, "spreads"): MarketType.ASIAN_HANDICAP,
    (Sport.FOOTBALL, "totals"): MarketType.OVER_UNDER,
    (Sport.FOOTBALL, "btts"): MarketType.BTTS,
    (Sport.FOOTBALL, "draw_no_bet"): MarketType.DRAW_NO_BET,
    (Sport.FOOTBALL, "double_chance"): MarketType.DOUBLE_CHANCE,
    (Sport.TENNIS, "h2h"): MarketType.MATCH_WINNER,
    (Sport.TENNIS, "spreads"): MarketType.GAME_HANDICAP,
    (Sport.TENNIS, "totals"): MarketType.OVER_UNDER_GAMES,
}

#: Marktschlüssel mit Halbzeit-Bezug (falls im Tarif enthalten).
_PERIOD_SUFFIX: dict[str, Period] = {"_h1": Period.FIRST_HALF, "_h2": Period.SECOND_HALF}


def sport_from_key(sport_key: str) -> Sport | None:
    prefix = sport_key.split("_", 1)[0]
    return _SPORT_PREFIX.get(prefix)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class TheOddsApiProvider(OddsProvider):
    """HTTP-Polling-Adapter mit Connection-Pooling und Quota-Schutz."""

    name = "the_odds_api"
    supports_streaming = False
    sports = ("football", "tennis")

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.the-odds-api.com/v4",
        sport_keys: list[str] | None = None,
        regions: str = "eu,uk",
        markets: list[str] | None = None,
        odds_format: str = "decimal",
        poll_interval: float = 20.0,
        use_scores: bool = True,
        scores_interval: float = 30.0,
        min_remaining: int = 5,
        timeout: float = 10.0,
    ) -> None:
        super().__init__()
        if not api_key:
            raise ProviderAuthError("ODDS_API_KEY fehlt")
        self._api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.sport_keys = sport_keys or []
        self.regions = regions
        self.markets = markets or ["h2h", "spreads", "totals"]
        self.odds_format = odds_format
        self.poll_interval = poll_interval
        self.use_scores = use_scores
        self.scores_interval = scores_interval
        self.min_remaining = min_remaining
        self.timeout = timeout

        self._client: httpx.AsyncClient | None = None
        self._events: dict[str, EventSnapshot] = {}
        self._scores_cache: dict[str, dict[str, Any]] = {}
        self._next_scores_poll: float = 0.0
        self._paused_until: float = 0.0
        # Ein Abruf bedient sowohl get_events() als auch get_odds(); ohne diesen
        # Cache würde die Basis-stream()-Implementierung das Kontingent doppelt
        # verbrauchen.
        self._cache_ts: float = 0.0
        self._cached_events: list[EventSnapshot] = []
        self._cached_quotes: list[OddsQuote] = []
        self._fetch_lock = asyncio.Lock()

    # ------------------------------------------------------------ Lifecycle
    async def connect(self) -> None:
        self.reset_stop()
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=httpx.Timeout(self.timeout),
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                headers={"accept": "application/json", "user-agent": "storm-odds-sniper/1.0"},
                follow_redirects=True,
            )
        if not self.sport_keys:
            self.sport_keys = await self._discover_sports()
        self.mark_connected(f"{len(self.sport_keys)} Sport-Keys")
        log.info("the odds api verbunden", sports=len(self.sport_keys), markets=self.markets)

    async def disconnect(self) -> None:
        self.request_stop()
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self.mark_disconnected("geschlossen")

    # ------------------------------------------------------------- HTTP
    async def _get(self, path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        if self._client is None:
            raise ProviderError("Client nicht verbunden")
        params = {**params, "apiKey": self._api_key}
        response = await self._client.get(path, params=params)

        remaining = response.headers.get("x-requests-remaining")
        if remaining is not None:
            try:
                self.health.rate_limit_remaining = int(float(remaining))
            except ValueError:
                pass

        if response.status_code == 401:
            raise ProviderAuthError("The Odds API: API-Key ungültig (401)")
        if response.status_code == 429:
            retry_after = response.headers.get("retry-after")
            raise ProviderRateLimited(
                "The Odds API: Rate-Limit erreicht (429)",
                retry_after=float(retry_after) if retry_after else None,
            )
        if response.status_code >= 400:
            raise ProviderError(f"The Odds API: HTTP {response.status_code}")

        data = response.json()
        return data if isinstance(data, list) else []

    async def _discover_sports(self) -> list[str]:
        try:
            sports = await self._get("/sports", {"all": "false"})
        except ProviderError as exc:
            log.warning("sport-discovery fehlgeschlagen", error=str(exc))
            return []
        keys = [
            item["key"]
            for item in sports
            if isinstance(item, dict) and sport_from_key(item.get("key", "")) is not None
        ]
        return keys[:12]  # Kontingent schonen

    # ------------------------------------------------------------- Mapping
    def _market_key(self, sport: Sport, raw_market: str, line: float | None) -> MarketKey | None:
        period = Period.FULL_TIME if sport is Sport.FOOTBALL else Period.MATCH
        base = raw_market
        for suffix, mapped_period in _PERIOD_SUFFIX.items():
            if raw_market.endswith(suffix):
                base = raw_market[: -len(suffix)]
                period = mapped_period
                break
        market_type = _MARKET_MAP.get((sport, base))
        if market_type is None:
            return None
        return MarketKey(type=market_type, line=line, period=period)

    def _parse_event(self, raw: dict[str, Any]) -> tuple[EventSnapshot, list[OddsQuote]] | None:
        sport = sport_from_key(raw.get("sport_key", ""))
        if sport is None:
            return None
        home = raw.get("home_team") or ""
        away = raw.get("away_team") or ""
        if not home or not away:
            return None

        start = _parse_iso(raw.get("commence_time"))
        provider_event_id = str(raw.get("id", ""))
        status, score = self._status_for(provider_event_id, start)

        snapshot = EventSnapshot(
            event_id="",
            sport=sport,
            home=home,
            away=away,
            provider=self.name,
            provider_event_id=provider_event_id,
            league=raw.get("sport_title"),
            start_time=start,
            status=status,
            score=score,
            # Minute, Karten, Games/Punkte liefert diese Quelle nicht -> None.
            football=None,
            tennis=None,
        )

        quotes: list[OddsQuote] = []
        now = now_ts()
        for bookmaker in raw.get("bookmakers", []) or []:
            book_name = normalize_bookmaker(bookmaker.get("key") or bookmaker.get("title") or "")
            book_ts = _parse_iso(bookmaker.get("last_update"))
            for market in bookmaker.get("markets", []) or []:
                market_raw = market.get("key", "")
                market_ts = _parse_iso(market.get("last_update")) or book_ts
                outcomes = market.get("outcomes", []) or []
                line = self._line_for(outcomes, home)
                market_key = self._market_key(sport, market_raw, line)
                if market_key is None:
                    continue
                for outcome in outcomes:
                    price = outcome.get("price")
                    if not isinstance(price, (int, float)) or price <= 1.0:
                        continue
                    selection = normalize_selection(
                        str(outcome.get("name", "")),
                        sport=sport,
                        home=home,
                        away=away,
                        market_type=market_key.type,
                    )
                    quotes.append(
                        OddsQuote(
                            event_id=provider_event_id,
                            market=market_key,
                            selection=selection,
                            bookmaker=book_name,
                            price=float(price),
                            provider=self.name,
                            ts=market_ts.timestamp() if market_ts else now,
                            received_at=now,
                            suspended=False,
                        )
                    )
        return snapshot, quotes

    @staticmethod
    def _line_for(outcomes: list[dict[str, Any]], home: str) -> float | None:
        """Gemeinsame Marktlinie bestimmen.

        Bei ``spreads`` trägt jede Selektion ihren eigenen Punktwert (Heim
        -0.5, Auswärts +0.5). Als Marktschlüssel gilt der Heimwert, damit beide
        Seiten in dasselbe Buch fallen.
        """
        home_point = None
        any_point = None
        for outcome in outcomes:
            point = parse_line(outcome.get("point"))
            if point is None:
                continue
            any_point = point if any_point is None else any_point
            if str(outcome.get("name", "")).strip() == home.strip():
                home_point = point
        return home_point if home_point is not None else any_point

    def _status_for(
        self, provider_event_id: str, start: datetime | None
    ) -> tuple[EventStatus, Score | None]:
        cached = self._scores_cache.get(provider_event_id)
        score: Score | None = None
        if cached:
            score = _score_from_payload(cached)
            if cached.get("completed") is True:
                return EventStatus.FINISHED, score
        if start is None:
            return EventStatus.UNKNOWN, score
        now = datetime.now(UTC)
        if start > now:
            return EventStatus.PRE_MATCH, score
        return EventStatus.LIVE, score

    # ---------------------------------------------------------------- Daten
    async def _refresh_scores(self) -> None:
        if not self.use_scores or now_ts() < self._next_scores_poll:
            return
        self._next_scores_poll = now_ts() + self.scores_interval
        for sport_key in self.sport_keys:
            try:
                rows = await self._get(f"/sports/{sport_key}/scores", {"daysFrom": 1})
            except ProviderRateLimited:
                raise
            except ProviderError as exc:
                log.warning("scores-abruf fehlgeschlagen", sport=sport_key, error=str(exc))
                continue
            for row in rows:
                if isinstance(row, dict) and row.get("id"):
                    self._scores_cache[str(row["id"])] = row

    async def _fetch_all(self) -> tuple[list[EventSnapshot], list[OddsQuote]]:
        """Ein HTTP-Durchlauf über alle Sport-Keys, durch einen Cache entkoppelt."""
        async with self._fetch_lock:
            if now_ts() - self._cache_ts < self.poll_interval * 0.5:
                return self._cached_events, self._cached_quotes
            events, quotes = await self._fetch_uncached()
            self._cache_ts = now_ts()
            self._cached_events, self._cached_quotes = events, quotes
            return events, quotes

    async def _fetch_uncached(self) -> tuple[list[EventSnapshot], list[OddsQuote]]:
        if now_ts() < self._paused_until:
            return [], []
        if (
            self.health.rate_limit_remaining is not None
            and self.health.rate_limit_remaining <= self.min_remaining
        ):
            self._paused_until = now_ts() + 3600
            self.mark_error(
                f"Kontingent fast aufgebraucht ({self.health.rate_limit_remaining}) - "
                "Abruf für 1h pausiert"
            )
            log.warning(
                "kontingent fast aufgebraucht - pausiere",
                remaining=self.health.rate_limit_remaining,
            )
            return [], []

        await self._refresh_scores()

        events: list[EventSnapshot] = []
        quotes: list[OddsQuote] = []
        for sport_key in self.sport_keys:
            params = {
                "regions": self.regions,
                "markets": ",".join(self.markets),
                "oddsFormat": self.odds_format,
                "dateFormat": "iso",
            }
            try:
                rows = await self._get(f"/sports/{sport_key}/odds", params)
            except ProviderRateLimited as exc:
                self._paused_until = now_ts() + (exc.retry_after or 60.0)
                raise
            for row in rows:
                parsed = self._parse_event(row)
                if parsed is None:
                    continue
                snapshot, event_quotes = parsed
                self._events[snapshot.provider_event_id] = snapshot
                events.append(snapshot)
                quotes.extend(event_quotes)
            await asyncio.sleep(0)  # anderen Tasks Luft lassen
        return events, quotes

    async def get_events(self) -> list[EventSnapshot]:
        events, _ = await self._fetch_all()
        return events or list(self._events.values())

    async def get_odds(self) -> list[OddsQuote]:
        _, quotes = await self._fetch_all()
        return quotes


def _score_from_payload(payload: dict[str, Any]) -> Score | None:
    """``scores`` der API in einen Spielstand übersetzen - ohne zu raten."""
    rows = payload.get("scores")
    if not isinstance(rows, list) or len(rows) < 2:
        return None
    home_name = payload.get("home_team")
    away_name = payload.get("away_team")
    values: dict[str, int] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            values[str(row.get("name"))] = int(row.get("score"))
        except (TypeError, ValueError):
            return None
    if home_name in values and away_name in values:
        return Score(home=values[home_name], away=values[away_name])
    return None
