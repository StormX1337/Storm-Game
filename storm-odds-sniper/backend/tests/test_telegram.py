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
            providers=[
                {"name": "sportsgameodds", "status": "connected", "healthy": True, "quotes": 12}
            ],
            counters={"tracked_events": 8, "live_events": 3},
            stats={"alerts_window": 5, "alerts_by_kind": {"value": 5}},
            paused=False,
        )
        assert "sportsgameodds" in text
        assert "🟢" in text
        assert "aktiv" in text

    def test_status_without_providers_hints_at_the_scanner(self):
        text = fmt.format_status(providers=[], counters={}, stats={}, paused=True)
        assert "Scanner" in text
        assert "pausiert" in text

    def test_scorecard_without_data_explains_itself(self):
        text = fmt.format_scorecard({"window_hours": 168, "resolved": 0, "pending": 4})
        assert "Trefferbilanz" in text
        assert "Nachkontrolle" in text

    def test_scorecard_hides_averages_from_tiny_samples(self):
        """Ein Mittelwert aus einem Alarm ist ein Einzelfall, keine Kennzahl."""
        text = fmt.format_scorecard(
            {
                "window_hours": 24,
                "resolved": 5,
                "scored": 1,
                "avg_clv_percent": -88.7,
                "beat_close_share": 0.0,
                "verdicts": [],
            }
        )
        assert "-88.7" not in text
        assert "1 von 10" in text

    def test_scorecard_reports_verdicts_and_clv(self):
        text = fmt.format_scorecard(
            {
                "window_hours": 24,
                "resolved": 10,
                "pending": 2,
                "scored": 12,
                "avg_clv_percent": 6.4,
                "beat_close_share": 62.5,
                "verdicts": [
                    {"verdict": "corrected", "label": fmt.VERDICT_TEXT["corrected"], "count": 6},
                    {"verdict": "held", "label": fmt.VERDICT_TEXT["held"], "count": 4},
                ],
                "by_bookmaker": [
                    {"bookmaker": "examplebookie", "alerts": 6, "avg_clv_percent": 8.1}
                ],
            }
        )
        assert "+6.4 %" in text
        assert "62 %" in text
        assert "n=12" in text
        assert "✅" in text
        assert "examplebookie" in text

    def test_scorecard_never_promises_profit(self):
        """Die Kennzahl ist kein Gewinn - das muss dort stehen, wo sie steht."""
        text = fmt.format_scorecard(
            {
                "window_hours": 24,
                "resolved": 30,
                "scored": 30,
                "avg_clv_percent": 5.0,
                "verdicts": [],
            }
        )
        assert "kein Gewinn" in text

    def test_every_verdict_has_an_icon(self):
        for code in fmt.VERDICT_TEXT:
            assert code in fmt.VERDICT_ICONS, code

    def test_help_lists_the_scorecard_command(self):
        assert "/bilanz" in fmt.HELP_TEXT

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


class TestEmpfehlungInDerNachricht:
    """Die Empfehlung steht in der Nachricht - und ordnet die Rohzahl ein."""

    @staticmethod
    def _alert(**overrides):
        from backend.core.recommendation import evaluate

        alert = football_alert(**overrides)
        alert.recommendation = evaluate(alert).to_json()
        return alert

    def test_spielbarer_alarm_nennt_einsatz(self):
        text = fmt.format_alert(
            self._alert(kind=AlertKind.VALUE, odds=2.10, value_percent=11.0, error_score=0)
        )
        assert "Empfehlung" in text
        assert "Einsatz" in text
        assert "% der Bankroll" in text
        assert "Realistischer Vorteil" in text

    def test_absurder_alarm_wird_als_nicht_spielbar_ausgewiesen(self):
        """56.7 % Value sind kein Grund zu spielen, sondern ein Verdacht."""
        text = fmt.format_alert(self._alert(odds=4.20, value_percent=250.0))
        assert "Nicht spielen" in text
        assert "Datenfehler" in text
        assert "Einsatz" not in text

    def test_alarm_ohne_empfehlung_bleibt_unveraendert(self):
        text = fmt.format_alert(football_alert())
        assert "Empfehlung" not in text

    def test_jeder_grad_hat_ein_symbol(self):
        from backend.core.recommendation import Grade

        for grade in Grade:
            assert fmt.GRADE_ICONS[grade.value]

    def test_hilfe_nennt_den_tipps_befehl(self):
        assert "/tipps" in fmt.HELP_TEXT


