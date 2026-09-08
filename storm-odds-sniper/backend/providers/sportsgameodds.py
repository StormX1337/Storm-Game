"""SportsGameOdds-Adapter (https://sportsgameodds.com).

Warum diese Quelle: sie kennt einen echten **Live-Filter** (``live=true``) und
liefert je Markt die Preise aller Buchmacher in einem Aufruf. Damit ist sie die
erste hier eingebaute REST-Quelle, die für Live-Erkennung gedacht ist.

Das Schema stammt aus der offiziellen, aus der OpenAPI-Spezifikation
generierten SDK (``SportsGameOdds/sports-odds-api-python``), nicht aus
Vermutungen::

    GET https://api.sportsgameodds.com/v2/events
    Header: x-api-key: <KEY>

    {
      "data": [{
        "eventID": "...",
        "leagueID": "EPL", "sportID": "SOCCER",
        "teams": {"home": {"names": {"long": "..."}, "score": 1}, "away": {...}},
        "status": {"live": true, "started": true, "ended": false,
                   "startsAt": "2026-09-08T18:30:00Z", "currentPeriodID": "2h"},
        "odds": {
          "points-home-game-ml-home": {
            "oddID": "...", "statID": "points", "periodID": "game",
            "betTypeID": "ml", "sideID": "home",
            "byBookmaker": {"bet365": {"odds": "+150", "available": true}}
          }
        }
      }],
      "nextCursor": "..."
    }

``oddID`` ist zusammengesetzt aus ``{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}``.
Der Adapter liest die Bestandteile aus den **Einzelfeldern**, nicht aus dem
zusammengesetzten String - das ist robuster gegen Namen mit Bindestrich.

Bewusst nicht geraten: Märkte, deren ``betTypeID``/``sideID``/``periodID`` hier
nicht bekannt sind (etwa Spielerwetten), werden **übersprungen und gezählt**,
nicht auf gut Glück zugeordnet. Der Zähler steht in der Provider-Health.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from datetime import UTC, datetime
from typing import Any

import httpx

from backend.core.logging import get_logger
from backend.models.domain import (
    EventSnapshot,
    FootballState,
    MarketKey,
    OddsQuote,
    Score,
    Selection,
    TennisState,
    now_ts,
)
from backend.models.enums import (
    EventStatus,
    MarketType,
    Period,
    SelectionCode,
    Sport,
)
from backend.providers.base import (
    OddsProvider,
    ProviderAuthError,
    ProviderError,
    ProviderRateLimited,
)

log = get_logger("provider.sportsgameodds")

#: ``betTypeID`` -> Marktart. Nur belegte Werte; alles andere wird verworfen.
#: ``betTypeID`` -> interne Marktart.
#:
#: ``ml`` ist zweiweg, ``ml3way`` dreiweg. Beide dürfen im Fußball **nicht**
#: auf denselben Marktschlüssel zeigen: eine Zweiwegquote ist ohne die
#: Unentschieden-Möglichkeit systematisch kürzer als eine Dreiwegquote. Landen
#: sie im selben Buch, vergleicht die Engine Äpfel mit Birnen und meldet am
#: laufenden Band Fehlpreise, die keine sind.
BET_TYPES: dict[str, str] = {
    "ml": "moneyline",
    "ml3way": "moneyline3",
    "sp": "spread",
    "ou": "total",
    # "yn" (ja/nein) wird nur zugeordnet, wenn die statID den Markt selbst
    # benennt - siehe BTTS_STAT unten. "eo" (gerade/ungerade) ist kein Markt
    # dieses Projekts. Alles Übrige wird übersprungen und gezählt.
    "yn": "yesno",
}


def _is_btts(stat_id: str) -> bool:
    """Ist diese statID eindeutig "Beide Teams treffen"?

    Nicht geraten, sondern am selbstbeschreibenden Namen erkannt: nur wenn
    "bothteams" und "score" darin vorkommen. Schreibweise (camelCase,
    Unterstriche) spielt keine Rolle, andere Ja/Nein-Märkte fallen durch.
    """
    normalized = "".join(ch for ch in stat_id.lower() if ch.isalnum())
    return "bothteams" in normalized and "score" in normalized


#: ``periodID`` -> Abschnitt. Unbekannte Abschnitte werden übersprungen, damit
#: ein Viertel nicht versehentlich als Vollzeit gewertet wird.
PERIODS: dict[str, Period] = {
    "game": Period.FULL_TIME,
    "reg": Period.FULL_TIME,
    "match": Period.MATCH,
    "h1": Period.FIRST_HALF,
    "h2": Period.SECOND_HALF,
    "1h": Period.FIRST_HALF,
    "2h": Period.SECOND_HALF,
}

#: Satzabschnitte - nur für Tennis. Im Fußball gibt es keine Sätze, dort wäre
#: ein solcher Abschnitt ein Missverständnis und wird übersprungen.
TENNIS_PERIODS: dict[str, Period] = {
    "1s": Period.SET_1,
    "2s": Period.SET_2,
    "3s": Period.SET_3,
    "4s": Period.SET_4,
    "5s": Period.SET_5,
    "set1": Period.SET_1,
    "set2": Period.SET_2,
    "set3": Period.SET_3,
    "set4": Period.SET_4,
    "set5": Period.SET_5,
}

#: ``sideID`` -> Selektionscode.
SIDES: dict[str, SelectionCode] = {
    "home": SelectionCode.HOME,
    "away": SelectionCode.AWAY,
    "draw": SelectionCode.DRAW,
    "over": SelectionCode.OVER,
    "under": SelectionCode.UNDER,
    "yes": SelectionCode.YES,
    "no": SelectionCode.NO,
    # Doppelte Chance - in den echten Daten als kombinierte Seite geliefert.
    "home+draw": SelectionCode.HOME_OR_DRAW,
    "away+draw": SelectionCode.AWAY_OR_DRAW,
    "draw+home": SelectionCode.HOME_OR_DRAW,
    "draw+away": SelectionCode.AWAY_OR_DRAW,
    "home+away": SelectionCode.HOME_OR_AWAY,
    "away+home": SelectionCode.HOME_OR_AWAY,
}

#: Kombinierte Seiten bilden die Doppelte Chance - ein eigener Markt, nicht
#: eine Selektion des Dreiwegmarktes.
DOUBLE_CHANCE_SIDES = frozenset(
    {
        SelectionCode.HOME_OR_DRAW,
        SelectionCode.AWAY_OR_DRAW,
        SelectionCode.HOME_OR_AWAY,
    }
)

#: ``sportID`` -> unsere Sportart. Andere Sportarten sind nicht Teil dieses
#: Projekts und werden verworfen.
SPORTS: dict[str, Sport] = {"SOCCER": Sport.FOOTBALL, "TENNIS": Sport.TENNIS}

#: Plausibles Quotenband. Alles außerhalb deutet auf ein falsch verstandenes
#: Format hin - dann wird verworfen statt einen Fantasiepreis einzuspeisen.
MIN_DECIMAL_ODDS = 1.01
MAX_DECIMAL_ODDS = 1000.0


def american_to_decimal(raw: str | float | None) -> float | None:
    """Amerikanische oder dezimale Quote als Dezimalquote.

    Die API liefert Strings wie ``"-110"`` oder ``"+150"`` (amerikanisch). Ein
    Wert mit Vorzeichen ist eindeutig amerikanisch; ein Wert mit Nachkommastelle
    unter 100 ist eindeutig dezimal. Alles andere wird verworfen, statt es zu
    raten - eine falsch umgerechnete Quote erzeugt Fehlalarme, und das ist
    schlimmer als eine fehlende Quote.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None

    signed = text[0] in "+-"
    try:
        value = float(text)
    except ValueError:
        return None
    if value == 0:
        return None

    if signed:
        decimal = 1.0 + (value / 100.0 if value > 0 else 100.0 / abs(value))
    elif "." in text and value < 100.0:
        decimal = value  # bereits dezimal
    elif value >= 100.0:
        decimal = 1.0 + value / 100.0  # amerikanisch ohne Pluszeichen
    else:
        return None

    if not (MIN_DECIMAL_ODDS <= decimal <= MAX_DECIMAL_ODDS):
        return None
    return round(decimal, 4)


