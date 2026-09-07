"""MockProvider - vollständige Simulation ohne externe Abhängigkeit.

**Wichtig:** Dieser Provider liefert *simulierte* Daten. Team-, Spieler- und
Buchmachernamen sind bewusst als Simulation erkennbar (Präfix ``Mock``). Es
werden keine echten Buchmacherquoten nachgebildet oder behauptet.

Warum ein so ausführlicher Mock? Weil damit die komplette Kette - Streaming,
inkrementelle Preisverarbeitung, Value Engine, Fehlerdetektor, Cooldown,
Telegram, Dashboard - ohne API-Key end-to-end läuft und testbar ist.

Simuliert werden:

* Fußball mit Minute, Spielstand, Halbzeiten und roten Karten. Die wahren
  Wahrscheinlichkeiten folgen einem Poisson-Modell über die Restspielzeit -
  fällt ein Tor, bewegt sich der ganze Markt.
* Tennis mit Sätzen, Games, Punkten und Aufschlagrecht.
* Mehrere Buchmacher mit eigener Marge, eigenem Bias und eigenem Update-Takt.
* Gelegentliche Fehlpreise ("fat finger"), damit der Error-Detector etwas zu
  finden hat.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import random
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from backend.core.logging import get_logger
from backend.models.domain import (
    EventSnapshot,
    FootballState,
    MarketKey,
    OddsQuote,
    ProviderMessage,
    Score,
    Selection,
    TennisState,
    now_ts,
)
from backend.models.enums import EventStatus, MarketType, Period, SelectionCode, Sport
from backend.providers.base import OddsProvider

log = get_logger("provider.mock")

MOCK_FOOTBALL_TEAMS = [
    ("Mock München", "Mock Dortmund", "Mock Bundesliga"),
    ("Mock Leverkusen", "Mock Leipzig", "Mock Bundesliga"),
    ("Mock City", "Mock United", "Mock Premier League"),
    ("Mock Arsenal", "Mock Liverpool", "Mock Premier League"),
    ("Mock Madrid", "Mock Barcelona", "Mock LaLiga"),
    ("Mock Sevilla", "Mock Valencia", "Mock LaLiga"),
    ("Mock Milano", "Mock Roma", "Mock Serie A"),
    ("Mock Napoli", "Mock Torino", "Mock Serie A"),
    ("Mock Paris", "Mock Lyon", "Mock Ligue 1"),
    ("Mock Ajax", "Mock Eindhoven", "Mock Eredivisie"),
]

MOCK_TENNIS_PLAYERS = [
    ("Mock Sinner", "Mock Alcaraz", "Mock ATP Masters"),
    ("Mock Djokovic", "Mock Medvedev", "Mock ATP 500"),
    ("Mock Swiatek", "Mock Sabalenka", "Mock WTA 1000"),
    ("Mock Zverev", "Mock Rune", "Mock ATP 250"),
    ("Mock Gauff", "Mock Rybakina", "Mock WTA 500"),
    ("Mock Fritz", "Mock Tsitsipas", "Mock ATP 250"),
]

MOCK_BOOKMAKERS = [
    # (Name, Marge, Update-Takt s, Bias, Börse)
    ("MockExchange", 1.015, 0.4, 0.000, True),
    ("MockSharp", 1.022, 0.6, 0.001, False),
    ("MockBookA", 1.045, 0.9, 0.004, False),
    ("MockBookB", 1.055, 1.2, -0.005, False),
    ("MockBookC", 1.062, 1.6, 0.006, False),
    ("MockBookD", 1.070, 2.2, -0.007, False),
    ("MockBookE", 1.085, 3.0, 0.009, False),
    ("MockBookF", 1.090, 4.0, -0.010, False),
]


def _poisson_pmf(lam: float, k: int) -> float:
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return math.exp(-lam) * lam**k / math.factorial(k)


def _round_price(price: float) -> float:
    """Auf eine buchmacherübliche Genauigkeit runden."""
    if price < 3:
        return round(price * 100) / 100
    if price < 10:
        return round(price * 20) / 20
    return round(price * 4) / 4


# ------------------------------------------------------------------ Simulation


@dataclass(slots=True)
class BookmakerProfile:
    name: str
    margin: float
    update_interval: float
    bias: float
    is_exchange: bool
    next_update: float = 0.0


@dataclass(slots=True)
class FatFingerError:
    bookmaker: str
    event_id: str
    market_key: str
    selection_key: str
    multiplier: float
    expires_at: float


@dataclass(slots=True)
class SimEvent:
    event_id: str
    sport: Sport
    home: str
    away: str
    league: str
    start_time: datetime
    status: EventStatus
    # Fußball
    lam_home: float = 1.4
    lam_away: float = 1.2
    minute: int = 0
    period: str = "1H"
    score_home: int = 0
    score_away: int = 0
    red_home: int = 0
    red_away: int = 0
    # Tennis
    base_p_home: float = 0.55
    sets_home: int = 0
    sets_away: int = 0
    games_home: int = 0
    games_away: int = 0
    point_home: int = 0
    point_away: int = 0
    server: str = "home"
    total_games_line: float = 22.5
    last_progress: float = field(default_factory=now_ts)

    # ------------------------------------------------------------ Fußball
    def football_probabilities(self) -> dict[tuple[MarketType, float | None], dict[str, float]]:
        """Wahre Wahrscheinlichkeiten aus Restspielzeit + Spielstand."""
        remaining = max(0.0, (90 - self.minute) / 90.0)
        red_factor_home = 0.72**self.red_home
        red_factor_away = 0.72**self.red_away
        lh = self.lam_home * remaining * red_factor_home
        la = self.lam_away * remaining * red_factor_away

        max_goals = 8
        ph = [_poisson_pmf(lh, k) for k in range(max_goals + 1)]
        pa = [_poisson_pmf(la, k) for k in range(max_goals + 1)]

        p_home = p_draw = p_away = 0.0
        totals: dict[int, float] = {}
        btts_yes = 0.0
        for i, pi in enumerate(ph):
            for j, pj in enumerate(pa):
                prob = pi * pj
                fh, fa = self.score_home + i, self.score_away + j
                if fh > fa:
                    p_home += prob
                elif fh == fa:
                    p_draw += prob
                else:
                    p_away += prob
                totals[fh + fa] = totals.get(fh + fa, 0.0) + prob
                if fh >= 1 and fa >= 1:
                    btts_yes += prob

        total = p_home + p_draw + p_away
        if total <= 0:  # pragma: no cover - nur als Sicherung
            total = 1.0
        p_home, p_draw, p_away = p_home / total, p_draw / total, p_away / total

        out: dict[tuple[MarketType, float | None], dict[str, float]] = {
            (MarketType.MATCH_ODDS, None): {
                SelectionCode.HOME.value: p_home,
                SelectionCode.DRAW.value: p_draw,
                SelectionCode.AWAY.value: p_away,
            },
            (MarketType.DOUBLE_CHANCE, None): {
                SelectionCode.HOME_OR_DRAW.value: p_home + p_draw,
                SelectionCode.AWAY_OR_DRAW.value: p_away + p_draw,
                SelectionCode.HOME_OR_AWAY.value: p_home + p_away,
            },
            (MarketType.DRAW_NO_BET, None): {
                SelectionCode.HOME.value: p_home / max(1e-9, p_home + p_away),
                SelectionCode.AWAY.value: p_away / max(1e-9, p_home + p_away),
            },
            (MarketType.BTTS, None): {
                SelectionCode.YES.value: btts_yes,
                SelectionCode.NO.value: 1.0 - btts_yes,
            },
            (MarketType.ASIAN_HANDICAP, -0.5): {
                SelectionCode.HOME.value: p_home,
                SelectionCode.AWAY.value: p_draw + p_away,
            },
        }
        for line in (1.5, 2.5, 3.5):
            over = sum(p for goals, p in totals.items() if goals > line)
            out[(MarketType.OVER_UNDER, line)] = {
                SelectionCode.OVER.value: over,
                SelectionCode.UNDER.value: 1.0 - over,
            }
        return out

    # ------------------------------------------------------------- Tennis
    def tennis_probabilities(self) -> dict[tuple[MarketType, float | None], dict[str, float]]:
        """Vereinfachtes Modell: Basisstärke + Führungsbonus.

        Bewusst simpel - der Mock soll plausible Bewegung erzeugen, keine
        exakte Tennis-Markov-Kette sein.
        """
        set_diff = self.sets_home - self.sets_away
        game_diff = self.games_home - self.games_away
        p_match = self.base_p_home + 0.14 * set_diff + 0.025 * game_diff
        p_match = min(0.97, max(0.03, p_match))
        p_set = min(0.97, max(0.03, self.base_p_home + 0.05 * game_diff))
        played = self.sets_home + self.sets_away
        expected_remaining = 9.5 * max(1, 3 - played) * (0.5 + abs(0.5 - p_match))
        played_games = self.games_home + self.games_away + 9 * played
        over = 1.0 / (1.0 + math.exp(-(played_games + expected_remaining - self.total_games_line)))
        return {
            (MarketType.MATCH_WINNER, None): {
                SelectionCode.HOME.value: p_match,
                SelectionCode.AWAY.value: 1.0 - p_match,
            },
            (MarketType.SET_WINNER, None): {
                SelectionCode.HOME.value: p_set,
                SelectionCode.AWAY.value: 1.0 - p_set,
            },
            (MarketType.OVER_UNDER_GAMES, self.total_games_line): {
                SelectionCode.OVER.value: over,
                SelectionCode.UNDER.value: 1.0 - over,
            },
            (MarketType.GAME_HANDICAP, -3.5): {
                SelectionCode.HOME.value: min(0.95, max(0.05, p_match - 0.18)),
                SelectionCode.AWAY.value: 1.0 - min(0.95, max(0.05, p_match - 0.18)),
            },
            (MarketType.SET_HANDICAP, -1.5): {
                SelectionCode.HOME.value: min(0.95, max(0.05, p_match - 0.22)),
                SelectionCode.AWAY.value: 1.0 - min(0.95, max(0.05, p_match - 0.22)),
            },
        }

    def probabilities(self):
        if self.sport is Sport.FOOTBALL:
            return self.football_probabilities()
        return self.tennis_probabilities()

    # ------------------------------------------------------------ Snapshot
    def snapshot(self, provider: str) -> EventSnapshot:
        if self.sport is Sport.FOOTBALL:
            state = FootballState(
                minute=self.minute if self.status is EventStatus.LIVE else None,
                period=self.period if self.status is EventStatus.LIVE else None,
                home_red_cards=self.red_home,
                away_red_cards=self.red_away,
            )
            return EventSnapshot(
                event_id="",
                sport=self.sport,
                home=self.home,
                away=self.away,
                provider=provider,
                provider_event_id=self.event_id,
                league=self.league,
                start_time=self.start_time,
                status=self.status,
                score=Score(self.score_home, self.score_away)
                if self.status is not EventStatus.PRE_MATCH
                else None,
                football=state,
            )
        tennis = TennisState(
            set_number=(self.sets_home + self.sets_away + 1)
            if self.status is EventStatus.LIVE
            else None,
            sets_home=self.sets_home,
            sets_away=self.sets_away,
            games_home=self.games_home if self.status is EventStatus.LIVE else None,
            games_away=self.games_away if self.status is EventStatus.LIVE else None,
            points_home=_TENNIS_POINTS[min(self.point_home, 4)]
            if self.status is EventStatus.LIVE
            else None,
            points_away=_TENNIS_POINTS[min(self.point_away, 4)]
            if self.status is EventStatus.LIVE
            else None,
            server=self.server if self.status is EventStatus.LIVE else None,
        )
        return EventSnapshot(
            event_id="",
            sport=self.sport,
            home=self.home,
            away=self.away,
            provider=provider,
            provider_event_id=self.event_id,
            league=self.league,
            start_time=self.start_time,
            status=self.status,
            score=Score(self.sets_home, self.sets_away)
            if self.status is not EventStatus.PRE_MATCH
            else None,
            tennis=tennis,
        )


_TENNIS_POINTS = ["0", "15", "30", "40", "A"]


class MockProvider(OddsProvider):
    """Push-Provider mit interner Simulation."""

    name = "mock"
    supports_streaming = True
    sports = ("football", "tennis")

    def __init__(
        self,
        *,
        tick_interval: float = 0.35,
        events: int = 8,
        bookmakers: int = 7,
        error_probability: float = 0.02,
        seed: int | None = None,
    ) -> None:
        super().__init__()
        self.tick_interval = max(0.05, tick_interval)
        self.event_count = max(1, events)
        self.rng = random.Random(seed)  # noqa: S311 - Simulation, kein Krypto
        self.error_probability = error_probability
        self.bookmakers = [
            BookmakerProfile(*profile) for profile in MOCK_BOOKMAKERS[: max(2, bookmakers)]
        ]
        self.events: list[SimEvent] = []
        self._last_prices: dict[str, float] = {}
        self._errors: list[FatFingerError] = []
        #: Zeiger in die Paarungs-Pools für nachrückende Partien.
        self._football_cursor = 0
        self._tennis_cursor = 0
        self._queue: asyncio.Queue[ProviderMessage] = asyncio.Queue(maxsize=1000)
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------ Lifecycle
    async def connect(self) -> None:
        self.reset_stop()
        self._build_events()
        self.mark_connected(f"{len(self.events)} simulierte Events")
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._producer(), name="mock-producer")
        log.info(
            "mock provider verbunden", events=len(self.events), bookmakers=len(self.bookmakers)
        )

    async def disconnect(self) -> None:
        self.request_stop()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        self.mark_disconnected("gestoppt")

    # ---------------------------------------------------------------- Daten
    async def get_events(self) -> list[EventSnapshot]:
        return [ev.snapshot(self.name) for ev in self.events]

    async def get_odds(self) -> list[OddsQuote]:
        return self._build_quotes(force=True)

    async def stream(self) -> AsyncIterator[ProviderMessage]:
        """Echter Push: Nachrichten kommen aus der Producer-Task."""
        while not self.stopping:
            try:
                message = await asyncio.wait_for(self._queue.get(), timeout=5.0)
            except TimeoutError:
                yield ProviderMessage(provider=self.name, heartbeat=True)
                continue
            yield message

    # ------------------------------------------------------------- Producer
    async def _producer(self) -> None:
        try:
            while not self.stopping:
                started = now_ts()
                self._advance()
                quotes = self._build_quotes(force=False)
                events = [ev.snapshot(self.name) for ev in self.events]
                message = ProviderMessage(provider=self.name, events=events, quotes=quotes)
                self.mark_message(len(quotes))
                self.health.latency_ms = round((now_ts() - started) * 1000, 3)
                try:
                    self._queue.put_nowait(message)
                except asyncio.QueueFull:
                    log.warning("mock queue voll - Nachricht verworfen")
                await asyncio.sleep(self.tick_interval)
        except asyncio.CancelledError:  # pragma: no cover - Shutdown-Pfad
            raise
        except Exception as exc:  # noqa: BLE001 - Producer darf nie sterben
            self.mark_error(str(exc))
            log.error("mock producer fehlgeschlagen", error=str(exc))

    # ----------------------------------------------------------- Simulation
    def _free_pairing(
        self, pool: list[tuple[str, str, str]], cursor: int, finished: SimEvent
    ) -> tuple[str, str, str]:
        """Nächste Paarung aus dem Pool, die gerade nicht bespielt wird."""
        active = {(ev.home, ev.away) for ev in self.events if ev is not finished}
        for offset in range(len(pool)):
            candidate = pool[(cursor + 1 + offset) % len(pool)]
            if (candidate[0], candidate[1]) not in active:
                return candidate
        # Pool erschöpft: mehr gleichzeitige Events als Paarungen konfiguriert.
        return pool[(cursor + 1) % len(pool)]

    def _next_fixture(self, finished: SimEvent) -> SimEvent:
        """Ersatz für eine beendete Partie: die nächste Paarung aus dem Pool.

        Wichtig: die Paarung darf nicht bereits laufen. Zwei gleichzeitige
        Events mit denselben Teilnehmern würde der EventMatcher zu *einem*
        Event zusammenführen - ihre Quoten landeten im selben Marktbuch und
        wären Unsinn.
        """
        now = datetime.now(UTC)
        if finished.sport is Sport.TENNIS:
            home, away, league = self._free_pairing(
                MOCK_TENNIS_PLAYERS, self._tennis_cursor, finished
            )
            self._tennis_cursor += 1
            return SimEvent(
                event_id=f"mock-t-{self._tennis_cursor}",
                sport=Sport.TENNIS,
                home=home,
                away=away,
                league=league,
                start_time=now,
                status=EventStatus.LIVE,
                base_p_home=self.rng.uniform(0.35, 0.72),
                total_games_line=self.rng.choice([20.5, 22.5, 23.5]),
            )
        home, away, league = self._free_pairing(
            MOCK_FOOTBALL_TEAMS, self._football_cursor, finished
        )
        self._football_cursor += 1
        return SimEvent(
            event_id=f"mock-f-{self._football_cursor}",
            sport=Sport.FOOTBALL,
            home=home,
            away=away,
            league=league,
            start_time=now,
            status=EventStatus.LIVE,
            lam_home=self.rng.uniform(1.0, 2.1),
            lam_away=self.rng.uniform(0.8, 1.8),
            minute=0,
        )

    def _build_events(self) -> None:
        """Jede Paarung genau einmal - sonst führt der EventMatcher zwei
        Sim-Events (korrekterweise) zu einem zusammen."""
        self.events.clear()
        now = datetime.now(UTC)
        football_index = 0
        tennis_index = 0
        for index in range(self.event_count):
            if index % 3 == 2:
                home, away, league = MOCK_TENNIS_PLAYERS[tennis_index % len(MOCK_TENNIS_PLAYERS)]
                tennis_index += 1
                live = index % 2 == 0
                self.events.append(
                    SimEvent(
                        event_id=f"mock-t-{index}",
                        sport=Sport.TENNIS,
                        home=home,
                        away=away,
                        league=league,
                        start_time=now - timedelta(minutes=40)
                        if live
                        else now + timedelta(hours=3),
                        status=EventStatus.LIVE if live else EventStatus.PRE_MATCH,
                        base_p_home=self.rng.uniform(0.35, 0.72),
                        total_games_line=self.rng.choice([20.5, 22.5, 23.5]),
                    )
                )
            else:
                home, away, league = MOCK_FOOTBALL_TEAMS[football_index % len(MOCK_FOOTBALL_TEAMS)]
                football_index += 1
                live = index % 2 == 0
                self.events.append(
                    SimEvent(
                        event_id=f"mock-f-{index}",
                        sport=Sport.FOOTBALL,
                        home=home,
                        away=away,
                        league=league,
                        start_time=now - timedelta(minutes=35)
                        if live
                        else now + timedelta(hours=5),
                        status=EventStatus.LIVE if live else EventStatus.PRE_MATCH,
                        lam_home=self.rng.uniform(1.0, 2.1),
                        lam_away=self.rng.uniform(0.8, 1.8),
                        minute=self.rng.randint(5, 70) if live else 0,
                    )
                )
        self._football_cursor = max(0, football_index - 1)
        self._tennis_cursor = max(0, tennis_index - 1)

    def _advance(self) -> None:
        """Spielverlauf einen Tick weiterdrehen."""
        now = now_ts()
        for ev in self.events:
            if ev.status not in (EventStatus.LIVE, EventStatus.SUSPENDED):
                continue
            if now - ev.last_progress < 1.0:
                continue
            ev.last_progress = now
            if ev.sport is Sport.FOOTBALL:
                self._advance_football(ev)
            else:
                self._advance_tennis(ev)

        # Beendete Partien durch neue ersetzen - sonst wäre nach etwa einer
        # Stunde kein Event mehr live und das Dashboard sähe defekt aus.
        for index, ev in enumerate(self.events):
            if ev.status is EventStatus.FINISHED:
                self.events[index] = self._next_fixture(ev)

        self._errors = [e for e in self._errors if e.expires_at > now]
        if self.rng.random() < self.error_probability:
            self._inject_error(now)

    def _advance_football(self, ev: SimEvent) -> None:
        ev.minute += 1
        if ev.minute <= 45:
            ev.period = "1H"
        elif ev.minute <= 47:
            ev.period = "HT"
        elif ev.minute <= 90:
            ev.period = "2H"
        else:
            ev.status = EventStatus.FINISHED
            ev.period = "FT"
            return
        # Tor?
        goal_chance = (ev.lam_home + ev.lam_away) / 90.0
        if self.rng.random() < goal_chance:
            if self.rng.random() < ev.lam_home / (ev.lam_home + ev.lam_away):
                ev.score_home += 1
            else:
                ev.score_away += 1
        # Rote Karte (selten)
        if self.rng.random() < 0.0008:
            if self.rng.random() < 0.5:
                ev.red_home += 1
            else:
                ev.red_away += 1
        # Kurze Suspendierung wie nach einem Tor. Sie muss sich auch wieder
        # lösen - sonst bliebe das Event für immer stehen.
        if ev.status is EventStatus.SUSPENDED:
            ev.status = EventStatus.LIVE
        elif self.rng.random() < 0.004:
            ev.status = EventStatus.SUSPENDED

    def _advance_tennis(self, ev: SimEvent) -> None:
        p_point = ev.base_p_home if ev.server == "home" else 1.0 - ev.base_p_home
        p_point = min(0.9, max(0.1, p_point + 0.15))
        if self.rng.random() < p_point:
            ev.point_home += 1
        else:
            ev.point_away += 1
        if max(ev.point_home, ev.point_away) >= 4 and abs(ev.point_home - ev.point_away) >= 2:
            if ev.point_home > ev.point_away:
                ev.games_home += 1
            else:
                ev.games_away += 1
            ev.point_home = ev.point_away = 0
            ev.server = "away" if ev.server == "home" else "home"
            if max(ev.games_home, ev.games_away) >= 6 and abs(ev.games_home - ev.games_away) >= 2:
                if ev.games_home > ev.games_away:
                    ev.sets_home += 1
                else:
                    ev.sets_away += 1
                ev.games_home = ev.games_away = 0
                if max(ev.sets_home, ev.sets_away) >= 2:
                    ev.status = EventStatus.FINISHED

    def _inject_error(self, now: float) -> None:
        """Einen kurzlebigen Fehlpreis setzen."""
        live_events = [e for e in self.events if e.status is EventStatus.LIVE] or self.events
        ev = self.rng.choice(live_events)
        market_key, probs = self.rng.choice(list(ev.probabilities().items()))
        selection_key = self.rng.choice(list(probs.keys()))
        bookmaker = self.rng.choice([b for b in self.bookmakers if not b.is_exchange])
        market = MarketKey(type=market_key[0], line=market_key[1], period=_period_for(ev.sport))
        self._errors.append(
            FatFingerError(
                bookmaker=bookmaker.name,
                event_id=ev.event_id,
                market_key=market.key,
                selection_key=selection_key,
                multiplier=self.rng.uniform(1.35, 1.95),
                expires_at=now + self.rng.uniform(6.0, 25.0),
            )
        )
        log.debug(
            "mock fehlpreis gesetzt",
            event_id=ev.event_id,
            bookmaker=bookmaker.name,
            market=market.key,
            selection=selection_key,
        )

    # --------------------------------------------------------------- Quoten
    def _error_multiplier(
        self, bookmaker: str, event_id: str, market: str, selection: str
    ) -> float:
        for err in self._errors:
            if (
                err.bookmaker == bookmaker
                and err.event_id == event_id
                and err.market_key == market
                and err.selection_key == selection
            ):
                return err.multiplier
        return 1.0

    def _build_quotes(self, *, force: bool) -> list[OddsQuote]:
        """Nur geänderte Preise ausliefern (inkrementell).

        Welche Buchmacher in diesem Tick aktualisieren, wird **einmal** zu
        Beginn entschieden - sonst würde der erste Markt den Buchmacher für
        alle weiteren Märkte desselben Ticks blockieren.
        """
        now = now_ts()
        quotes: list[OddsQuote] = []
        due = {b.name for b in self.bookmakers if force or b.next_update <= now}
        for ev in self.events:
            if ev.status is EventStatus.FINISHED:
                continue
            probabilities = ev.probabilities()
            period = _period_for(ev.sport)
            for (market_type, line), probs in probabilities.items():
                market = MarketKey(type=market_type, line=line, period=period)
                total = sum(probs.values())
                if total <= 1e-9:
                    # Kein Wahrscheinlichkeitsraum mehr (z. B. Draw No Bet bei
                    # 0:0 in der 90. Minute): der Markt ist void, keine Quote.
                    continue
                for book in self.bookmakers:
                    if book.name not in due:
                        continue
                    for selection_key, prob in probs.items():
                        share = (prob / total) * book.margin
                        noise = 1.0 + self.rng.uniform(-0.012, 0.012) + book.bias
                        share = min(0.985, max(0.005, share * noise))
                        price = _round_price(1.0 / share)
                        price *= self._error_multiplier(
                            book.name, ev.event_id, market.key, selection_key
                        )
                        price = _round_price(min(1000.0, max(1.01, price)))

                        cache_key = f"{ev.event_id}|{market.key}|{selection_key}|{book.name}"
                        previous = self._last_prices.get(cache_key)
                        if not force and previous is not None and abs(previous - price) < 1e-9:
                            continue
                        self._last_prices[cache_key] = price
                        quotes.append(
                            OddsQuote(
                                event_id=ev.event_id,
                                market=market,
                                selection=_selection_for(selection_key, ev, market_type),
                                bookmaker=book.name,
                                price=price,
                                provider=self.name,
                                ts=now,
                                received_at=now,
                                suspended=ev.status is EventStatus.SUSPENDED,
                                liquidity=self.rng.uniform(250, 9000) if book.is_exchange else None,
                                is_exchange=book.is_exchange,
                            )
                        )
        if not force:
            for book in self.bookmakers:
                if book.name in due:
                    book.next_update = now + book.update_interval
        return quotes


def _period_for(sport: Sport) -> Period:
    return Period.FULL_TIME if sport is Sport.FOOTBALL else Period.MATCH


def _selection_for(code: str, ev: SimEvent, market_type: MarketType) -> Selection:
    selection_code = SelectionCode(code)
    labels = {
        SelectionCode.HOME: ev.home,
        SelectionCode.AWAY: ev.away,
        SelectionCode.DRAW: "Draw",
        SelectionCode.HOME_OR_DRAW: f"{ev.home} / Draw",
        SelectionCode.AWAY_OR_DRAW: f"Draw / {ev.away}",
        SelectionCode.HOME_OR_AWAY: f"{ev.home} / {ev.away}",
        SelectionCode.OVER: "Over",
        SelectionCode.UNDER: "Under",
        SelectionCode.YES: "Yes",
        SelectionCode.NO: "No",
    }
    label = labels.get(selection_code, code)
    if market_type in (MarketType.OVER_UNDER, MarketType.OVER_UNDER_GAMES) and selection_code in (
        SelectionCode.OVER,
        SelectionCode.UNDER,
    ):
        label = selection_code.value.capitalize()
    return Selection(code=selection_code, label=label, raw=code)