class TestBestenliste:
    @staticmethod
    def _slip(*alerts, **kwargs):
        from backend.core.recommendation import recommend_all

        return recommend_all(alerts, **kwargs)

    def test_liste_nennt_wette_buchmacher_quote_und_einsatz(self):
        alert = football_alert(kind=AlertKind.VALUE, odds=2.10, value_percent=11.0)
        text = fmt.format_slip(self._slip(alert), window_minutes=20)
        assert "Was jetzt spielen" in text
        assert "ExampleBookie" in text
        assert "2.10" in text
        assert "% der Bankroll" in text
        assert "Gesamteinsatz" in text

    def test_leere_liste_nennt_den_grund(self):
        alert = football_alert(value_percent=250.0)
        text = fmt.format_slip(self._slip(alert), window_minutes=20)
        assert "Nichts Spielbares" in text
        assert "Warum" in text
        assert "Datenfehler" in text

    def test_ohne_bankroll_werden_keine_betraege_erfunden(self):
        alert = football_alert(kind=AlertKind.VALUE, odds=2.10, value_percent=11.0)
        text = fmt.format_slip(self._slip(alert), window_minutes=20, bankroll=0.0)
        assert "Keine Bankroll hinterlegt" in text
        assert "≈" not in text

    def test_mit_bankroll_steht_der_betrag_dabei(self):
        from backend.core.recommendation import RecommendationConfig

        alert = football_alert(kind=AlertKind.VALUE, odds=2.10, value_percent=11.0)
        slip = self._slip(alert, config=RecommendationConfig(bankroll=2000.0))
        text = fmt.format_slip(slip, window_minutes=20, bankroll=2000.0)
        assert "≈" in text
        assert "Keine Bankroll hinterlegt" not in text

    def test_hinweis_auf_keine_wettberatung(self):
        alert = football_alert(kind=AlertKind.VALUE, odds=2.10, value_percent=11.0)
        text = fmt.format_slip(self._slip(alert), window_minutes=20)
        assert "keine Wettberatung" in text
        assert "automatisch gesetzt" in text


class TestTippsBefehl:
    """/tipps gegen eine echte Datenbank - der Befehl darf nie leer laufen."""

    @staticmethod
    def _update():
        gesendet: list[str] = []

        async def reply_text(text, **kwargs):
            gesendet.append(text)

        update = SimpleNamespace(
            callback_query=None,
            effective_message=SimpleNamespace(reply_text=reply_text),
            effective_user=SimpleNamespace(id=1, username="u", first_name="U"),
        )
        return update, gesendet

    @staticmethod
    def _context(repository, settings):
        return SimpleNamespace(
            application=SimpleNamespace(
                bot_data={"repository": repository, "settings": settings, "admin_ids": set()}
            )
        )

    async def test_gespeicherte_alarme_werden_zur_liste(self, repository):
        from backend.core.recommendation import evaluate
        from backend.telegram.handlers import cmd_tips

        alert = football_alert(kind=AlertKind.VALUE, odds=2.10, value_percent=11.0)
        alert.fingerprint = "tipps-1"
        alert.recommendation = evaluate(alert).to_json()
        await repository.write_batch(alerts=[alert])

        update, gesendet = self._update()
        await cmd_tips(update, self._context(repository, Settings(_env_file=None)))
        assert len(gesendet) == 1
        assert "ExampleBookie" in gesendet[0]
        assert "% der Bankroll" in gesendet[0]

    async def test_ohne_datenbank_sagt_der_befehl_warum(self, repository):
        from backend.telegram.handlers import cmd_tips

        update, gesendet = self._update()
        await cmd_tips(update, self._context(None, Settings(_env_file=None)))
        assert "Datenbank nicht verfügbar" in gesendet[0]

    async def test_ohne_alarme_bleibt_die_antwort_verstaendlich(self, repository):
        from backend.telegram.handlers import cmd_tips

        update, gesendet = self._update()
        await cmd_tips(update, self._context(repository, Settings(_env_file=None)))
        assert "Nichts Spielbares" in gesendet[0]


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


