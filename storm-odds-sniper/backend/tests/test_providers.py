"""Provider: Mock-Simulation, Supervisor/Reconnect, Parser der echten Quellen."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from backend.core.backoff import ExponentialBackoff
from backend.core.config import Settings
from backend.models.domain import now_ts
from backend.models.enums import EventStatus, MarketType, ProviderStatus, Sport
from backend.providers.base import (
    OddsProvider,
    ProviderAuthError,
    ProviderError,
    ProviderHealth,
)
from backend.providers.betfair_exchange import BetfairExchangeProvider, map_market_type
from backend.providers.mock_provider import MockProvider
from backend.providers.registry import build_providers, describe_providers, missing_credentials
from backend.providers.the_odds_api import TheOddsApiProvider, sport_from_key
from backend.scanner.supervisor import ProviderSupervisor


class TestMockProvider:
    async def test_connect_creates_events(self):
        provider = MockProvider(events=6, bookmakers=5, seed=1)
        await provider.connect()
        try:
            events = await provider.get_events()
            assert len(events) == 6
            assert provider.health.status is ProviderStatus.CONNECTED
            assert {e.sport for e in events} == {Sport.FOOTBALL, Sport.TENNIS}
        finally:
            await provider.disconnect()

    async def test_event_pairings_are_unique(self):
        """Sonst führt der EventMatcher zwei Sim-Events zu einem zusammen."""
        provider = MockProvider(events=10, seed=3)
        await provider.connect()
        try:
            events = await provider.get_events()
            pairings = {(e.home, e.away) for e in events}
            assert len(pairings) == len(events)
        finally:
            await provider.disconnect()

    async def test_full_snapshot_covers_all_markets(self):
        provider = MockProvider(events=4, bookmakers=5, seed=2)
        await provider.connect()
        try:
            quotes = await provider.get_odds()
            markets = {q.market.type for q in quotes}
            # Nicht nur 1X2 - alle simulierten Marktarten müssen fließen.
            assert MarketType.MATCH_ODDS in markets
            assert MarketType.OVER_UNDER in markets
            assert MarketType.BTTS in markets
            assert len(markets) >= 5
        finally:
            await provider.disconnect()

    async def test_quotes_carry_the_provider_event_id(self):
        provider = MockProvider(events=3, seed=4)
        await provider.connect()
        try:
            quotes = await provider.get_odds()
            event_ids = {e.provider_event_id for e in await provider.get_events()}
            assert all(q.event_id in event_ids for q in quotes)
        finally:
            await provider.disconnect()

    async def test_stream_pushes_only_changes(self):
        provider = MockProvider(tick_interval=0.05, events=3, bookmakers=4, seed=5)
        await provider.connect()
        try:
            sizes = []
            stream = provider.stream()
            for _ in range(6):
                message = await asyncio.wait_for(stream.__anext__(), timeout=5)
                sizes.append(len(message.quotes))
            # Erste Nachricht überträgt alles, danach nur noch Deltas.
            assert sizes[0] > 0
            assert min(sizes[1:]) < sizes[0]
        finally:
            await provider.disconnect()

    async def test_probabilities_are_normalised(self):
        provider = MockProvider(events=4, seed=6)
        await provider.connect()
        try:
            for sim in provider.events:
                for (market_type, _line), probs in sim.probabilities().items():
                    if market_type is MarketType.DOUBLE_CHANCE:
                        # Double Chance überlappt sich: die drei Selektionen
                        # summieren sich per Definition auf 2, nicht auf 1.
                        assert sum(probs.values()) == pytest.approx(2.0, abs=0.02)
                        continue
                    assert 0.98 <= sum(probs.values()) <= 1.02, market_type
        finally:
            await provider.disconnect()

    async def test_live_events_have_live_details(self):
        provider = MockProvider(events=6, seed=7)
        await provider.connect()
        try:
            live = [e for e in await provider.get_events() if e.status is EventStatus.LIVE]
            assert live
            for event in live:
                if event.sport is Sport.FOOTBALL:
                    assert event.football is not None and event.football.minute is not None
                else:
                    assert event.tennis is not None and event.tennis.set_number is not None
        finally:
            await provider.disconnect()

    async def test_prematch_events_have_no_invented_live_state(self):
        provider = MockProvider(events=6, seed=8)
        await provider.connect()
        try:
            for event in await provider.get_events():
                if event.status is EventStatus.PRE_MATCH:
                    assert event.score is None
                    if event.football:
                        assert event.football.minute is None
                    if event.tennis:
                        assert event.tennis.set_number is None
        finally:
            await provider.disconnect()

    async def test_long_match_never_crashes(self):
        """Regression: bei 0:0 in der 90. Minute hat Draw No Bet keine
        Wahrscheinlichkeitsmasse mehr - das führte zu einer Division durch 0."""
        for seed in (3, 11, 42):
            provider = MockProvider(events=8, bookmakers=7, error_probability=0.3, seed=seed)
            provider._build_events()
            for _ in range(1200):
                for sim in provider.events:
                    sim.last_progress = 0.0  # Spieluhr forcieren
                provider._advance()
                provider._build_quotes(force=True)

    async def test_void_markets_produce_no_quotes(self):
        provider = MockProvider(events=3, seed=5)
        provider._build_events()
        football = next(e for e in provider.events if e.sport is Sport.FOOTBALL)
        football.status = EventStatus.LIVE
        football.minute = 90  # keine Restspielzeit -> Draw No Bet ist void
        football.score_home = football.score_away = 0
        quotes = [q for q in provider._build_quotes(force=True) if q.event_id == football.event_id]
        assert quotes, "andere Märkte müssen weiterhin Quoten liefern"
        assert not [q for q in quotes if q.market.type is MarketType.DRAW_NO_BET]

    async def test_finished_events_are_replaced(self):
        """Ohne Nachschub wäre nach etwa einer Stunde kein Event mehr live."""
        provider = MockProvider(events=8, bookmakers=7, seed=17)
        provider._build_events()
        live_counts = []
        for step in range(4000):
            for sim in provider.events:
                sim.last_progress = 0.0
            provider._advance()
            if step % 400 == 0:
                live_counts.append(sum(1 for e in provider.events if e.status is EventStatus.LIVE))
        assert len(provider.events) == 8
        assert min(live_counts[1:]) > 0, f"Simulation lief leer: {live_counts}"

    async def test_replacements_never_duplicate_a_live_pairing(self):
        """Zwei gleichzeitige Events mit derselben Paarung würde der
        EventMatcher zusammenführen - ihre Quoten wären dann vermischt."""
        provider = MockProvider(events=8, bookmakers=7, seed=17)
        provider._build_events()
        for _ in range(4000):
            for sim in provider.events:
                sim.last_progress = 0.0
            provider._advance()
            pairings = [(e.home, e.away) for e in provider.events]
            assert len(set(pairings)) == len(pairings), f"Doppelte Paarung: {pairings}"

    async def test_suspended_events_recover(self):
        """Regression: suspendierte Events wurden von _advance() übersprungen
        und blieben deshalb für immer stehen."""
        provider = MockProvider(events=4, seed=13)
        provider._build_events()
        live = next(e for e in provider.events if e.status is EventStatus.LIVE)
        live.status = EventStatus.SUSPENDED
        live.last_progress = 0.0
        provider._advance()
        assert live.status is EventStatus.LIVE

    async def test_disconnect_is_idempotent(self):
        provider = MockProvider(events=2, seed=9)
        await provider.connect()
        await provider.disconnect()
        await provider.disconnect()
        assert provider.health.status is ProviderStatus.DISCONNECTED


class FlakyProvider(OddsProvider):
    """Provider, der beim ersten Versuch abbricht - für den Reconnect-Test."""

    name = "flaky"

    def __init__(self, failures: int = 2) -> None:
        super().__init__()
        self.failures = failures
        self.connects = 0
        self.messages_sent = 0

    async def connect(self) -> None:
        self.connects += 1
        self.reset_stop()
        self.mark_connected()

    async def disconnect(self) -> None:
        self.mark_disconnected()

    async def get_events(self):
        return []

    async def get_odds(self):
        return []

    async def stream(self):
        from backend.models.domain import ProviderMessage

        if self.failures > 0:
            self.failures -= 1
            raise ConnectionError("simulierter Verbindungsabbruch")
            yield  # pragma: no cover - unerreichbar, macht die Funktion zum Generator
        while not self.stopping:
            self.messages_sent += 1
            yield ProviderMessage(provider=self.name, heartbeat=True)
            await asyncio.sleep(0.02)


class TestSupervisor:
    async def test_reconnects_after_failures(self):
        provider = FlakyProvider(failures=2)
        received: list = []

        async def sink(message):
            received.append(message)

        supervisor = ProviderSupervisor(provider, sink, backoff_base=0.01, backoff_cap=0.05)
        task = supervisor.start()
        try:
            for _ in range(200):
                if received:
                    break
                await asyncio.sleep(0.02)
            assert received, "Supervisor hat sich nicht erholt"
            assert provider.connects >= 3
            assert provider.health.reconnects >= 2
        finally:
            await supervisor.stop()
            task.cancel()

    async def test_auth_error_disables_the_provider(self):
        class BrokenAuth(FlakyProvider):
            async def connect(self):
                raise ProviderAuthError("kein Key")

        provider = BrokenAuth()
        supervisor = ProviderSupervisor(provider, lambda m: asyncio.sleep(0), backoff_base=0.01)
        task = supervisor.start()
        await asyncio.wait_for(task, timeout=3)
        assert provider.health.status is ProviderStatus.DISABLED

    async def test_stall_is_detected(self):
        class SilentProvider(FlakyProvider):
            async def stream(self):
                await asyncio.sleep(10)
                yield  # pragma: no cover

        provider = SilentProvider(failures=0)
        supervisor = ProviderSupervisor(
            provider, lambda m: asyncio.sleep(0), backoff_base=0.01, stall_timeout=0.1
        )
        task = supervisor.start()
        try:
            await asyncio.sleep(0.6)
            assert provider.health.reconnects >= 1
        finally:
            await supervisor.stop()
            task.cancel()


class TestBackoff:
    def test_grows_and_is_capped(self):
        backoff = ExponentialBackoff(base=1.0, cap=8.0, jitter=False)
        delays = [backoff.next_delay() for _ in range(6)]
        assert delays == [1.0, 2.0, 4.0, 8.0, 8.0, 8.0]

    def test_jitter_stays_in_range(self):
        backoff = ExponentialBackoff(base=4.0, cap=100.0, jitter=True)
        delay = backoff.next_delay()
        assert 2.0 <= delay <= 4.0

    def test_reset(self):
        backoff = ExponentialBackoff(base=1.0, jitter=False)
        backoff.next_delay()
        backoff.next_delay()
        backoff.reset()
        assert backoff.next_delay() == 1.0


ODDS_API_PAYLOAD = [
    {
        "id": "abc123",
        "sport_key": "soccer_germany_bundesliga",
        "sport_title": "Bundesliga",
        "commence_time": "2026-09-07T18:30:00Z",
        "home_team": "Bayern Munich",
        "away_team": "Borussia Dortmund",
        "bookmakers": [
            {
                "key": "pinnacle",
                "title": "Pinnacle",
                "last_update": "2026-09-07T18:00:00Z",
                "markets": [
                    {
                        "key": "h2h",
                        "last_update": "2026-09-07T18:00:00Z",
                        "outcomes": [
                            {"name": "Bayern Munich", "price": 1.85},
                            {"name": "Borussia Dortmund", "price": 4.20},
                            {"name": "Draw", "price": 3.90},
                        ],
                    },
                    {
                        "key": "totals",
                        "last_update": "2026-09-07T18:00:00Z",
                        "outcomes": [
                            {"name": "Over", "price": 1.95, "point": 2.5},
                            {"name": "Under", "price": 1.90, "point": 2.5},
                        ],
                    },
                    {
                        "key": "spreads",
                        "last_update": "2026-09-07T18:00:00Z",
                        "outcomes": [
                            {"name": "Bayern Munich", "price": 1.90, "point": -1.0},
                            {"name": "Borussia Dortmund", "price": 1.95, "point": 1.0},
                        ],
                    },
                ],
            }
        ],
    }
]


class TestTheOddsApi:
    def test_sport_detection(self):
        assert sport_from_key("soccer_epl") is Sport.FOOTBALL
        assert sport_from_key("tennis_atp_wimbledon") is Sport.TENNIS
        assert sport_from_key("basketball_nba") is None

    def test_missing_key_raises(self):
        with pytest.raises(ProviderAuthError):
            TheOddsApiProvider(api_key="")

    def test_event_parsing(self):
        provider = TheOddsApiProvider(api_key="test", sport_keys=["soccer_germany_bundesliga"])
        snapshot, quotes = provider._parse_event(ODDS_API_PAYLOAD[0])
        assert snapshot.sport is Sport.FOOTBALL
        assert snapshot.home == "Bayern Munich"
        assert snapshot.provider_event_id == "abc123"
        # Diese Quelle liefert keine Minute/Karten - darf also nichts erfinden.
        assert snapshot.football is None
        assert snapshot.tennis is None
        assert len(quotes) == 7
        assert all(q.event_id == "abc123" for q in quotes)

    def test_totals_share_one_market_key(self):
        provider = TheOddsApiProvider(api_key="test")
        _snapshot, quotes = provider._parse_event(ODDS_API_PAYLOAD[0])
        totals = [q for q in quotes if q.market.type is MarketType.OVER_UNDER]
        assert len(totals) == 2
        assert len({q.market.key for q in totals}) == 1
        assert totals[0].market.line == 2.5

    def test_spreads_use_the_home_line_for_both_sides(self):
        provider = TheOddsApiProvider(api_key="test")
        _snapshot, quotes = provider._parse_event(ODDS_API_PAYLOAD[0])
        spreads = [q for q in quotes if q.market.type is MarketType.ASIAN_HANDICAP]
        assert len({q.market.key for q in spreads}) == 1
        assert spreads[0].market.line == -1.0

    async def test_http_errors_are_mapped(self):
        provider = TheOddsApiProvider(api_key="test")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"message": "invalid key"})

        provider._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://example.invalid"
        )
        with pytest.raises(ProviderAuthError):
            await provider._get("/sports", {})
        await provider._client.aclose()

    async def test_invalid_key_surfaces_instead_of_looking_like_an_empty_schedule(self):
        """Sonst meldet der Adapter "keine Wettbewerbe" und man sucht den
        Fehler beim Spielplan statt beim Key."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"message": "invalid key"})

        provider = TheOddsApiProvider(api_key="falsch")
        provider._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://example.invalid"
        )
        with pytest.raises(ProviderAuthError):
            await provider._discover_sports()
        await provider._client.aclose()

    async def test_network_errors_surface_instead_of_an_empty_schedule(self):
        """Ohne Sport-Keys kann der Adapter nichts abfragen. Ein stiller Start
        mit null Wettbewerben wäre eine Dauerstörung ohne Hinweis - der
        Supervisor soll stattdessen mit Backoff neu verbinden."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"message": "kurz weg"})

        provider = TheOddsApiProvider(api_key="test")
        provider._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://example.invalid"
        )
        with pytest.raises(ProviderError):
            await provider._discover_sports()
        await provider._client.aclose()

    async def test_connection_problems_are_provider_errors_not_stacktraces(self):
        """Proxy/DNS/TLS-Fehler sollen klassifiziert ankommen."""

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("Verbindung abgelehnt")

        provider = TheOddsApiProvider(api_key="test")
        provider._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://example.invalid"
        )
        with pytest.raises(ProviderError, match="nicht erreichbar"):
            await provider._get("/sports", {})
        await provider._client.aclose()

    async def test_rate_limit_header_is_tracked(self):
        provider = TheOddsApiProvider(api_key="test")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json=[], headers={"x-requests-remaining": "42", "x-requests-used": "8"}
            )

        provider._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://example.invalid"
        )
        await provider._get("/sports", {})
        assert provider.health.rate_limit_remaining == 42
        await provider._client.aclose()

    async def test_a_single_fetch_serves_events_and_odds(self):
        """Sonst würde jeder Poll doppeltes Kontingent verbrauchen."""
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if "/odds" in request.url.path:
                return httpx.Response(200, json=ODDS_API_PAYLOAD)
            return httpx.Response(200, json=[])

        provider = TheOddsApiProvider(
            api_key="test",
            sport_keys=["soccer_germany_bundesliga"],
            use_scores=False,
            poll_interval=60,
        )
        provider._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="https://example.invalid"
        )
        events = await provider.get_events()
        quotes = await provider.get_odds()
        assert events and quotes
        assert calls["n"] == 1
        await provider._client.aclose()


class TestBetfair:
    def test_market_type_mapping(self):
        assert map_market_type("MATCH_ODDS", Sport.FOOTBALL) == (MarketType.MATCH_ODDS, None)
        assert map_market_type("MATCH_ODDS", Sport.TENNIS) == (MarketType.MATCH_WINNER, None)
        assert map_market_type("OVER_UNDER_25", Sport.FOOTBALL) == (MarketType.OVER_UNDER, 2.5)
        assert map_market_type("OVER_UNDER_105", Sport.FOOTBALL) == (MarketType.OVER_UNDER, 10.5)
        assert map_market_type("BOTH_TEAMS_TO_SCORE", Sport.FOOTBALL) == (MarketType.BTTS, None)
        assert map_market_type("SET_WINNER", Sport.TENNIS) == (MarketType.SET_WINNER, None)

    def test_unknown_market_is_kept_as_other_not_guessed(self):
        assert map_market_type("SOMETHING_NEW", Sport.FOOTBALL) == (MarketType.OTHER, None)

    def test_missing_credentials_raise(self):
        with pytest.raises(ProviderAuthError):
            BetfairExchangeProvider(app_key="")
        with pytest.raises(ProviderAuthError):
            BetfairExchangeProvider(app_key="k", username="", password="")

    def test_quote_extraction_from_a_market_book(self):
        provider = BetfairExchangeProvider(app_key="k", username="u", password="p")
        provider._runners = {
            "1.234": {11: "Bayern Munich", 22: "Borussia Dortmund", 33: "The Draw"}
        }
        entry = {
            "marketId": "1.234",
            "description": {"marketType": "MATCH_ODDS"},
            "eventType": {"id": "1"},
            "competition": {"name": "Bundesliga"},
            "event": {
                "id": "300",
                "name": "Bayern Munich v Borussia Dortmund",
                "openDate": "2026-09-07T18:30:00Z",
            },
        }
        book = {
            "marketId": "1.234",
            "status": "OPEN",
            "inplay": True,
            "runners": [
                {
                    "selectionId": 11,
                    "status": "ACTIVE",
                    "ex": {"availableToBack": [{"price": 1.86, "size": 4200.0}]},
                },
                {
                    "selectionId": 22,
                    "status": "ACTIVE",
                    "ex": {"availableToBack": [{"price": 4.30, "size": 900.0}]},
                },
            ],
        }
        snapshot = provider._snapshot_for(entry, book)
        assert snapshot is not None
        assert snapshot.status is EventStatus.LIVE
        assert snapshot.home == "Bayern Munich"
        assert snapshot.football is None  # Betting-API liefert keine Minute

        quotes = provider._quotes_for(entry, book, snapshot)
        assert len(quotes) == 2
        assert quotes[0].is_exchange is True
        assert quotes[0].liquidity == 4200.0
        assert quotes[0].bookmaker == "betfair"

    def test_suspended_market_marks_quotes(self):
        provider = BetfairExchangeProvider(app_key="k", username="u", password="p")
        provider._runners = {"1.9": {1: "A", 2: "B"}}
        entry = {
            "marketId": "1.9",
            "description": {"marketType": "MATCH_ODDS"},
            "eventType": {"id": "2"},
            "event": {"id": "9", "name": "Sinner J. v Alcaraz C."},
        }
        book = {
            "marketId": "1.9",
            "status": "SUSPENDED",
            "runners": [
                {
                    "selectionId": 1,
                    "status": "ACTIVE",
                    "ex": {"availableToBack": [{"price": 1.5, "size": 10}]},
                }
            ],
        }
        snapshot = provider._snapshot_for(entry, book)
        assert snapshot.status is EventStatus.SUSPENDED
        assert provider._quotes_for(entry, book, snapshot)[0].suspended is True

    def test_event_name_without_separator_is_skipped(self):
        provider = BetfairExchangeProvider(app_key="k", username="u", password="p")
        entry = {"marketId": "1.1", "eventType": {"id": "1"}, "event": {"name": "Outright Winner"}}
        assert provider._snapshot_for(entry, {"status": "OPEN"}) is None


class TestRegistry:
    def test_mock_needs_no_credentials(self):
        assert missing_credentials("mock", Settings(_env_file=None)) == []

    def test_missing_keys_are_reported(self):
        settings = Settings(_env_file=None, providers="the_odds_api,betfair")
        assert missing_credentials("the_odds_api", settings) == ["ODDS_API_KEY"]
        assert "BETFAIR_APP_KEY" in missing_credentials("betfair", settings)

    def test_a_requested_source_is_never_replaced_by_the_simulation(self, capsys):
        """Wer echte Daten verlangt, darf keine erfundenen bekommen.

        Vorher sprang hier die Simulation ein. Auf dem Dashboard sah eine
        vergessene ODDS_API_KEY damit aus wie ein laufendes System - mit
        künstlichen Fehlpreisen, die nach echten Funden aussehen.
        """
        settings = Settings(_env_file=None, providers="the_odds_api")
        providers = build_providers(settings)
        assert providers == []
        out = capsys.readouterr().out
        assert "KEINE DATENQUELLE STARTBAR" in out
        assert "setup-provider" in out

    def test_configured_mock_is_built(self):
        providers = build_providers(Settings(_env_file=None, providers="mock", mock_events=3))
        assert isinstance(providers[0], MockProvider)

    def test_the_simulation_only_fills_in_when_nothing_was_asked_for(self):
        providers = build_providers(Settings(_env_file=None, providers="", mock_events=3))
        assert [p.name for p in providers] == ["mock"]

    def test_unknown_provider_does_not_summon_the_simulation(self):
        providers = build_providers(Settings(_env_file=None, providers="does_not_exist"))
        assert providers == []

    def test_simulation_next_to_real_data_is_called_out(self, monkeypatch, capsys):
        """Der Fall vom Server: in der Alarmliste stand fast nur Erfundenes."""
        monkeypatch.setenv("ODDS_API_KEY", "x" * 20)
        settings = Settings(_env_file=None, providers="mock,the_odds_api")
        providers = build_providers(settings)
        assert {p.name for p in providers} == {"mock", "the_odds_api"}
        # Auf ASCII prüfen: je nach Testreihenfolge steht das Log als Text
        # oder als JSON da, und dort sind Umlaute escaped.
        out = capsys.readouterr().out
        assert "SIMULATION" in out
        assert "dominiert" in out
        assert "PROVIDERS=the_odds_api" in out

    def test_real_data_alone_is_not_warned_about(self, monkeypatch, capsys):
        monkeypatch.setenv("ODDS_API_KEY", "x" * 20)
        build_providers(Settings(_env_file=None, providers="the_odds_api"))
        assert "dominiert" not in capsys.readouterr().out

    def test_descriptions_include_every_provider(self):
        specs = describe_providers(Settings(_env_file=None))
        assert {s.key for s in specs} == {"mock", "the_odds_api", "sportsgameodds", "betfair"}
        assert all(s.title for s in specs)


class TestHealth:
    def test_json_roundtrip(self):
        health = ProviderHealth(name="x", status=ProviderStatus.CONNECTED, messages=5)
        payload = health.to_json()
        assert payload["status"] == "connected"
        assert payload["healthy"] is True
        assert payload["messages"] == 5

    def test_unconnected_is_not_healthy(self):
        assert ProviderHealth(name="x").healthy is False


class TestQuotaExhaustion:
    """Ein aufgebrauchtes Kontingent ist kein Defekt, sondern eine Pause."""

    def _provider(self) -> TheOddsApiProvider:
        return TheOddsApiProvider(
            api_key="test", sport_keys=["soccer_epl"], markets=["h2h"], regions="eu"
        )

    async def test_exhausted_quota_pauses_without_counting_an_error(self):
        provider = self._provider()
        provider.health.rate_limit_remaining = 2
        events, quotes = await provider._fetch_uncached()
        assert (events, quotes) == ([], [])
        assert provider.health.status is ProviderStatus.PAUSED
        assert provider.health.errors == 0, "eine gewollte Pause ist kein Fehler"

    async def test_the_reason_is_recorded_for_the_dashboard(self):
        provider = self._provider()
        provider.health.rate_limit_remaining = 2
        await provider._fetch_uncached()
        detail = provider.health.detail
        assert "Kontingent aufgebraucht" in detail
        assert "Monatswechsel" in detail
        assert "2 übrig" in detail

    async def test_it_waits_for_the_reset_not_an_hour(self):
        """Stündliche Wiederholungen würden die letzten Credits verbrauchen."""
        provider = self._provider()
        provider.health.rate_limit_remaining = 2
        await provider._fetch_uncached()
        remaining_pause = provider._paused_until - now_ts()
        assert remaining_pause > 3600, "kürzer als eine Stunde wäre sinnlos"
        assert remaining_pause <= provider._seconds_until_month_end() + 1

    async def test_a_healthy_quota_does_not_pause(self):
        provider = self._provider()
        provider.health.rate_limit_remaining = 400
        provider._client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=[])),
            base_url="https://example.invalid",
        )
        await provider._fetch_uncached()
        assert provider.health.status is not ProviderStatus.PAUSED
        await provider._client.aclose()

    def test_paused_is_not_healthy(self):
        provider = self._provider()
        provider.mark_paused("Kontingent aufgebraucht")
        assert provider.health.healthy is False
        assert provider.health.to_json()["status"] == "paused"
