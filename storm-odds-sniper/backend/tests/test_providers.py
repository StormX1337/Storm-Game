"""Provider: Supervisor/Reconnect, Registry und die Parser der echten Quellen."""

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
from backend.providers.registry import build_providers, describe_providers, missing_credentials
from backend.providers.the_odds_api import TheOddsApiProvider, sport_from_key
from backend.scanner.supervisor import ProviderSupervisor


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
    def test_missing_keys_are_reported(self):
        settings = Settings(_env_file=None, providers="the_odds_api,betfair")
        assert missing_credentials("the_odds_api", settings) == ["ODDS_API_KEY"]
        assert "BETFAIR_APP_KEY" in missing_credentials("betfair", settings)

    def test_sportsgameodds_needs_its_key(self):
        assert missing_credentials("sportsgameodds", Settings(_env_file=None)) == ["SGO_API_KEY"]

    def test_a_source_without_credentials_yields_nothing(self, capsys):
        """Kein Ersatz, keine erfundenen Daten - nur eine klare Meldung."""
        providers = build_providers(Settings(_env_file=None, providers="the_odds_api"))
        assert providers == []
        out = capsys.readouterr().out
        assert "KEINE DATENQUELLE STARTBAR" in out
        assert "setup-provider" in out

    def test_an_empty_configuration_yields_nothing(self, capsys):
        """Früher sprang hier eine Simulation ein - die gibt es nicht mehr."""
        assert build_providers(Settings(_env_file=None, providers="")) == []
        assert "KEINE DATENQUELLE STARTBAR" in capsys.readouterr().out

    def test_unknown_provider_yields_nothing(self):
        assert build_providers(Settings(_env_file=None, providers="does_not_exist")) == []

    def test_a_configured_source_is_built(self, monkeypatch):
        monkeypatch.setenv("SGO_API_KEY", "x" * 20)
        providers = build_providers(Settings(_env_file=None, providers="sportsgameodds"))
        assert [p.name for p in providers] == ["sportsgameodds"]

    def test_one_broken_source_does_not_stop_the_others(self, monkeypatch):
        monkeypatch.setenv("SGO_API_KEY", "x" * 20)
        providers = build_providers(
            Settings(_env_file=None, providers="the_odds_api,sportsgameodds")
        )
        assert [p.name for p in providers] == ["sportsgameodds"]

    def test_descriptions_include_every_provider(self):
        specs = describe_providers(Settings(_env_file=None))
        assert {s.key for s in specs} == {"the_odds_api", "sportsgameodds", "betfair"}
        assert all(s.title for s in specs)

    def test_no_adapter_is_a_simulation(self):
        """Die Simulation ist vollständig entfernt - auch als Katalogeintrag."""
        specs = describe_providers(Settings(_env_file=None))
        assert all(s.kind != "mock" for s in specs)
        assert all("mock" not in s.key for s in specs)


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
