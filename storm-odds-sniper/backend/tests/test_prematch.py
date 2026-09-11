"""Vor dem Anpfiff ist ein anderer Markt, nicht dieselbe Welt mit Etikett.

Es sind mehr Buchmacher da, alle hatten Tage Zeit, und die Preise stehen
dichter beieinander. Mit den Live-Schwellen käme darum fast nichts durch -
und was durchkäme, wäre eher ein Datenfehler als ein Vorteil. Diese Tests
halten die Trennung fest: eigene Schwellen, eigener Abruf, eigene Ansicht.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from backend.core.config import Settings
from backend.core.recommendation import RecommendationConfig, build_slip, evaluate
from backend.models.domain import Alert, now_ts
from backend.models.enums import AlertKind, EventStatus
from backend.providers.registry import build_providers
from backend.scanner.engine import (
    ScannerEngine,
    prematch_thresholds_from_settings,
    thresholds_from_settings,
)
from backend.tests.conftest import OVER, OVER_UNDER_25, make_event
from backend.tests.test_scanner import market_message, scanner_settings


class TestSchwellen:
    def test_ohne_eigene_angabe_gilt_live(self):
        """Wer nichts einträgt, bekommt exakt die Live-Werte - keine stillen
        Extras, die man später sucht."""
        settings = Settings(
            _env_file=None,
            min_value_percent=10.0,
            min_bookmakers=3,
            prematch_min_value_percent=None,
            prematch_min_outlier_percent=None,
            prematch_min_bookmakers=None,
        )
        live = thresholds_from_settings(settings)
        vor = prematch_thresholds_from_settings(settings, live)
        assert vor.min_value_percent == live.min_value_percent
        assert vor.min_bookmakers == live.min_bookmakers

    def test_eigene_angabe_gilt_nur_fuer_prematch(self):
        settings = Settings(
            _env_file=None,
            min_value_percent=10.0,
            min_bookmakers=3,
            prematch_min_value_percent=4.0,
            prematch_min_bookmakers=5,
        )
        live = thresholds_from_settings(settings)
        vor = prematch_thresholds_from_settings(settings, live)
        assert live.min_value_percent == 10.0
        assert vor.min_value_percent == 4.0
        assert vor.min_bookmakers == 5

    async def test_engine_waehlt_nach_eventzustand(self, redis_state):
        engine = ScannerEngine(
            scanner_settings(prematch_min_value_percent=4.0),
            state=redis_state,
            repository=None,
            providers=[],
        )
        live = make_event(status=EventStatus.LIVE)
        vor = make_event(status=EventStatus.PRE_MATCH)
        assert engine._thresholds_for(live).min_value_percent == 10.0
        assert engine._thresholds_for(vor).min_value_percent == 4.0
        # Auch alles andere, was kein Live ist, wird vorsichtig behandelt.
        assert engine._thresholds_for(make_event(status=EventStatus.UNKNOWN)) is (
            engine.prematch_thresholds
        )


class TestAlarmeVorDemAnpfiff:
    """Derselbe Preis, einmal live und einmal vor dem Anpfiff."""

    # b5 liegt 9.4 % über der fairen Quote. Das ist genau der Bereich, in dem
    # sich die beiden Welten unterscheiden: live (10 % / 15 %) zu wenig, vor
    # dem Anpfiff (4 % / 6 %) ein Fund. Dieselben Preise, zwei Antworten.
    PREISE = {"b1": 2.02, "b2": 2.00, "b3": 2.00, "b4": 1.99, "b5": 2.30}

    WEICH = {
        "prematch_min_value_percent": 4.0,
        "prematch_min_outlier_percent": 6.0,
        "prematch_min_bookmakers": 3,
    }

    async def _alarme(self, redis_state, status, **overrides):
        engine = ScannerEngine(
            scanner_settings(**overrides), state=redis_state, repository=None, providers=[]
        )
        event = make_event(status=status, provider_event_id="p-1")
        alarme = await engine.handle_message(market_message(self.PREISE, event=event))
        return [a for a in alarme if a.kind is not AlertKind.ODDS_MOVE]

    async def test_live_schwelle_laesst_kleinen_vorteil_nicht_durch(self, redis_state):
        assert await self._alarme(redis_state, EventStatus.LIVE, **self.WEICH) == []

    async def test_prematch_schwelle_meldet_ihn(self, redis_state):
        alarme = await self._alarme(redis_state, EventStatus.PRE_MATCH, **self.WEICH)
        assert alarme, "kein Alarm vor dem Anpfiff"
        assert alarme[0].value_percent == pytest.approx(9.4, abs=0.3)

    async def test_alarm_traegt_seine_welt_mit(self, redis_state):
        """Ohne diese Angabe liesse sich später nichts trennen - weder im
        Dashboard noch in der Modellprüfung."""
        alarme = await self._alarme(redis_state, EventStatus.PRE_MATCH, **self.WEICH)
        assert alarme
        assert all(a.phase == "prematch" for a in alarme)
        assert all(a.to_json()["phase"] == "prematch" for a in alarme)


class TestZweiterAbruf:
    """Ein Strom für laufende Spiele, einer für die davor."""

    def _settings(self, **kwargs) -> Settings:
        base = {
            "_env_file": None,
            "providers": "sportsgameodds",
            "sgo_api_key": "k" * 32,
            "sgo_poll_interval": 5.0,
        }
        base.update(kwargs)
        return Settings(**base)

    def test_ohne_schalter_bleibt_es_bei_einem(self):
        namen = [p.name for p in build_providers(self._settings(prematch_enabled=False))]
        assert namen == ["sportsgameodds"]

    def test_mit_schalter_kommt_ein_zweiter_langsamer_strom(self):
        providers = build_providers(
            self._settings(prematch_enabled=True, prematch_poll_interval=60.0)
        )
        namen = [p.name for p in providers]
        assert namen == ["sportsgameodds", "sportsgameodds_prematch"]
        vor = providers[1]
        # Eigener Takt: sonst frisst Prematch das Kontingent des Live-Abrufs.
        assert vor.poll_interval == 60.0
        assert vor.poll_interval > providers[0].poll_interval
        # Und er überspringt laufende Spiele - die hat der schnelle Strom schon.
        assert vor.exclude_live is True
        assert providers[0].exclude_live is False

    def test_ohne_quelle_kein_prematch(self):
        """PREMATCH_ENABLED allein zaubert keine Datenquelle herbei."""
        providers = build_providers(
            self._settings(providers="", sgo_api_key="", prematch_enabled=True)
        )
        assert providers == []


class TestPhaseAmAlarm:
    @pytest.mark.parametrize(
        ("status", "erwartet"),
        [
            (EventStatus.LIVE, "live"),
            (EventStatus.PRE_MATCH, "prematch"),
            # Geraten wird nicht: ohne bekannten Zustand keine Einsortierung.
            (EventStatus.UNKNOWN, "unknown"),
            (EventStatus.SUSPENDED, "unknown"),
        ],
    )
    def test_zuordnung(self, status, erwartet):
        alert = Alert(
            kind=AlertKind.VALUE,
            event=make_event(status=status),
            market=OVER_UNDER_25,
            selection=OVER,
            bookmaker="b1",
            odds=2.10,
            fair_odds=2.00,
            value_percent=5.0,
            deviation_percent=5.0,
            confidence=70,
            error_score=70,
            bookmaker_count=4,
        )
        assert alert.phase == erwartet


class TestAbkuehlzeit:
    """Eine Fehlquote, die stundenlang steht, zappelt dabei um ein, zwei Cent.

    Jede dieser Winzigkeiten ist eine Preisänderung, also eine neue
    Bewertung - und sobald die Sperre abgelaufen ist, ein neuer Alarm. Mit
    den Live-Werten (60 s) und einem Prematch-Takt von 60 s wären das rund
    180 Telegram-Nachrichten für EINE Wette, die drei Stunden gültig ist.
    Gemessen, nicht vermutet: ohne die längere Sperre kamen hier sechs
    Alarme für eine einzige zappelnde Quote.
    """

    BUECHER = {"b1": 2.02, "b2": 2.00, "b3": 2.00, "b4": 1.99}

    async def _runden(self, redis_state, status, *, runden=4, **overrides):
        einstellungen = {
            "alert_cooldown_seconds": 1,
            "prematch_min_value_percent": 4.0,
            "prematch_min_outlier_percent": 6.0,
            "prematch_min_bookmakers": 3,
        }
        einstellungen.update(overrides)
        engine = ScannerEngine(
            scanner_settings(**einstellungen), state=redis_state, repository=None, providers=[]
        )
        event = make_event(status=status, provider_event_id="p-1")
        gesamt = 0
        for runde in range(runden):
            # Zappeln um einen Cent - weit innerhalb der Duplikat-Toleranz,
            # also derselbe Fund, aber eine echte Preisänderung.
            preise = dict(self.BUECHER, b5=2.30 if runde % 2 == 0 else 2.31)
            alarme = await engine.handle_message(
                market_message(preise, event=event, ts=now_ts() + runde * 0.001)
            )
            gesamt += len([a for a in alarme if a.kind is not AlertKind.ODDS_MOVE])
            await asyncio.sleep(1.1)
        return gesamt

    async def test_lange_sperre_meldet_nur_einmal(self, redis_state):
        gemeldet = await self._runden(
            redis_state, EventStatus.PRE_MATCH, prematch_alert_cooldown=60
        )
        assert gemeldet == 1

    async def test_ohne_lange_sperre_kaeme_die_flut(self, redis_state):
        """Der Gegenbeweis - sonst belegt der Test oben nur, dass irgendetwas
        anderes die Alarme verschluckt."""
        gemeldet = await self._runden(redis_state, EventStatus.PRE_MATCH, prematch_alert_cooldown=1)
        assert gemeldet >= 3

    async def test_live_wird_nicht_mitgedrosselt(self, redis_state):
        """Live bleibt schnell: dort ändern sich Preise wirklich, und ein
        Spiel dauert 90 Minuten, keine zwei Tage."""
        gemeldet = await self._runden(
            redis_state,
            EventStatus.LIVE,
            prematch_alert_cooldown=600,
            min_value_percent=4.0,
            min_outlier_percent=6.0,
        )
        assert gemeldet >= 3

    async def test_schwellen_tragen_die_eigene_sperre(self):
        settings = Settings(_env_file=None, alert_cooldown_seconds=60, prematch_alert_cooldown=1800)
        live = thresholds_from_settings(settings)
        vor = prematch_thresholds_from_settings(settings, live)
        assert live.alert_cooldown_seconds == 60
        assert vor.alert_cooldown_seconds == 1800


class TestEmpfehlungsfrist:
    """Live-Fristen auf Prematch anzuwenden macht die Karte leer.

    ``max_alert_age`` kommt von EVENT_STALE_SECONDS (180 s). Für eine
    Live-Quote ist das richtig - sie steht keine drei Minuten. Vor dem
    Anpfiff steht dieselbe Quote stundenlang, und mit der Live-Frist
    verschwand jede Prematch-Empfehlung nach drei Minuten wieder, obwohl
    der Preis noch stand. Die längere Frist verlangt aber den Riegel dazu:
    ist angepfiffen, ist der Vorab-Preis weg.
    """

    def _alarm(self, *, anpfiff_in_min: float, erkannt_vor_min: float, phase_status):
        event = make_event(
            status=phase_status,
            start_time=datetime.now(UTC) + timedelta(minutes=anpfiff_in_min),
        )
        return Alert(
            kind=AlertKind.VALUE,
            event=event,
            market=OVER_UNDER_25,
            selection=OVER,
            bookmaker="b1",
            odds=2.30,
            fair_odds=2.10,
            value_percent=9.4,
            deviation_percent=9.4,
            confidence=80,
            error_score=80,
            bookmaker_count=6,
            detected_at=now_ts() - erkannt_vor_min * 60,
        )

    def _slip(self, alert, **cfg_overrides):
        cfg = RecommendationConfig(**cfg_overrides)
        return build_slip([(alert, evaluate(alert, cfg))], config=cfg)

    def test_prematch_alarm_von_vorhin_bleibt_eine_empfehlung(self):
        alarm = self._alarm(
            anpfiff_in_min=120, erkannt_vor_min=30, phase_status=EventStatus.PRE_MATCH
        )
        slip = self._slip(alarm)
        assert slip.picks, dict(slip.dropped)

    def test_mit_der_live_frist_waere_er_verschwunden(self):
        """Der Gegenbeweis zum Test darüber."""
        alarm = self._alarm(
            anpfiff_in_min=120, erkannt_vor_min=30, phase_status=EventStatus.PRE_MATCH
        )
        slip = self._slip(alarm, prematch_max_alert_age=180.0)
        assert not slip.picks
        assert slip.dropped["alarm_veraltet"] == 1

    def test_angepfiffen_wird_nicht_mehr_empfohlen(self):
        alarm = self._alarm(
            anpfiff_in_min=-10, erkannt_vor_min=20, phase_status=EventStatus.PRE_MATCH
        )
        slip = self._slip(alarm)
        assert not slip.picks
        assert slip.dropped["angepfiffen"] == 1

    def test_ohne_anstosszeit_entscheidet_allein_die_frist(self):
        """Eine Empfehlung wegen einer geratenen Uhrzeit zu streichen wäre
        genauso falsch wie sie stehen zu lassen."""
        alarm = self._alarm(
            anpfiff_in_min=120, erkannt_vor_min=30, phase_status=EventStatus.PRE_MATCH
        )
        alarm.event.start_time = None
        slip = self._slip(alarm)
        assert slip.picks
        assert slip.dropped["angepfiffen"] == 0

    def test_live_behaelt_die_kurze_frist(self):
        """Ein Live-Alarm von vor einer halben Stunde ist Geschichte."""
        alarm = self._alarm(anpfiff_in_min=-60, erkannt_vor_min=30, phase_status=EventStatus.LIVE)
        slip = self._slip(alarm)
        assert not slip.picks
        assert slip.dropped["alarm_veraltet"] == 1


class TestNachkontrolleVorDemAnpfiff:
    """Fünf Minuten Wartezeit messen vor dem Anpfiff gar nichts.

    Gemessen mit der echten ``resolve``: ein Prematch-Alarm (Quote 2.30
    gegen faire 2.10, gemeldet +9.52 %) ergibt nach fünf Minuten den CLV
    +9.52 % - exakt den gemeldeten Vorteil nochmal - und das Urteil
    "held", egal ob sich nichts, der Markt oder der Buchmacher bewegt hat.
    Das ist null Information, die im Backtest hinterher wie Beleg aussieht.

    Richtig ist, wogegen "Closing Line Value" ohnehin gemessen gehört: die
    Linie, bei der der Markt schließt - der Anpfiff.
    """

    def _alarm(self, status, anpfiff_in_min):
        event = make_event(
            status=status,
            start_time=(
                datetime.now(UTC) + timedelta(minutes=anpfiff_in_min)
                if anpfiff_in_min is not None
                else None
            ),
        )
        if anpfiff_in_min is None:
            event.start_time = None
        return Alert(
            kind=AlertKind.VALUE,
            event=event,
            market=OVER_UNDER_25,
            selection=OVER,
            bookmaker="b1",
            odds=2.30,
            fair_odds=2.10,
            value_percent=9.4,
            deviation_percent=9.4,
            confidence=80,
            error_score=80,
            bookmaker_count=6,
        )

    async def _minuten_bis_nachkontrolle(self, redis_state, status, anpfiff_in_min, **kw):
        engine = ScannerEngine(
            scanner_settings(**kw), state=redis_state, repository=None, providers=[]
        )
        faellig = engine._followup_due_at(self._alarm(status, anpfiff_in_min))
        return (faellig - now_ts()) / 60.0

    async def test_live_bleibt_bei_fuenf_minuten(self, redis_state):
        minuten = await self._minuten_bis_nachkontrolle(redis_state, EventStatus.LIVE, -30)
        assert minuten == pytest.approx(5.0, abs=0.2)

    async def test_prematch_wartet_bis_kurz_vor_anpfiff(self, redis_state):
        minuten = await self._minuten_bis_nachkontrolle(redis_state, EventStatus.PRE_MATCH, 180)
        # Zwei Minuten Vorlauf, damit die Vergleichsquoten noch in Redis stehen.
        assert minuten == pytest.approx(178.0, abs=0.5)

    async def test_kurz_vor_anpfiff_keine_nachkontrolle_in_der_vergangenheit(self, redis_state):
        """Ein Alarm zwei Minuten vor Anpfiff bekäme sonst einen Termin, der
        schon vorbei ist."""
        minuten = await self._minuten_bis_nachkontrolle(redis_state, EventStatus.PRE_MATCH, 2)
        assert minuten == pytest.approx(5.0, abs=0.2)

    async def test_weit_entferntes_spiel_wird_gedeckelt(self, redis_state):
        """Die Vormerkung in Redis lebt 24 Stunden - danach wäre der Termin
        eine Vormerkung auf nichts."""
        minuten = await self._minuten_bis_nachkontrolle(
            redis_state, EventStatus.PRE_MATCH, 5 * 24 * 60
        )
        assert minuten == pytest.approx(23 * 60, abs=1.0)

    async def test_ohne_anstosszeit_fester_laengerer_abstand(self, redis_state):
        minuten = await self._minuten_bis_nachkontrolle(redis_state, EventStatus.PRE_MATCH, None)
        assert minuten == pytest.approx(60.0, abs=0.2)

    async def test_abschaltbar(self, redis_state):
        """Wer die alte Wartezeit will, bekommt sie - aber bewusst."""
        minuten = await self._minuten_bis_nachkontrolle(
            redis_state, EventStatus.PRE_MATCH, 180, prematch_followup_at_kickoff=False
        )
        assert minuten == pytest.approx(5.0, abs=0.2)


class TestWarumFuenfMinutenNichtsMessen:
    """Der Beleg für die Umstellung oben - gegen die echte Urteilslogik."""

    def test_clv_nach_fuenf_minuten_ist_der_gemeldete_vorteil_nochmal(self):
        from backend.core.verdict import resolve

        for final_price, final_fair in ((2.30, 2.10), (2.29, 2.10)):
            r = resolve(
                kind="value",
                alert_odds=2.30,
                alert_fair=2.10,
                final_price=final_price,
                final_fair=final_fair,
            )
            gemeldet = (2.30 / 2.10 - 1) * 100.0
            assert r.clv_percent == pytest.approx(gemeldet, abs=0.01)
            assert r.verdict.value == "held"


class TestSchwellenbaender:
    """Zwischen "gemeldet" und "spielbar" liegt ein Band - und das war blind.

    Auf dem Server gemessen: MAX_ODDS_AGE_SECONDS stand auf 60, die
    Empfehlung blieb bei 15. Ergebnis waren 166 Alarme in 30 Minuten und
    null Empfehlungen, 80 davon allein wegen "Quote zu alt" - ohne eine
    einzige Fehlermeldung. Dass die zweite Stufe strenger ist, ist Absicht;
    dass niemand die Breite sieht, war der Fehler.
    """

    def test_gelockerte_alarmseite_erzeugt_ein_band(self):
        bands = Settings(_env_file=None, max_odds_age_seconds=60.0).threshold_bands()
        assert any("Quotenalter 15-60s" in b for b in bands)

    def test_gleiche_werte_ergeben_kein_band(self):
        bands = Settings(
            _env_file=None,
            max_odds_age_seconds=15.0,
            min_confidence=65,
            min_bookmakers=4,
        ).threshold_bands()
        assert bands == []

    def test_strengere_alarmseite_ist_kein_band(self):
        """Alarmfilter strenger als die Empfehlung: dann bleibt nichts
        hängen, das ist kein Befund."""
        bands = Settings(
            _env_file=None,
            max_odds_age_seconds=5.0,
            min_confidence=90,
            min_bookmakers=8,
        ).threshold_bands()
        assert bands == []

    def test_jedes_band_nennt_beide_stellschrauben(self):
        bands = Settings(
            _env_file=None, max_odds_age_seconds=60.0, min_confidence=50, min_bookmakers=2
        ).threshold_bands()
        assert len(bands) == 3
        for band in bands:
            assert band.count("_") >= 2, f"nennt nicht beide Variablen: {band}"


class TestQuotenalterJeWelt:
    """Eine Altersgrenze für beide Welten ist zwangsläufig für eine falsch.

    Live ist eine 60 Sekunden alte Quote fraglich - dort ändern sich Preise
    im Sekundentakt. Vor dem Anpfiff ist sie völlig normal: der Abruf läuft
    dort ohnehin nur jede Minute, jede Prematch-Quote ist also älter als die
    Live-Grenze von 15 Sekunden. Mit einer gemeinsamen Grenze käme vor dem
    Anpfiff nie etwas durch.
    """

    def _alarm(self, status, odds_age):
        return Alert(
            kind=AlertKind.VALUE,
            event=make_event(status=status),
            market=OVER_UNDER_25,
            selection=OVER,
            bookmaker="b1",
            odds=2.30,
            fair_odds=2.10,
            value_percent=9.4,
            deviation_percent=9.4,
            confidence=80,
            error_score=80,
            bookmaker_count=6,
            odds_age=odds_age,
        )

    def test_live_verwirft_eine_alte_quote(self):
        rec = evaluate(self._alarm(EventStatus.LIVE, 60.0), RecommendationConfig())
        assert rec.reason_code == "quote_zu_alt"

    def test_prematch_nimmt_dieselbe_quote_an(self):
        rec = evaluate(self._alarm(EventStatus.PRE_MATCH, 60.0), RecommendationConfig())
        assert rec.reason_code != "quote_zu_alt"

    def test_auch_prematch_hat_eine_grenze(self):
        """Irgendwann ist auch vor dem Anpfiff Schluss - sonst wäre die
        Prüfung keine."""
        rec = evaluate(self._alarm(EventStatus.PRE_MATCH, 9999.0), RecommendationConfig())
        assert rec.reason_code == "quote_zu_alt"


class TestZeithorizont:
    """„Guck nach den Spielen von heute" ist kein Komfortwunsch.

    Der Prematch-Abruf fragt "alles, was nicht beendet ist" - das schließt
    Spiele in zwei Wochen ein. Bei zwei Seiten à 100 Events können die
    Spiele von heute dabei schlicht nie ankommen, und niemand merkt es: die
    Liste ist ja voll. Ein Preis für übernächsten Samstag ist ohnehin
    wertlos, weil er bis dahin zehnmal anders steht.
    """

    @staticmethod
    def _provider(stunden: float):
        from backend.providers.sportsgameodds import SportsGameOddsProvider

        return SportsGameOddsProvider(api_key="k" * 32, horizon_hours=stunden)

    @staticmethod
    def _event(stunden: float | None, status=EventStatus.PRE_MATCH):
        event = make_event(status=status)
        event.start_time = (
            datetime.now(UTC) + timedelta(hours=stunden) if stunden is not None else None
        )
        return event

    @pytest.mark.parametrize("stunden", [0.5, 6, 18, 23.5])
    def test_heute_wird_genommen(self, stunden):
        assert not self._provider(24.0)._zu_weit_weg(self._event(stunden))

    @pytest.mark.parametrize("stunden", [30, 72, 14 * 24])
    def test_spaeter_faellt_raus(self, stunden):
        assert self._provider(24.0)._zu_weit_weg(self._event(stunden))

    def test_ohne_anstosszeit_wird_nichts_weggeworfen(self):
        """Ein Event wegen einer fehlenden Angabe zu verwerfen wäre
        schlimmer, als es mitzunehmen."""
        assert not self._provider(24.0)._zu_weit_weg(self._event(None))

    def test_laufende_spiele_sind_nie_zu_weit(self):
        """Ihr Anpfiff liegt hinter ihnen - eine Zukunftsgrenze darf sie
        nicht treffen."""
        assert not self._provider(24.0)._zu_weit_weg(self._event(-1.0, status=EventStatus.LIVE))

    def test_null_heisst_ohne_grenze(self):
        assert not self._provider(0.0)._zu_weit_weg(self._event(14 * 24))

    def test_der_prematch_strom_bekommt_den_horizont(self):
        providers = build_providers(
            Settings(
                _env_file=None,
                providers="sportsgameodds",
                sgo_api_key="k" * 32,
                prematch_enabled=True,
                prematch_horizon_hours=12.0,
            )
        )
        assert providers[1].horizon_hours == 12.0
        # Der Live-Strom bleibt ohne Grenze - dort sind alle Spiele "jetzt".
        assert providers[0].horizon_hours == 0.0
