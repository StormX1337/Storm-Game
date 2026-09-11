"""Wenn die Quelle verstummt, sieht das aus wie ein ruhiger Markt.

Der Fall ist auf einem echten Server passiert: Scanner lief, Dashboard lief,
es kamen nur keine Daten mehr. Gemerkt wurde es erst, weil zufällig auch das
Dashboard nicht erreichbar war. Wäre nur die Quelle ausgefallen, hätte man
stundenlang auf Alarme gewartet, die nicht kommen konnten.

Das Schwierige daran ist nicht das Melden, sondern das Nicht-Melden: nachts
um vier liefert ein völlig gesunder Abruf null Events. Daraus einen Ausfall
zu machen wäre ein Fehlalarm - und nach dem dritten Fehlalarm schaltet man
stumm, womit auch der echte nichts mehr nützt.
"""

from __future__ import annotations

import pytest

from backend.models.domain import now_ts
from backend.providers.base import OddsProvider
from backend.scanner.engine import ScannerEngine
from backend.telegram import formatting as fmt
from backend.tests.test_scanner import scanner_settings


class Stumm(OddsProvider):
    """Eine Quelle, deren letzte Lieferung sich frei stellen lässt."""

    name = "testquelle"
    supports_streaming = False

    def next_poll_delay(self) -> float:
        return 5.0

    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def get_events(self):
        return []

    async def get_odds(self, events):
        return []


@pytest.fixture
def quelle():
    return Stumm()


@pytest.fixture
def engine(redis_state, quelle):
    return ScannerEngine(
        scanner_settings(silence_alert_seconds=60),
        state=redis_state,
        repository=None,
        providers=[quelle],
    )


async def _meldungen(engine, redis_state, quelle, *, vor_sekunden: float, runden: int = 1):
    quelle.health.last_message_at = now_ts() - vor_sekunden
    for _ in range(runden):
        await engine._pruefe_stille()
    return engine._stille


class TestKeinFehlalarm:
    async def test_gesunde_quelle_ohne_events_meldet_nichts(self, engine, redis_state, quelle):
        """Nachts um vier liefert ein gesunder Abruf null Events. Das ist
        kein Ausfall - und der wichtigste Fall von allen."""
        assert await _meldungen(engine, redis_state, quelle, vor_sekunden=1) == set()

    async def test_kurze_luecke_reicht_nicht(self, engine, redis_state, quelle):
        assert await _meldungen(engine, redis_state, quelle, vor_sekunden=30) == set()

    async def test_grenze_liegt_nie_unter_dem_dreifachen_polltakt(self, redis_state):
        """Wer die Grenze knapper stellt, als die Quelle liefern kann,
        bekäme eine Dauermeldung über einen Ausfall, den es nicht gibt."""
        quelle = Stumm()
        engine = ScannerEngine(
            scanner_settings(silence_alert_seconds=1),
            state=redis_state,
            repository=None,
            providers=[quelle],
        )
        # 5 s Takt -> Grenze mindestens 15 s. Nach 10 s ist nichts zu melden.
        quelle.health.last_message_at = now_ts() - 10
        await engine._pruefe_stille()
        assert engine._stille == set()


class TestMeldung:
    async def test_laengere_stille_wird_gemeldet(self, engine, redis_state, quelle):
        assert await _meldungen(engine, redis_state, quelle, vor_sekunden=120) == {"testquelle"}

    async def test_keine_dauermeldung(self, engine, redis_state, quelle):
        """Der Health-Takt läuft alle paar Sekunden - ohne Gedächtnis käme
        die Meldung im Dauerfeuer."""
        await _meldungen(engine, redis_state, quelle, vor_sekunden=120, runden=6)
        assert engine._stille == {"testquelle"}

    async def test_entwarnung_wenn_sie_wieder_liefert(self, engine, redis_state, quelle):
        await _meldungen(engine, redis_state, quelle, vor_sekunden=120)
        assert await _meldungen(engine, redis_state, quelle, vor_sekunden=0) == set()

    async def test_abschaltbar(self, redis_state):
        quelle = Stumm()
        engine = ScannerEngine(
            scanner_settings(silence_alert_enabled=False, silence_alert_seconds=60),
            state=redis_state,
            repository=None,
            providers=[quelle],
        )
        quelle.health.last_message_at = now_ts() - 9999
        await engine._pruefe_stille()
        assert engine._stille == set()

    async def test_ohne_quellen_passiert_nichts(self, redis_state):
        engine = ScannerEngine(scanner_settings(), state=redis_state, repository=None, providers=[])
        await engine._pruefe_stille()
        assert engine._stille == set()


class TestNachricht:
    def test_stille_nennt_dauer_und_naechsten_schritt(self):
        text = fmt.format_system_notice(
            {"kind": "silence", "provider": "sportsgameodds", "seconds": 420}
        )
        assert "VERSTUMMT" in text
        assert "7 Minuten" in text
        assert "diagnose.sh" in text
        # Der entscheidende Satz: es sieht nach ruhigem Markt aus.
        assert "ruhiger Markt" in text

    def test_entwarnung_verschweigt_die_luecke_nicht(self):
        text = fmt.format_system_notice({"kind": "silence_over", "provider": "sportsgameodds"})
        assert "liefert wieder" in text
        assert "nicht gesehen" in text

    def test_html_wird_maskiert(self):
        text = fmt.format_system_notice(
            {"kind": "silence", "provider": "<script>x</script>", "seconds": 60}
        )
        assert "<script>" not in text