class TestBefehlsregistrierung:
    """Ein Befehl in der Hilfe, den es nicht gibt, ist schlimmer als keiner."""

    def _registered_commands(self) -> set[str]:
        from telegram.ext import CommandHandler

        from backend.telegram import handlers

        recorded: list[object] = []

        class FakeApplication:
            def add_handler(self, handler, group=0):
                recorded.append(handler)

            def add_error_handler(self, handler):
                recorded.append(handler)

        handlers.register(FakeApplication())
        commands: set[str] = set()
        for handler in recorded:
            if isinstance(handler, CommandHandler):
                commands.update(handler.commands)
        return commands

    def test_scorecard_command_exists(self):
        commands = self._registered_commands()
        assert "bilanz" in commands
        assert "scorecard" in commands

    def test_every_documented_command_is_registered(self):
        import re

        documented = set(re.findall(r"^/(\w+)", fmt.HELP_TEXT, flags=re.MULTILINE))
        assert documented <= self._registered_commands()


class TestBewegungsalarmOhneUrteil:
    """Ein Bewegungsalarm hat keine faire Quote - dann gibt es auch kein
    "nicht spielen". Fehlendes Urteil und negatives Urteil sind zweierlei."""

    def test_bewegungsalarm_bekommt_keinen_empfehlungsblock(self):
        from backend.core.recommendation import evaluate

        alert = football_alert(
            kind=AlertKind.ODDS_MOVE, odds=2.10, previous_odds=1.80, value_percent=0.0
        )
        alert.recommendation = evaluate(alert).to_json()
        text = fmt.format_alert(alert)
        assert "Empfehlung" not in text
        assert "Nicht spielen" not in text


class TestRechnungInDerNachricht:
    """Was kostet es, was kommt zurück, wie oft muss ich recht behalten?"""

    @staticmethod
    def _alert(bankroll=0.0):
        from backend.core.recommendation import RecommendationConfig, evaluate

        alert = football_alert(kind=AlertKind.VALUE, odds=2.50, value_percent=11.0)
        alert.recommendation = evaluate(alert, RecommendationConfig(bankroll=bankroll)).to_json()
        return alert

    def test_mit_bankroll_stehen_die_betraege_da(self):
        text = fmt.format_alert(self._alert(bankroll=1000.0))
        assert "Rechnung" in text
        assert "→" in text
        assert "Erwartungswert" in text
        assert "Trefferquote" in text

    def test_ohne_bankroll_werden_keine_betraege_erfunden(self):
        text = fmt.format_alert(self._alert())
        assert "Rechnung" not in text
        # Die Verhältnisse hängen nicht am Konto - die stehen trotzdem da.
        assert "Trefferquote" in text

    def test_bestenliste_rechnet_mit(self):
        from backend.core.recommendation import RecommendationConfig, recommend_all

        alert = football_alert(kind=AlertKind.VALUE, odds=2.50, value_percent=11.0)
        slip = recommend_all([alert], config=RecommendationConfig(bankroll=1000.0))
        text = fmt.format_slip(slip, window_minutes=20, bankroll=1000.0)
        assert "🧮" in text
        assert "Trefferquote nötig" in text

    def test_bewegungsalarm_bekommt_keine_rechnung(self):
        alert = football_alert(kind=AlertKind.ODDS_MOVE, odds=2.10, value_percent=0.0)
        from backend.core.recommendation import evaluate

        alert.recommendation = evaluate(alert).to_json()
        assert "Trefferquote" not in fmt.format_alert(alert)


