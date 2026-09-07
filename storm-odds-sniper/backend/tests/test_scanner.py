"""Scanner-Pipeline: Event-Bindung, inkrementelle Verarbeitung, Alarme."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from backend.core.config import Settings
from backend.models.domain import (
    EventSnapshot,
    MarketKey,
    OddsQuote,
    ProviderMessage,
    Score,
    Selection,
    now_ts,
)
from backend.models.enums import AlertKind, EventStatus, MarketType, SelectionCode, Sport
from backend.scanner.engine import ScannerEngine, thresholds_from_settings
from backend.tests.conftest import OVER, OVER_UNDER_25, UNDER, make_event

MARKET = OVER_UNDER_25


def scanner_settings(**overrides) -> Settings:
    base = {
        "_env_file": None,
        "providers": "mock",
        "min_value_percent": 10.0,
        "min_outlier_percent": 15.0,
        "min_bookmakers": 3,
        "min_odds": 1.5,
        "max_odds_age_seconds": 30.0,
        "alert_cooldown_seconds": 60,
        "min_confidence": 40,
        "min_error_score": 40,
        "move_alerts_enabled": False,
        "market_drift_suppress_percent": 4.0,
    }
    base.update(overrides)
    return Settings(**base)


def quote(bookmaker: str, price: float, selection=OVER, *, event_id="p-1", ts=None) -> OddsQuote:
    stamp = now_ts() if ts is None else ts
    return OddsQuote(
        event_id=event_id,
        market=MARKET,
        selection=selection,
        bookmaker=bookmaker,
        price=price,
        provider="mock",
        ts=stamp,
        received_at=stamp,
        confirmed_at=stamp,
    )


def market_message(prices: dict[str, float], *, event: EventSnapshot | None = None, ts=None):
    """Nachricht mit vollständigem Over/Under-Buch."""
    event = event or make_event(event_id="", provider_event_id="p-1")
    quotes = []
    for bookmaker, price in prices.items():
        quotes.append(quote(bookmaker, price, OVER, ts=ts))
        counter = 1.0 / max(0.02, (1.05 - 1.0 / price))
        quotes.append(quote(bookmaker, counter, UNDER, ts=ts))
    return ProviderMessage(provider="mock", events=[event], quotes=quotes)


@pytest.fixture
async def engine(redis_state):
    return ScannerEngine(scanner_settings(), state=redis_state, repository=None, providers=[])


class TestEventBinding:
    async def test_canonical_id_is_assigned(self, engine):
        message = market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50})
        await engine.handle_message(message)
        stored = list(engine._events.values())
        assert len(stored) == 1
        assert stored[0].event_id.startswith("foo_")

    async def test_two_providers_land_on_one_event(self, engine):
        start = datetime.now(UTC) + timedelta(hours=2)
        first = EventSnapshot(
            event_id="",
            sport=Sport.FOOTBALL,
            home="Bayern München",
            away="Borussia Dortmund",
            provider="mock",
            provider_event_id="a-1",
            start_time=start,
            status=EventStatus.PRE_MATCH,
        )
        second = EventSnapshot(
            event_id="",
            sport=Sport.FOOTBALL,
            home="Bayern Munich",
            away="BVB",
            provider="other",
            provider_event_id="b-9",
            start_time=start,
            status=EventStatus.PRE_MATCH,
        )
        await engine.handle_message(ProviderMessage(provider="mock", events=[first]))
        await engine.handle_message(ProviderMessage(provider="other", events=[second]))
        assert len(engine._events) == 1

    async def test_reversed_provider_is_flipped(self, engine):
        start = datetime.now(UTC) + timedelta(hours=2)
        await engine.handle_message(
            ProviderMessage(
                provider="mock",
                events=[
                    EventSnapshot(
                        event_id="",
                        sport=Sport.FOOTBALL,
                        home="Bayern München",
                        away="Borussia Dortmund",
                        provider="mock",
                        provider_event_id="a-1",
                        start_time=start,
                        status=EventStatus.LIVE,
                        score=Score(2, 0),
                    )
                ],
            )
        )
        await engine.handle_message(
            ProviderMessage(
                provider="other",
                events=[
                    EventSnapshot(
                        event_id="",
                        sport=Sport.FOOTBALL,
                        home="BVB",
                        away="Bayern Munich",
                        provider="other",
                        provider_event_id="b-9",
                        start_time=start,
                        status=EventStatus.LIVE,
                        score=Score(0, 2),
                    )
                ],
                quotes=[
                    OddsQuote(
                        event_id="b-9",
                        market=MarketKey(type=MarketType.MATCH_ODDS),
                        selection=Selection(code=SelectionCode.HOME, label="BVB"),
                        bookmaker="x",
                        price=5.0,
                        provider="other",
                    )
                ],
            )
        )
        stored = next(iter(engine._events.values()))
        # Auf die kanonische Reihenfolge gedreht - inklusive Spielstand.
        assert stored.home == "Bayern Munich"
        assert stored.score.home == 2
        binding = engine._bindings[("other", "b-9")]
        assert binding.swapped is True

    async def test_quotes_of_unknown_events_are_dropped(self, engine):
        message = ProviderMessage(provider="mock", quotes=[quote("b1", 2.4, event_id="ghost")])
        assert await engine.handle_message(message) == []

    async def test_live_transition_is_stored_in_redis(self, engine, redis_state):
        await engine.handle_message(market_message({"b1": 2.4, "b2": 2.45, "b3": 2.5}))
        live = await redis_state.live_event_ids()
        assert len(live) == 1


class TestIncrementalProcessing:
    async def test_unchanged_prices_do_not_repeat_work(self, engine):
        prices = {"b1": 2.40, "b2": 2.45, "b3": 2.50}
        await engine.handle_message(market_message(prices))
        first = engine.stats["changes"]
        await engine.handle_message(market_message(prices))
        assert engine.stats["changes"] == first

    async def test_changed_price_is_processed(self, engine):
        await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50}))
        before = engine.stats["changes"]
        await engine.handle_message(market_message({"b1": 2.60, "b2": 2.45, "b3": 2.50}))
        assert engine.stats["changes"] > before

    async def test_market_state_lands_in_redis(self, engine, redis_state):
        await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50}))
        event_id = next(iter(engine._events))
        quotes = await redis_state.get_market(event_id, MARKET.key)
        assert {q.bookmaker for q in quotes} == {"b1", "b2", "b3"}


class TestAlerting:
    async def test_the_spec_example_produces_an_alert(self, engine):
        """Markt 2.40-2.50, ein Buchmacher bei 3.80."""
        await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42, "b5": 2.48})
        )
        alerts = await engine.handle_message(
            market_message(
                {"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42, "b5": 2.48, "off": 3.80}
            )
        )
        hits = [a for a in alerts if a.bookmaker == "off"]
        assert hits, "Der Ausreißer wurde nicht gemeldet"
        alert = hits[0]
        assert alert.kind is AlertKind.FIXED_ERROR
        assert alert.deviation_percent > 15
        assert alert.value_percent > 10
        assert 0 <= alert.confidence <= 100
        assert alert.error_score >= 40
        assert alert.fingerprint

    async def test_a_normal_market_stays_quiet(self, engine):
        for _ in range(3):
            alerts = await engine.handle_message(
                market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42})
            )
            assert alerts == []

    async def test_cooldown_prevents_repeats(self, engine):
        prices = {"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42}
        await engine.handle_message(market_message(prices))
        first = await engine.handle_message(market_message({**prices, "off": 3.80}))
        assert [a for a in first if a.bookmaker == "off"]
        second = await engine.handle_message(market_message({**prices, "off": 3.81}))
        assert not [a for a in second if a.bookmaker == "off"]

    async def test_too_few_bookmakers_is_silent(self, redis_state):
        engine = ScannerEngine(
            scanner_settings(min_bookmakers=6), state=redis_state, repository=None, providers=[]
        )
        await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45}))
        alerts = await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45, "off": 3.80}))
        assert alerts == []

    async def test_stale_quotes_never_alert(self, engine):
        old = now_ts() - 600
        await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50}))
        alerts = await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "off": 3.80}, ts=old)
        )
        assert alerts == []

    async def test_finished_events_are_ignored(self, engine):
        live = make_event(event_id="", provider_event_id="p-1")
        await engine.handle_message(market_message({"b1": 2.4, "b2": 2.45, "b3": 2.5}, event=live))
        finished = make_event(event_id="", provider_event_id="p-1", status=EventStatus.FINISHED)
        alerts = await engine.handle_message(
            market_message({"b1": 2.4, "b2": 2.45, "b3": 2.5, "off": 3.8}, event=finished)
        )
        assert alerts == []

    async def test_market_wide_drift_is_suppressed(self, redis_state):
        """Zieht der ganze Markt hoch, ist die schnellste Quote kein Fehlpreis."""
        engine = ScannerEngine(scanner_settings(), state=redis_state, repository=None, providers=[])
        await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42})
        )
        # Der komplette Markt springt nach oben; ein Buch ist etwas schneller.
        alerts = await engine.handle_message(
            market_message({"b1": 3.40, "b2": 3.45, "b3": 3.50, "b4": 3.42, "fast": 4.30})
        )
        assert [a for a in alerts if a.bookmaker == "fast"] == []

    async def test_lagging_book_is_still_reported(self, redis_state):
        """Fällt der Markt und ein Buch bleibt oben stehen -> genau das ist das Signal."""
        engine = ScannerEngine(scanner_settings(), state=redis_state, repository=None, providers=[])
        await engine.handle_message(
            market_message({"b1": 3.40, "b2": 3.45, "b3": 3.50, "b4": 3.42})
        )
        alerts = await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42, "slow": 3.80})
        )
        assert [a for a in alerts if a.bookmaker == "slow"]

    async def test_extreme_probabilities_are_skipped(self, redis_state):
        """Praktisch entschiedener Markt: dort ist "Value" nur Modellrauschen."""
        engine = ScannerEngine(
            scanner_settings(min_odds=1.01), state=redis_state, repository=None, providers=[]
        )

        def decided(extra: dict[str, float] | None = None) -> ProviderMessage:
            event = make_event(event_id="", provider_event_id="p-1")
            quotes = []
            for bookmaker in ("b1", "b2", "b3"):
                quotes.append(quote(bookmaker, 1.005, OVER))
                quotes.append(quote(bookmaker, 120.0, UNDER))
            for bookmaker, price in (extra or {}).items():
                quotes.append(quote(bookmaker, price, OVER))
                quotes.append(quote(bookmaker, 120.0, UNDER))
            return ProviderMessage(provider="mock", events=[event], quotes=quotes)

        await engine.handle_message(decided())
        alerts = await engine.handle_message(decided({"off": 1.40}))
        assert alerts == []


class TestLeaderAndLaggard:
    """Der Kern der Fehlpreis-Erkennung im Live-Betrieb.

    Springt ein Buch als erstes, *führt* es den Markt an - kein Fehlpreis.
    Bleibt ein Buch stehen, während der Markt fällt, ist genau das der Fehler.
    """

    async def test_the_first_book_to_jump_is_not_an_error(self, redis_state):
        engine = ScannerEngine(
            scanner_settings(market_shock_percent=25.0),
            state=redis_state,
            repository=None,
            providers=[],
        )
        await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "fast": 2.42})
        )
        # Tor gefallen: "fast" reagiert als erstes, der Rest steht noch.
        alerts = await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "fast": 8.00})
        )
        assert [a for a in alerts if a.bookmaker == "fast"] == []

    async def test_a_forgotten_quote_is_found_even_without_its_own_update(self, redis_state):
        """Eine vergessene Quote meldet sich nie von selbst - sie muss aktiv
        geprüft werden, sobald sich der Markt bewegt."""
        engine = ScannerEngine(scanner_settings(), state=redis_state, repository=None, providers=[])
        await engine.handle_message(
            market_message({"b1": 3.40, "b2": 3.45, "b3": 3.50, "asleep": 3.60})
        )
        # Der Markt fällt deutlich; "asleep" liefert schlicht kein Update mehr.
        alerts = await engine.handle_message(market_message({"b1": 2.10, "b2": 2.15, "b3": 2.20}))
        hits = [a for a in alerts if a.bookmaker == "asleep"]
        assert hits, "Die stehen gebliebene Quote wurde nicht gefunden"
        assert hits[0].deviation_percent > 15
        assert hits[0].previous_odds is None

    async def test_unmoved_books_are_left_alone_in_a_quiet_market(self, redis_state):
        engine = ScannerEngine(scanner_settings(), state=redis_state, repository=None, providers=[])
        await engine.handle_message(
            market_message({"b1": 3.40, "b2": 3.45, "b3": 3.50, "quiet": 3.60})
        )
        alerts = await engine.handle_message(market_message({"b1": 3.41, "b2": 3.45, "b3": 3.50}))
        assert alerts == []


class TestQuoteFreshness:
    async def test_an_unchanged_price_stays_fresh(self, redis_state):
        """Sonst würde eine stehen gebliebene Quote künstlich veralten."""
        redis_state.refresh_seconds = 0.0
        first = quote("b1", 2.40, ts=now_ts() - 120)
        await redis_state.apply_quote(first)
        later = quote("b1", 2.40)
        assert await redis_state.apply_quote(later) is None
        stored = (await redis_state.get_line("p-1", MARKET.key, OVER.key))[0]
        assert stored.age() < 1.0  # frisch bestätigt
        assert stored.price_age() > 100  # der Preis selbst steht aber lange

    async def test_refresh_is_rate_limited(self, redis_state):
        redis_state.refresh_seconds = 300.0
        await redis_state.apply_quote(quote("b1", 2.40, ts=now_ts() - 120))
        before = (await redis_state.get_line("p-1", MARKET.key, OVER.key))[0].confirmed_at
        await redis_state.apply_quote(quote("b1", 2.40))
        after = (await redis_state.get_line("p-1", MARKET.key, OVER.key))[0].confirmed_at
        assert after == before  # kein zusätzlicher Redis-Schreibvorgang


class TestMovementAlerts:
    async def test_big_move_is_reported(self, redis_state):
        engine = ScannerEngine(
            scanner_settings(
                move_alerts_enabled=True,
                move_alert_percent=10.0,
                min_error_score=101,
                min_value_percent=1000.0,
            ),
            state=redis_state,
            repository=None,
            providers=[],
        )
        await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50}))
        alerts = await engine.handle_message(market_message({"b1": 3.60, "b2": 2.45, "b3": 2.50}))
        moves = [a for a in alerts if a.kind is AlertKind.ODDS_MOVE]
        assert moves
        assert moves[0].deviation_percent > 10

    async def test_moves_in_decided_markets_are_ignored(self, redis_state):
        """Quote 1.04 -> 200.00 ist ein entschiedener Markt, kein Signal."""
        engine = ScannerEngine(
            scanner_settings(
                move_alerts_enabled=True, move_alert_percent=10.0, min_odds=1.5, max_odds=51.0
            ),
            state=redis_state,
            repository=None,
            providers=[],
        )
        await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50}))
        alerts = await engine.handle_message(market_message({"b1": 200.0, "b2": 2.45, "b3": 2.50}))
        assert [a for a in alerts if a.kind is AlertKind.ODDS_MOVE] == []

    async def test_extreme_longshots_produce_no_value_alert(self, redis_state):
        engine = ScannerEngine(
            scanner_settings(max_odds=51.0), state=redis_state, repository=None, providers=[]
        )
        await engine.handle_message(market_message({"b1": 90.0, "b2": 95.0, "b3": 100.0}))
        alerts = await engine.handle_message(
            market_message({"b1": 90.0, "b2": 95.0, "b3": 100.0, "off": 45.0})
        )
        assert alerts == []

    async def test_small_move_is_ignored(self, redis_state):
        engine = ScannerEngine(
            scanner_settings(move_alerts_enabled=True, move_alert_percent=10.0),
            state=redis_state,
            repository=None,
            providers=[],
        )
        await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50}))
        alerts = await engine.handle_message(market_message({"b1": 2.45, "b2": 2.45, "b3": 2.50}))
        assert [a for a in alerts if a.kind is AlertKind.ODDS_MOVE] == []


class TestPublishing:
    async def test_alerts_are_published_to_redis(self, engine, redis_state):
        received: list = []

        async def listen():
            async for _channel, payload in redis_state.subscribe(engine.settings.channel_alerts):
                received.append(payload)
                return

        task = asyncio.create_task(listen())
        await asyncio.sleep(0.15)
        await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42})
        )
        await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42, "off": 3.80})
        )
        await asyncio.wait_for(task, timeout=3)
        assert received and received[0]["kind"] in {"fixed_error", "value"}


class TestThresholdMapping:
    def test_settings_become_thresholds(self):
        settings = scanner_settings(min_value_percent=22.0, sports_enabled="tennis")
        thresholds = thresholds_from_settings(settings)
        assert thresholds.min_value_percent == 22.0
        assert thresholds.sports == frozenset({Sport.TENNIS})

    def test_unknown_sport_falls_back_to_all(self):
        thresholds = thresholds_from_settings(scanner_settings(sports_enabled="cricket"))
        assert thresholds.sports == frozenset(Sport)


class TestEngineLifecycle:
    async def test_start_and_stop_with_the_mock_provider(self, redis_state):
        from backend.providers.mock_provider import MockProvider

        provider = MockProvider(tick_interval=0.05, events=4, bookmakers=5, seed=21)
        engine = ScannerEngine(
            scanner_settings(scanner_workers=2),
            state=redis_state,
            repository=None,
            providers=[provider],
        )
        await engine.start()
        try:
            for _ in range(100):
                if engine.stats["changes"] > 50:
                    break
                await asyncio.sleep(0.05)
            assert engine.stats["messages"] > 0
            assert engine.stats["changes"] > 0
            assert len(await redis_state.all_event_ids()) == 4
        finally:
            await engine.stop()


class TestConfigurationWarnings:
    """Stumme Fehlkonfigurationen sollen sich melden statt einfach zu schweigen."""

    def _capture(self, engine) -> str:
        import io
        from contextlib import redirect_stdout

        from backend.core.logging import configure_logging

        configure_logging("WARNING", json_logs=True)
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            engine._warn_about_self_defeating_config()
        return buffer.getvalue()

    async def test_slow_polling_with_a_short_age_limit_is_flagged(self, redis_state):
        """Poll-Takt über dem Quotenalter = garantiert nie ein Alarm."""
        from backend.providers.the_odds_api import TheOddsApiProvider

        engine = ScannerEngine(
            scanner_settings(max_odds_age_seconds=10.0),
            state=redis_state,
            repository=None,
            providers=[TheOddsApiProvider(api_key="x", poll_interval=300.0)],
        )
        output = self._capture(engine)
        assert "kein Alarm entstehen" in output
        assert "the_odds_api" in output
        assert "600" in output  # empfohlener Wert = doppelter Takt

    async def test_matching_configuration_stays_quiet(self, redis_state):
        from backend.providers.the_odds_api import TheOddsApiProvider

        engine = ScannerEngine(
            scanner_settings(max_odds_age_seconds=600.0),
            state=redis_state,
            repository=None,
            providers=[TheOddsApiProvider(api_key="x", poll_interval=60.0)],
        )
        assert "kein Alarm" not in self._capture(engine)

    async def test_streaming_providers_are_never_flagged(self, redis_state):
        """Push-Provider haben keinen Poll-Takt, der zu langsam sein könnte."""
        from backend.providers.mock_provider import MockProvider

        engine = ScannerEngine(
            scanner_settings(max_odds_age_seconds=1.0),
            state=redis_state,
            repository=None,
            providers=[MockProvider(events=2, seed=1)],
        )
        assert "kein Alarm" not in self._capture(engine)
