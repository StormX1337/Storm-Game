"""Vor dem Anpfiff ist ein anderer Markt, nicht dieselbe Welt mit Etikett.

Es sind mehr Buchmacher da, alle hatten Tage Zeit, und die Preise stehen
dichter beieinander. Mit den Live-Schwellen käme darum fast nichts durch -
und was durchkäme, wäre eher ein Datenfehler als ein Vorteil. Diese Tests
halten die Trennung fest: eigene Schwellen, eigener Abruf, eigene Ansicht.
"""

from __future__ import annotations

import pytest

from backend.core.config import Settings
from backend.models.domain import Alert
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