class TestWettTagebuchImBot:
    """Der Knopf am Alarm, das Abrechnen, die Kasse."""

    @staticmethod
    def _update():
        gesendet: list[tuple[str, object]] = []
        beantwortet: list[str] = []

        async def reply_text(text, **kwargs):
            gesendet.append((text, kwargs.get("reply_markup")))

        async def answer(text=None, **kwargs):
            beantwortet.append(text or "")

        async def edit_message_text(text, **kwargs):
            gesendet.append((text, None))

        message = SimpleNamespace(reply_text=reply_text)
        query = SimpleNamespace(
            data="", answer=answer, message=message, edit_message_text=edit_message_text
        )
        update = SimpleNamespace(
            callback_query=None,
            effective_message=message,
            effective_user=SimpleNamespace(id=42, username="u", first_name="U"),
        )
        return update, query, gesendet, beantwortet

    @staticmethod
    def _context(repository, settings=None):
        return SimpleNamespace(
            application=SimpleNamespace(
                bot_data={
                    "repository": repository,
                    "settings": settings or Settings(_env_file=None),
                    "admin_ids": set(),
                }
            )
        )

    async def _alert_in_db(self, repository, *, bankroll=1000.0):
        from backend.core.recommendation import RecommendationConfig, evaluate
        from backend.tests.test_database import make_alert

        alert = make_alert(kind=AlertKind.VALUE, odds=2.50, value_percent=11.0)
        alert.recommendation = evaluate(alert, RecommendationConfig(bankroll=bankroll)).to_json()
        await repository.write_batch(alerts=[alert])
        return alert

    async def test_knopf_traegt_die_wette_ein(self, repository):
        from backend.telegram.handlers import _bet_from_alert

        alert = await self._alert_in_db(repository)
        update, query, gesendet, beantwortet = self._update()
        update.callback_query = query
        await _bet_from_alert(update, self._context(repository), alert.fingerprint)

        assert beantwortet == ["Eingetragen"]
        assert "Eingetragen" in gesendet[0][0]
        bets = await repository.list_bets(user_id=42)
        assert len(bets) == 1
        assert bets[0].odds == pytest.approx(2.50)
        assert bets[0].status == "open"
        assert bets[0].expected_edge_percent is not None

    async def test_alarm_ohne_einsatzvorschlag_traegt_nichts_ein(self, repository):
        from backend.core.recommendation import evaluate
        from backend.telegram.handlers import _bet_from_alert
        from backend.tests.test_database import make_alert

        alert = make_alert(value_percent=250.0)
        alert.recommendation = evaluate(alert).to_json()
        await repository.write_batch(alerts=[alert])

        update, query, _, beantwortet = self._update()
        update.callback_query = query
        await _bet_from_alert(update, self._context(repository), alert.fingerprint)
        assert "keinen Einsatzvorschlag" in beantwortet[0]
        assert await repository.list_bets(user_id=42) == []

    async def test_abrechnen_setzt_gewinn_und_meldet_es(self, repository):
        from backend.telegram.handlers import _bet_from_alert, _settle_bet

        alert = await self._alert_in_db(repository)
        update, query, gesendet, beantwortet = self._update()
        update.callback_query = query
        await _bet_from_alert(update, self._context(repository), alert.fingerprint)
        bet_id = (await repository.list_bets(user_id=42))[0].id

        await _settle_bet(update, self._context(repository), "won", bet_id)
        assert beantwortet[-1] == "Abgerechnet"
        bet = (await repository.list_bets(user_id=42))[0]
        assert bet.status == "won"
        assert bet.profit == pytest.approx(bet.stake * 1.5)

    async def test_fremde_wetten_lassen_sich_nicht_abrechnen(self, repository):
        """Sonst räumt ein Nutzer im Tagebuch eines anderen auf."""
        from backend.telegram.handlers import _settle_bet

        bet = await repository.create_bet(
            user_id=999, event_id="e1", odds=2.0, stake=5.0, status="open"
        )
        update, query, _, beantwortet = self._update()
        update.callback_query = query
        await _settle_bet(update, self._context(repository), "won", bet.id)
        assert "nicht gefunden" in beantwortet[0]
        assert (await repository.list_bets(user_id=999))[0].status == "open"

    async def test_kasse_ohne_wetten_ist_verstaendlich(self, repository):
        from backend.telegram.handlers import cmd_ledger

        update, _, gesendet, _ = self._update()
        await cmd_ledger(update, self._context(repository))
        assert "Kasse" in gesendet[0][0]
        assert "Noch nichts abgerechnet" in gesendet[0][0]

    async def test_kasse_zeigt_das_ergebnis(self, repository):
        from backend.telegram.handlers import cmd_ledger

        for status in ("won", "lost"):
            bet = await repository.create_bet(
                user_id=42, event_id="e1", odds=2.50, stake=10.0, status="open"
            )
            await repository.settle_bet(bet.id, status, user_id=42)

        update, _, gesendet, _ = self._update()
        await cmd_ledger(update, self._context(repository))
        text = gesendet[0][0]
        assert "Ergebnis" in text
        assert "+5.00" in text
        # Zwei Wetten sind keine Rendite - als Kennzahl darf sie nicht
        # auftauchen, als Warnung dagegen schon.
        assert "<b>Rendite</b>" not in text
        assert "Zufall" in text

    async def test_wetten_liste_nennt_offene(self, repository):
        from backend.telegram.handlers import cmd_bets

        await repository.create_bet(
            user_id=42,
            event_id="e1",
            event_title="A vs B",
            odds=2.0,
            stake=5.0,
            status="open",
        )
        update, _, gesendet, _ = self._update()
        await cmd_bets(update, self._context(repository))
        assert "Offene Wetten" in gesendet[0][0]
        assert "A vs B" in gesendet[1][0]
        assert gesendet[1][1] is not None  # Knöpfe zum Abrechnen

    async def test_alarm_mit_einsatz_bekommt_den_knopf(self):
        from backend.core.recommendation import RecommendationConfig, evaluate
        from backend.telegram.keyboards import bet_button

        alert = football_alert(kind=AlertKind.VALUE, odds=2.50, value_percent=11.0)
        alert.fingerprint = "abc"
        alert.recommendation = evaluate(alert, RecommendationConfig(bankroll=1000)).to_json()
        assert alert.recommendation["stake_percent"] > 0
        markup = bet_button(alert.fingerprint)
        assert markup.inline_keyboard[0][0].callback_data == "bet:new:abc"