def _to_float(raw: Any) -> float | None:
    if raw is None:
        return None
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError):
        return None


class SportsGameOddsProvider(OddsProvider):
    """REST-Adapter mit Live-Filter, Cursor-Pagination und Kontingentschutz."""

    name = "sportsgameodds"
    supports_streaming = False
    sports = ("football", "tennis")

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.sportsgameodds.com/v2",
        leagues: str = "",
        sport_ids: str = "SOCCER,TENNIS",
        live_only: bool = False,
        poll_interval: float = 20.0,
        max_pages: int = 3,
        page_limit: int = 50,
        bookmakers: str = "",
        rate_limit_per_minute: int = 300,
        timeout: float = 12.0,
    ) -> None:
        super().__init__()
        if not api_key:
            raise ProviderAuthError("SGO_API_KEY fehlt")
        self._api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.leagues = leagues
        self.sport_ids = sport_ids
        self.live_only = live_only
        self.poll_interval = poll_interval
        self.max_pages = max(1, max_pages)
        self.page_limit = max(1, min(page_limit, 100))
        self.bookmakers = bookmakers
        self.rate_limit_per_minute = max(0, rate_limit_per_minute)
        self.timeout = timeout

        self._client: httpx.AsyncClient | None = None
        #: Ein Abruf bedient get_events() und get_odds() - sonst kostet die
        #: Basis-stream()-Implementierung das Kontingent doppelt.
        self._cache_ts: float = 0.0
        self._cached_events: list[EventSnapshot] = []
        self._cached_quotes: list[OddsQuote] = []
        self._fetch_lock = asyncio.Lock()
        #: Was verworfen wurde und warum. Sichtbar statt still verschluckt.
        self.skipped: Counter[str] = Counter()
        #: Je Grund ein Beispielmarkt - macht unbekannte Marktarten zuordenbar.
        self.skipped_samples: dict[str, dict[str, str]] = {}
        #: Rohantwort der letzten Seite - nur für die Einrichtungshilfe, damit
        #: sich das Quotenformat gegen die Anzeige des Buchmachers prüfen lässt.
        self.last_raw_events: list[dict[str, Any]] = []

    def _skip(self, reason: str, market: dict[str, Any]) -> None:
        """Übersprungenen Markt zählen und ein Beispiel merken.

        Der Zähler allein sagt nur *dass* etwas fehlt. Erst ``statID`` und
        ``marketName`` verraten, **welcher** Markt sich dahinter verbirgt -
        ohne sie lässt sich eine neue Marktart nicht zuordnen, ohne zu raten.
        """
        self.skipped[reason] += 1
        if reason not in self.skipped_samples:
            self.skipped_samples[reason] = {
                "statID": str(market.get("statID") or ""),
                "periodID": str(market.get("periodID") or ""),
                "betTypeID": str(market.get("betTypeID") or ""),
                "sideID": str(market.get("sideID") or ""),
                "marketName": str(market.get("marketName") or ""),
            }

    # ------------------------------------------------------- Drosselung
    def requests_per_cycle(self) -> int:
        """Anfragen je Durchlauf - eine je Seite."""
        return self.max_pages

    def next_poll_delay(self) -> float:
        """Poll-Takt, der das Anfragelimit des Tarifs einhält.

        Ein Durchlauf kostet ``max_pages`` Anfragen. Damit die pro Minute
        erlaubte Zahl nicht überschritten wird, darf ein Durchlauf nicht
        häufiger als ``60 * seiten / limit`` Sekunden starten. Ohne diese
        Rechnung genügt ein beherzt gesetztes SGO_POLL_INTERVAL, um sich
        selbst in 429er zu schicken.
        """
        if self.rate_limit_per_minute <= 0:
            return self.poll_interval
        floor = 60.0 * self.requests_per_cycle() / self.rate_limit_per_minute
        return max(self.poll_interval, floor)

    # ------------------------------------------------------------ Lifecycle
    async def connect(self) -> None:
        self.reset_stop()
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=httpx.Timeout(self.timeout),
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
                headers={
                    "accept": "application/json",
                    "user-agent": "storm-odds-sniper/1.0",
                    "x-api-key": self._api_key,
                },
                follow_redirects=True,
            )
        self.mark_connected("live" if self.live_only else "pre-match + live")
        log.info(
            "sportsgameodds verbunden",
            leagues=self.leagues or "(alle)",
            sports=self.sport_ids,
            live_only=self.live_only,
            poll_takt_s=round(self.next_poll_delay(), 2),
            anfragen_pro_minute=round(
                60.0 / max(0.001, self.next_poll_delay()) * self.requests_per_cycle(), 1
            ),
        )

    async def disconnect(self) -> None:
        self.request_stop()
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self.mark_disconnected("geschlossen")

    # ---------------------------------------------------------------- HTTP
    async def _get(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._client is None:
            raise ProviderError("Client nicht verbunden")
        try:
            response = await self._client.get("/events", params=params)
        except httpx.HTTPError as exc:
            raise ProviderError(f"SportsGameOdds nicht erreichbar: {exc}") from exc

        for header in ("x-ratelimit-remaining-month", "x-ratelimit-remaining"):
            value = response.headers.get(header)
            if value is not None:
                try:
                    self.health.rate_limit_remaining = int(float(value))
                except ValueError:
                    pass
                break

        if response.status_code in (401, 403):
            raise ProviderAuthError(
                f"SportsGameOdds: API-Key abgelehnt (HTTP {response.status_code})"
            )
        if response.status_code == 429:
            retry_after = response.headers.get("retry-after")
            raise ProviderRateLimited(
                "SportsGameOdds: Rate-Limit erreicht (429)",
                retry_after=float(retry_after) if retry_after else None,
            )
        if response.status_code >= 400:
            raise ProviderError(f"SportsGameOdds: HTTP {response.status_code}")

        payload = response.json()
        if not isinstance(payload, dict):
            raise ProviderError("SportsGameOdds: unerwartete Antwort (kein Objekt)")
        return payload

    # -------------------------------------------------------------- Parsing
    def _sport_of(self, raw: dict[str, Any]) -> Sport | None:
        sport_id = str(raw.get("sportID") or "").upper()
        return SPORTS.get(sport_id)

    @staticmethod
    def _team_name(team: dict[str, Any] | None) -> str:
        names = (team or {}).get("names") or {}
        for key in ("long", "medium", "short"):
            value = names.get(key)
            if value:
                return str(value)
        return ""

    @staticmethod
    def _status_of(raw: dict[str, Any]) -> EventStatus:
        status = raw.get("status") or {}
        if status.get("cancelled"):
            return EventStatus.SUSPENDED
        if status.get("ended") or status.get("completed") or status.get("finalized"):
            return EventStatus.FINISHED
        if status.get("live"):
            return EventStatus.LIVE
        if status.get("started"):
            return EventStatus.LIVE
        return EventStatus.PRE_MATCH

    @staticmethod
    def _starts_at(raw: dict[str, Any]) -> datetime | None:
        value = (raw.get("status") or {}).get("startsAt")
        if not value:
            return None
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)

    def _parse_event(self, raw: dict[str, Any]) -> tuple[EventSnapshot, list[OddsQuote]] | None:
        sport = self._sport_of(raw)
        if sport is None:
            self.skipped["sportart"] += 1
            return None
        event_id = str(raw.get("eventID") or "")
        teams = raw.get("teams") or {}
        home = self._team_name(teams.get("home"))
        away = self._team_name(teams.get("away"))
        if not event_id or not home or not away:
            self.skipped["unvollstaendiges_event"] += 1
            return None

        status = self._status_of(raw)
        home_score = _to_float((teams.get("home") or {}).get("score"))
        away_score = _to_float((teams.get("away") or {}).get("score"))
        score = (
            Score(int(home_score), int(away_score))
            if home_score is not None and away_score is not None
            else None
        )

        # Spielminute und Punktdetails liefert diese Quelle nicht. Sie werden
        # nicht geschätzt - nur der Abschnitt wird übernommen, wenn er da ist.
        period_id = str((raw.get("status") or {}).get("currentPeriodID") or "")
        football = tennis = None
        if status is EventStatus.LIVE and period_id:
            if sport is Sport.FOOTBALL:
                football = FootballState(minute=None, period=period_id)
            elif sport is Sport.TENNIS:
                tennis = TennisState(set_number=_int_or_none(period_id.removeprefix("set")))

        snapshot = EventSnapshot(
            event_id=event_id,
            sport=sport,
            home=home,
            away=away,
            provider=self.name,
            provider_event_id=event_id,
            league=str(raw.get("leagueID") or "") or None,
            start_time=self._starts_at(raw),
            status=status,
            score=score,
            football=football,
            tennis=tennis,
        )
        return snapshot, self._parse_odds(
            event_id, sport, raw.get("odds") or {}, home=home, away=away
        )

    @staticmethod
    def _selection_label(code: SelectionCode, home: str, away: str) -> str:
        """Anzeigename der Selektion.

        ``marketName`` lautet für beide Seiten gleich ("Moneyline") und taugt
        deshalb nicht als Label - im Alarm stünde sonst zweimal dasselbe statt
        der Mannschaft.
        """
        return {
            SelectionCode.HOME: home,
            SelectionCode.AWAY: away,
            SelectionCode.DRAW: "Unentschieden",
            SelectionCode.HOME_OR_DRAW: f"{home} oder Unentschieden",
            SelectionCode.AWAY_OR_DRAW: f"{away} oder Unentschieden",
            SelectionCode.HOME_OR_AWAY: f"{home} oder {away}",
            SelectionCode.OVER: "Over",
            SelectionCode.UNDER: "Under",
            SelectionCode.YES: "Ja",
            SelectionCode.NO: "Nein",
        }.get(code, "")

    def _market_and_selection(
        self, market: dict[str, Any], sport: Sport, home: str = "", away: str = ""
    ) -> tuple[MarketKey, Selection] | None:
        """Marktart, Linie und Selektion aus den Einzelfeldern ableiten."""
        bet_type = BET_TYPES.get(str(market.get("betTypeID") or "").lower())
        if bet_type is None:
            self._skip(f"bet_type:{market.get('betTypeID')}", market)
            return None
        period_id = str(market.get("periodID") or "").lower()
        period = PERIODS.get(period_id)
        if period is None and sport is Sport.TENNIS:
            period = TENNIS_PERIODS.get(period_id)
        if period is None:
            self._skip(f"periode:{market.get('periodID')}", market)
            return None
        code = SIDES.get(str(market.get("sideID") or "").lower())
        if code is None:
            # Spielerwetten und Sonderselektionen: kein Rateversuch.
            self._skip(f"seite:{market.get('sideID')}", market)
            return None

        if bet_type == "yesno":
            # Ja/Nein deckt viele Märkte ab (Spielerwetten, Sonderwetten). Nur
            # der eine, den die statID eindeutig benennt, wird übernommen.
            if not _is_btts(str(market.get("statID") or "")):
                self._skip(f"bet_type:yn:{market.get('statID')}", market)
                return None
            if sport is not Sport.FOOTBALL:
                self._skip(f"btts_ausserhalb_fussball:{sport.value}", market)
                return None
            if code not in (SelectionCode.YES, SelectionCode.NO):
                self._skip(f"btts_seite:{market.get('sideID')}", market)
                return None
            return MarketKey(type=MarketType.BTTS, line=None, period=period), Selection(
                code=code,
                label="Ja" if code is SelectionCode.YES else "Nein",
                raw=str(market.get("sideID") or ""),
            )

        if code in DOUBLE_CHANCE_SIDES:
            # Kombinierte Seiten sind ein eigener Markt. Im Dreiwegbuch wären
            # sie systematisch kürzer und würden dort als Fehlpreis auffallen.
            if sport is not Sport.FOOTBALL:
                self._skip(f"doppelte_chance_ausserhalb_fussball:{sport.value}", market)
                return None
            market_type = MarketType.DOUBLE_CHANCE
            line = None
        elif bet_type == "moneyline3":
            # Dreiweg = 1X2. Im Tennis gibt es kein Unentschieden.
            if sport is not Sport.FOOTBALL:
                self._skip(f"dreiweg_ausserhalb_fussball:{sport.value}", market)
                return None
            market_type = MarketType.MATCH_ODDS
            line = None
        elif bet_type == "moneyline":
            # Zweiweg. Im Fußball ist das **nicht** 1X2: ohne das
            # Unentschieden entspricht es Draw No Bet. Ein eigener Schlüssel
            # ist Pflicht, sonst mischen sich Zwei- und Dreiwegpreise in einem
            # Buch - und jede Zweiwegquote sähe wie ein Fehlpreis aus.
            market_type = (
                MarketType.DRAW_NO_BET if sport is Sport.FOOTBALL else MarketType.MATCH_WINNER
            )
            line = None
        elif bet_type == "spread":
            market_type = (
                MarketType.HANDICAP if sport is Sport.FOOTBALL else MarketType.GAME_HANDICAP
            )
            line = _to_float(market.get("fairSpread") or market.get("bookSpread"))
        else:
            market_type = (
                MarketType.OVER_UNDER if sport is Sport.FOOTBALL else MarketType.OVER_UNDER_GAMES
            )
            line = _to_float(market.get("fairOverUnder") or market.get("bookOverUnder"))

        return MarketKey(type=market_type, line=line, period=period), Selection(
            code=code,
            label=self._selection_label(code, home, away),
            raw=str(market.get("sideID") or ""),
        )

    def _parse_odds(
        self,
        event_id: str,
        sport: Sport,
        odds: dict[str, Any],
        *,
        home: str = "",
        away: str = "",
    ) -> list[OddsQuote]:
        quotes: list[OddsQuote] = []
        stamp = now_ts()
        for market in odds.values():
            if not isinstance(market, dict):
                continue
            if market.get("cancelled"):
                self._skip("markt_abgesagt", market)
                continue
            parsed = self._market_and_selection(market, sport, home=home, away=away)
            if parsed is None:
                continue
            market_key, selection = parsed

            by_bookmaker = market.get("byBookmaker") or {}
            if not isinstance(by_bookmaker, dict):
                continue
            for bookmaker_id, entry in by_bookmaker.items():
                if not isinstance(entry, dict):
                    continue
                # Die Linie kann je Buchmacher abweichen (alternative Lines).
                own_line = market_key.line
                if market_key.type in (MarketType.OVER_UNDER, MarketType.OVER_UNDER_GAMES):
                    own_line = _to_float(entry.get("overUnder")) or own_line
                elif market_key.type in (MarketType.HANDICAP, MarketType.GAME_HANDICAP):
                    own_line = _to_float(entry.get("spread")) or own_line

                price = american_to_decimal(entry.get("odds"))
                if price is None:
                    self._skip("quote_unlesbar", market)
                    continue
                quotes.append(
                    OddsQuote(
                        event_id=event_id,
                        market=MarketKey(
                            type=market_key.type, line=own_line, period=market_key.period
                        ),
                        selection=selection,
                        bookmaker=str(bookmaker_id),
                        price=price,
                        provider=self.name,
                        ts=stamp,
                        received_at=stamp,
                        confirmed_at=stamp,
                        suspended=entry.get("available") is False,
                    )
                )
        return quotes

    # --------------------------------------------------------------- Abruf
    async def _fetch_all(self) -> tuple[list[EventSnapshot], list[OddsQuote]]:
        async with self._fetch_lock:
            # Innerhalb eines Poll-Takts nur einmal abrufen.
            if now_ts() - self._cache_ts < self.poll_interval * 0.9:
                return self._cached_events, self._cached_quotes
            events, quotes = await self._fetch_uncached()
            self._cached_events, self._cached_quotes = events, quotes
            self._cache_ts = now_ts()
            return events, quotes

    async def _fetch_uncached(self) -> tuple[list[EventSnapshot], list[OddsQuote]]:
        params: dict[str, Any] = {
            "limit": self.page_limit,
            "oddsAvailable": "true",
            "includeOpposingOdds": "true",
        }
        if self.leagues:
            params["leagueID"] = self.leagues
        elif self.sport_ids:
            params["sportID"] = self.sport_ids
        if self.live_only:
            params["live"] = "true"
        else:
            # Beendetes braucht niemand mehr - spart Kontingent und Rauschen.
            params["finalized"] = "false"
        if self.bookmakers:
            params["bookmakerID"] = self.bookmakers

        events: list[EventSnapshot] = []
        quotes: list[OddsQuote] = []
        cursor: str | None = None
        self.skipped.clear()
        self.skipped_samples.clear()

        for _ in range(self.max_pages):
            page_params = dict(params)
            if cursor:
                page_params["cursor"] = cursor
            payload = await self._get(page_params)
            rows = payload.get("data")
            if not isinstance(rows, list):
                raise ProviderError("SportsGameOdds: 'data' fehlt in der Antwort")
            self.last_raw_events = [r for r in rows if isinstance(r, dict)]
            for raw in rows:
                if not isinstance(raw, dict):
                    continue
                parsed = self._parse_event(raw)
                if parsed is None:
                    continue
                snapshot, event_quotes = parsed
                events.append(snapshot)
                quotes.extend(event_quotes)
            cursor = payload.get("nextCursor") or None
            if not cursor:
                break

        if self.skipped:
            log.debug("sportsgameodds: übersprungen", **{k: v for k, v in self.skipped.items()})
        if events and not quotes:
            # Events ohne eine einzige verwertbare Quote: fast immer ein
            # Format-Missverständnis. Sichtbar machen statt stumm liefern.
            self.health.detail = (
                f"{len(events)} Events, aber keine verwertbare Quote - "
                f"häufigste Ursache: {self.skipped.most_common(1)[0][0] if self.skipped else '?'}"
            )
            log.warning(
                "sportsgameodds liefert Events ohne verwertbare Quoten",
                events=len(events),
                gruende=dict(self.skipped),
            )
        else:
            self.health.detail = f"{len(events)} Events · {len(quotes)} Quoten"
        return events, quotes

    async def get_events(self) -> list[EventSnapshot]:
        events, _ = await self._fetch_all()
        return events

    async def get_odds(self) -> list[OddsQuote]:
        _, quotes = await self._fetch_all()
        return quotes


def _int_or_none(raw: str) -> int | None:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


__all__ = ["SportsGameOddsProvider", "american_to_decimal"]
