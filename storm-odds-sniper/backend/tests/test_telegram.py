"""Telegram: Nachrichtenaufbereitung und Empfängerfilter."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.core.config import Settings
from backend.models.domain import Alert, MarketKey, Selection, now_ts
from backend.models.enums import AlertKind, EventStatus, MarketType, Period, SelectionCode
from backend.telegram import formatting as fmt
from backend.telegram.bot import AlertDispatcher
from backend.tests.conftest import make_event, make_tennis_event

OVER_25 = MarketKey(type=MarketType.OVER_UNDER, line=2.5, period=Period.FULL_TIME)
OVER = Selection(code=SelectionCode.OVER, label="Over")


def football_alert(**overrides) -> Alert:
    data = {
        "kind": AlertKind.FIXED_ERROR,
        "event": make_event(),
        "market": OVER_25,
        "selection": OVER,
        "bookmaker": "ExampleBookie",
        "odds": 4.20,
        "fair_odds": 2.68,
        "value_percent": 56.7,
        "deviation_percent": 56.7,
        "confidence": 94,
        "error_score": 91,
        "bookmaker_count": 7,
        "detected_at": now_ts(),
    }
    data.update(overrides)
    return Alert(**data)


def tennis_alert(**overrides) -> Alert:
    data = {
        "kind": AlertKind.VALUE,
        "event": make_tennis_event(),
        "market": MarketKey(type=MarketType.MATCH_WINNER, period=Period.MATCH),
        "selection": Selection(code=SelectionCode.HOME, label="Jannik Sinner"),
        "bookmaker": "ExampleBookie",
        "odds": 3.80,
        "fair_odds": 2.35,
        "value_percent": 61.7,
        "deviation_percent": 61.7,
        "confidence": 92,
        "error_score": 70,
        "bookmaker_count": 5,
    }
    data.update(overrides)
    return Alert(**data)


class TestFootballFormatting:
    def test_contains_every_required_field(self):
        text = fmt.format_alert(football_alert())
        assert "STORM ODDS SNIPER" in text
        assert "LIVE" in text and "FOOTBALL" in text
        assert "Bayern München" in text
        assert "Borussia Dortmund" in text
        assert "67'" in text
        assert "1:1" in text
        assert "Over/Under 2.5" in text
        assert "ExampleBookie" in text
        assert "4.20" in text
        assert "2.68" in text
        assert "+56.7%" in text
        assert "94/100" in text

    def test_error_score_only_on_error_alerts(self):
        assert "Error-Score" in fmt.format_alert(football_alert())
        assert "Error-Score" not in fmt.format_alert(football_alert(kind=AlertKind.VALUE))

    def test_prematch_has_no_invented_minute(self):
        event = make_event(status=EventStatus.PRE_MATCH, minute=None, score=None)
        text = fmt.format_alert(football_alert(event=event))
        assert "PRE_MATCH" in text
        assert "⏱" not in text
        assert "📊 Score:" not in text

    def test_red_cards_are_shown_when_present(self):
        event = make_event()
        event.football.home_red_cards = 1
        assert "Rote Karten: 1-0" in fmt.format_alert(football_alert(event=event))

    def test_disclaimer_is_present(self):
        assert "keine automatische Wettabgabe" in fmt.format_alert(football_alert())


class TestSimulationMarking:
    """Ohne deutliche Kennzeichnung suchen Nutzer nach Spielen, die es
    nicht gibt - genau das ist in der Praxis passiert."""

    def test_mock_alerts_are_marked(self):
        text = fmt.format_alert(football_alert(provider="mock"))
        assert "SIMULATION" in text
        assert "erfunden" in text

    def test_real_providers_are_not_marked(self):
        for provider in ("the_odds_api", "betfair", ""):
            text = fmt.format_alert(football_alert(provider=provider))
            assert "SIMULATION" not in text, provider

    def test_short_format_carries_a_marker(self):
        assert "🧪" in fmt.format_alert_short(football_alert(provider="mock"))
        assert "🧪" not in fmt.format_alert_short(football_alert(provider="betfair"))

    def test_event_line_carries_a_marker(self):
        event = make_event()
        event.provider = "mock"
        assert "🧪" in fmt.format_event_line(event)
        event.provider = "betfair"
        assert "🧪" not in fmt.format_event_line(event)

    def test_status_warns_about_simulated_data(self):
        text = fmt.format_status(
            providers=[{"name": "mock", "status": "connected", "healthy": True}],
            counters={},
            stats={},
            paused=False,
        )
        assert "simulierte" in text
        real = fmt.format_status(
            providers=[{"name": "betfair", "status": "connected", "healthy": True}],
            counters={},
            stats={},
            paused=False,
        )
        assert "simulierte" not in real

    def test_is_simulated_helper(self):
        assert fmt.is_simulated("mock") is True
        assert fmt.is_simulated("MOCK") is True
        assert fmt.is_simulated("the_odds_api") is False
        assert fmt.is_simulated("") is False


class TestTennisFormatting:
    def test_contains_tennis_details(self):
        text = fmt.format_alert(tennis_alert())
        assert "TENNIS" in text
        assert "Jannik Sinner" in text
        assert "Carlos Alcaraz" in text
        assert "Satz: 2" in text
        assert "Games: 4-3" in text
        assert "Match Winner" in text
        assert "3.80" in text
        assert "2.35" in text
        assert "+61.7%" in text
        assert "92/100" in text

    def test_server_is_named(self):
        assert "Aufschlag: Jannik Sinner" in fmt.format_alert(tennis_alert())

    def test_missing_details_are_omitted_not_guessed(self):
        event = make_tennis_event()
        event.tennis.games_home = None
        event.tennis.points_home = None
        event.tennis.server = None
        text = fmt.format_alert(tennis_alert(event=event))
        assert "Games:" not in text
        assert "Punkte:" not in text
        assert "Aufschlag:" not in text


class TestMovementFormatting:
    def test_move_alert_shows_before_and_after(self):
        alert = football_alert(
            kind=AlertKind.ODDS_MOVE,
            odds=3.60,
            previous_odds=2.40,
            deviation_percent=50.0,
            speed_percent_per_second=12.5,
        )
        text = fmt.format_alert(alert)
        assert "ODDS MOVE" in text
        assert "2.40" in text and "3.60" in text
        assert "+50.0%" in text
        assert "12.5 %/s" in text
        assert "Faire Quote" not in text


class TestEscaping:
    def test_html_is_escaped(self):
        event = make_event(home="<script>alert(1)</script>", away="A & B")
        text = fmt.format_alert(football_alert(event=event))
        assert "<script>" not in text
        assert "&lt;script&gt;" in text
        assert "A &amp; B" in text

    def test_esc_helper(self):
        assert fmt.esc("<b>") == "&lt;b&gt;"


class TestHelpers:
    def test_confidence_bar_scales(self):
        assert fmt.confidence_bar(0) == "░" * 10
        assert fmt.confidence_bar(100) == "█" * 10
        assert fmt.confidence_bar(50).count("█") == 5

    def test_short_format_is_one_block(self):
        text = fmt.format_alert_short(football_alert())
        assert "Bayern München" in text
        assert "+56.7%" in text
        assert len(text.splitlines()) == 3

    def test_event_line(self):
        assert "Bayern München" in fmt.format_event_line(make_event())

    def test_status_overview(self):
        text = fmt.format_status(
            providers=[{"name": "mock", "status": "connected", "healthy": True, "quotes": 12}],
            counters={"tracked_events": 8, "live_events": 3},
            stats={"alerts_window": 5, "alerts_by_kind": {"value": 5}},
            paused=False,
        )
        assert "mock" in text
        assert "🟢" in text
        assert "aktiv" in text

    def test_status_without_providers_hints_at_the_scanner(self):
        text = fmt.format_status(providers=[], counters={}, stats={}, paused=True)
        assert "Scanner" in text
        assert "pausiert" in text

    def test_settings_overview(self):
        row = SimpleNamespace(
            min_value_percent=10.0,
            min_outlier_percent=15.0,
            min_odds=1.5,
            max_odds=51.0,
            min_bookmakers=3,
            min_confidence=60,
            cooldown_seconds=60,
            sports=["football"],
            markets=None,
            live_enabled=True,
            prematch_enabled=False,
            paused=False,
        )
        text = fmt.format_settings(row)
        assert "10%" in text
        assert "football" in text
        assert "alle" in text  # keine Marktauswahl = alle Märkte
        assert "Pre-Match: <b>aus</b>" in text

    def test_alert_json_roundtrip(self):
        original = football_alert()
        restored = Alert.from_json(original.to_json())
        assert restored.odds == original.odds
        assert restored.event.home == original.event.home
        assert restored.market.key == original.market.key
        assert restored.kind is original.kind


def user_settings(**overrides):
    data = {
        "paused": False,
        "sports": ["football", "tennis"],
        "markets": None,
        "live_enabled": True,
        "prematch_enabled": True,
        "min_odds": 1.5,
        "max_odds": 51.0,
        "min_bookmakers": 3,
        "min_confidence": 60,
        "min_outlier_percent": 15.0,
        "min_value_percent": 10.0,
    }
    data.update(overrides)
    return SimpleNamespace(**data)


@pytest.fixture
def dispatcher(redis_state):
    settings = Settings(_env_file=None, telegram_bot_token="x", telegram_chat_id="")
    return AlertDispatcher(bot=None, state=redis_state, settings=settings, repository=None)


class TestDispatcherFilters:
    def test_matching_alert_passes(self, dispatcher):
        assert dispatcher.matches(football_alert(), user_settings())

    def test_paused_user_gets_nothing(self, dispatcher):
        assert not dispatcher.matches(football_alert(), user_settings(paused=True))

    def test_sport_filter(self, dispatcher):
        assert not dispatcher.matches(football_alert(), user_settings(sports=["tennis"]))
        assert dispatcher.matches(tennis_alert(), user_settings(sports=["tennis"]))

    def test_market_filter(self, dispatcher):
        assert not dispatcher.matches(football_alert(), user_settings(markets=["1x2"]))
        assert dispatcher.matches(football_alert(), user_settings(markets=["over_under"]))

    def test_live_switch(self, dispatcher):
        assert not dispatcher.matches(football_alert(), user_settings(live_enabled=False))

    def test_prematch_switch(self, dispatcher):
        alert = football_alert(event=make_event(status=EventStatus.PRE_MATCH))
        assert not dispatcher.matches(alert, user_settings(prematch_enabled=False))

    def test_odds_range(self, dispatcher):
        assert not dispatcher.matches(football_alert(odds=1.2), user_settings())
        assert not dispatcher.matches(football_alert(odds=99.0), user_settings())

    def test_value_threshold(self, dispatcher):
        alert = football_alert(kind=AlertKind.VALUE, value_percent=4.0)
        assert not dispatcher.matches(alert, user_settings())

    def test_deviation_threshold_for_error_alerts(self, dispatcher):
        alert = football_alert(deviation_percent=5.0)
        assert not dispatcher.matches(alert, user_settings())

    def test_confidence_threshold(self, dispatcher):
        assert not dispatcher.matches(football_alert(confidence=20), user_settings())

    def test_bookmaker_count_threshold(self, dispatcher):
        assert not dispatcher.matches(football_alert(bookmaker_count=1), user_settings())

    def test_movement_alerts_are_off_by_default(self, dispatcher):
        move = football_alert(kind=AlertKind.ODDS_MOVE)
        assert not dispatcher.matches(move, user_settings())

    def test_movement_alerts_can_be_switched_on(self, redis_state):
        settings = Settings(_env_file=None, telegram_bot_token="x", telegram_send_moves=True)
        dispatcher = AlertDispatcher(None, redis_state, settings, None)
        assert dispatcher.matches(football_alert(kind=AlertKind.ODDS_MOVE), user_settings())

    def test_default_chat_receives_everything(self, dispatcher):
        assert dispatcher.matches(football_alert(confidence=1), None)

    async def test_default_chat_is_a_recipient(self, redis_state):
        settings = Settings(_env_file=None, telegram_bot_token="x", telegram_chat_id="123, 456")
        dispatcher = AlertDispatcher(None, redis_state, settings, None)
        recipients = await dispatcher.recipients()
        assert [chat_id for chat_id, _ in recipients] == [123, 456]

    async def test_invalid_chat_ids_are_ignored(self, redis_state):
        settings = Settings(_env_file=None, telegram_bot_token="x", telegram_chat_id="abc,789")
        dispatcher = AlertDispatcher(None, redis_state, settings, None)
        assert [chat_id for chat_id, _ in await dispatcher.recipients()] == [789]