class TestMindestgrad:
    """Der wirksamste Filter von allen: die meisten Alarme sind echt
    auffällig, aber nichts, was man spielen würde."""

    @staticmethod
    def _settings(min_grade="any", **overrides):
        basis = {
            "paused": False,
            "sports": ["football", "tennis"],
            "markets": None,
            "live_enabled": True,
            "prematch_enabled": True,
            "min_odds": 1.01,
            "max_odds": 1000.0,
            "min_bookmakers": 1,
            "min_confidence": 0,
            "min_value_percent": 0.0,
            "min_outlier_percent": 0.0,
            "min_grade": min_grade,
            # Nur für die Textausgabe nötig, nicht für den Filter.
            "cooldown_seconds": 60,
        }
        basis.update(overrides)
        return SimpleNamespace(**basis)

    @staticmethod
    def _alert(value, **overrides):
        from backend.core.recommendation import evaluate

        alert = football_alert(kind=AlertKind.VALUE, odds=2.10, value_percent=value, **overrides)
        alert.recommendation = evaluate(alert).to_json()
        return alert

    def test_standard_laesst_alles_durch(self, dispatcher):
        """Niemand soll nach einem Update weniger bekommen als am Tag davor."""
        for value in (11.0, 19.0, 250.0):
            assert dispatcher.matches(self._alert(value), self._settings("any")) is True

    def test_nur_spielbares_filtert_den_rest_weg(self, dispatcher):
        spielbar = self._alert(11.0)
        beobachten = self._alert(19.0)
        unbrauchbar = self._alert(250.0)
        assert spielbar.recommendation["grade"] in ("strong", "moderate")
        assert beobachten.recommendation["grade"] == "weak"
        assert unbrauchbar.recommendation["grade"] == "skip"

        einstellung = self._settings("moderate")
        assert dispatcher.matches(spielbar, einstellung) is True
        assert dispatcher.matches(beobachten, einstellung) is False
        assert dispatcher.matches(unbrauchbar, einstellung) is False

    def test_ab_beobachten_laesst_mehr_durch(self, dispatcher):
        einstellung = self._settings("weak")
        assert dispatcher.matches(self._alert(19.0), einstellung) is True
        assert dispatcher.matches(self._alert(250.0), einstellung) is False

    def test_alarm_ohne_bewertung_verstummt_nicht(self, dispatcher):
        """Fehlende Information ist kein schlechtes Urteil - alte Alarme und
        ein abgeschaltetes Empfehlungsmodul dürfen nicht stumm bleiben."""
        ohne = football_alert(kind=AlertKind.VALUE, odds=2.10, value_percent=11.0)
        assert ohne.recommendation == {}
        assert dispatcher.matches(ohne, self._settings("strong")) is True

    def test_unbekannter_grad_blockiert_nicht(self, dispatcher):
        from backend.core.recommendation import passes_grade

        assert passes_grade({"grade": "irgendwas"}, "strong") is True
        assert passes_grade(None, "strong") is True
        assert passes_grade({"grade": "skip"}, "any") is True

    def test_einstellungen_nennen_den_grad(self):
        text = fmt.format_settings(self._settings("moderate"))
        assert "Nur ab Grad" in text
        assert "kleiner Einsatz" in text


class TestTagesbericht:
    """Ein Bericht statt tausend Meldungen."""

    def _ledger(self, **overrides):
        from backend.core.betlog import summarise

        rows = overrides.pop("rows", [])
        return summarise(rows, **overrides)

    def test_bericht_nennt_kasse_alarme_und_bilanz(self):
        from types import SimpleNamespace as NS

        rows = [
            NS(status="won", stake=10.0, odds=2.5, profit=15.0, expected_edge_percent=4.0),
            NS(status="lost", stake=10.0, odds=2.5, profit=-10.0, expected_edge_percent=4.0),
        ]
        text = fmt.format_digest(
            stats={"alerts_window": 1231},
            scorecard={"scored": 40, "avg_clv_percent": 3.2, "resolved": 40, "pending": 5},
            ledger=self._ledger(rows=rows),
            grades={"skip": 1180, "weak": 40, "moderate": 9, "strong": 2},
        )
        assert "Deine Wetten" in text
        assert "+5.00" in text
        assert "1231" in text
        assert "spielbar: <b>11</b>" in text
        # Die Gradzähler laufen über eine Woche - das muss dranstehen,
        # sonst liest man sie als Anteil der Tageszahl.
        assert "laufende Woche" in text
        assert "+3.2" in text
        assert "kein Gewinn" in text

    def test_ohne_wetten_bleibt_es_verstaendlich(self):
        text = fmt.format_digest(
            stats={"alerts_window": 0}, scorecard={}, ledger=self._ledger(), grades={}
        )
        assert "Nichts eingetragen" in text
        assert "0 in diesem Zeitraum" in text

    def test_zu_kleine_stichprobe_zeigt_keinen_durchschnitt(self):
        text = fmt.format_digest(
            stats={"alerts_window": 5},
            scorecard={"scored": 2, "avg_clv_percent": 88.0, "resolved": 2, "pending": 1},
            ledger=self._ledger(),
            grades={},
        )
        assert "88" not in text
        assert "braucht" in text

    def test_hilfe_nennt_den_bericht(self):
        assert "/bericht" in fmt.HELP_TEXT
