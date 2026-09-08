"""Nachkontrolle im laufenden System.

Hier geht es nicht mehr um die Rechenregel (die steht in ``test_verdict.py``),
sondern um den Weg: Alarm -> Vormerkung in Redis -> spätere Auswertung gegen
den echten Marktzustand -> Eintrag in der Datenbank -> Trefferbilanz.
"""

from __future__ import annotations

import pytest

from backend.core.config import Settings
from backend.core.verdict import Verdict
from backend.database.tables import AlertRow
from backend.models.domain import now_ts
from backend.scanner.engine import ScannerEngine
from backend.tests.test_scanner import market_message


def followup_settings(**overrides) -> Settings:
    base = {
        "_env_file": None,
        "providers": "sportsgameodds",
        "min_value_percent": 10.0,
        "min_outlier_percent": 15.0,
        "min_bookmakers": 3,
        "min_odds": 1.5,
        "max_odds_age_seconds": 30.0,
        "alert_cooldown_seconds": 60,
        "min_confidence": 40,
        "min_error_score": 40,
        "move_alerts_enabled": False,
        "followup_after_seconds": 60.0,
        "odds_state_ttl_seconds": 900,
    }
    base.update(overrides)
    return Settings(**base)


async def fire_alert(engine, *, outlier: float = 3.80):
    """Einen Fixed-Odds-Alarm erzeugen und zurückgeben."""
    prices = {"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42}
    await engine.handle_message(market_message(prices))
    alerts = await engine.handle_message(market_message({**prices, "off": outlier}))
    hits = [a for a in alerts if a.bookmaker == "off"]
    assert hits, "Testaufbau erzeugt keinen Alarm"
    return hits[0]


class TestVormerkung:
    async def test_alarm_wird_zur_nachkontrolle_vorgemerkt(self, redis_state):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        await fire_alert(engine)
        assert await redis_state.pending_followups() == 1

    async def test_ohne_schalter_wird_nichts_vorgemerkt(self, redis_state):
        engine = ScannerEngine(
            followup_settings(followup_enabled=False),
            state=redis_state,
            repository=None,
            providers=[],
        )
        await fire_alert(engine)
        assert await redis_state.pending_followups() == 0

    async def test_noch_nicht_faellige_alarme_bleiben_liegen(self, redis_state):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        await fire_alert(engine)
        assert await engine.run_followups() == []
        assert await redis_state.pending_followups() == 1

    async def test_jeder_alarm_wird_nur_einmal_ausgewertet(self, redis_state):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        await fire_alert(engine)
        later = now_ts() + 120
        first = await engine.run_followups(now=later)
        second = await engine.run_followups(now=later)
        assert len(first) == 1
        assert second == []


class TestUrteilAusEchtemMarkt:
    async def test_stehender_preis_gilt_als_unveraendert(self, redis_state):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        await fire_alert(engine)
        results = await engine.run_followups(now=now_ts() + 120)
        assert results[0]["verdict"] == Verdict.HELD.value
        assert results[0]["closing_odds"] == pytest.approx(3.80)

    async def test_gefallener_preis_gilt_als_korrigiert(self, redis_state):
        """Der auffällige Buchmacher zieht nach - genau der gesuchte Fall."""
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        await fire_alert(engine)
        prices = {"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42, "off": 2.48}
        await engine.handle_message(market_message(prices))
        results = await engine.run_followups(now=now_ts() + 120)
        assert results[0]["verdict"] == Verdict.CORRECTED.value
        assert results[0]["clv_percent"] > 0

    async def test_nachgezogener_markt_gilt_nicht_als_treffer(self, redis_state):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        await fire_alert(engine)
        # Der ganze Markt steigt auf das Niveau des gemeldeten Preises.
        prices = {"b1": 3.60, "b2": 3.65, "b3": 3.70, "b4": 3.62, "off": 3.82}
        await engine.handle_message(market_message(prices))
        results = await engine.run_followups(now=now_ts() + 120)
        assert results[0]["verdict"] == Verdict.MARKET_FOLLOWED.value
        assert results[0]["clv_percent"] < 5.0

    async def test_verschwundener_markt_bleibt_offen(self, redis_state):
        """Ist der Zustand abgelaufen, wird kein Urteil erfunden."""
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        alert = await fire_alert(engine)
        await redis_state.client.delete(
            redis_state.line_key(alert.event.event_id, alert.market.key, alert.selection.key)
        )
        results = await engine.run_followups(now=now_ts() + 120)
        assert results[0]["verdict"] == Verdict.UNRESOLVED.value

    async def test_tor_macht_die_nachkontrolle_ungueltig(self, redis_state):
        """Ändert sich der Spielstand, darf nichts verglichen werden."""
        from backend.models.domain import Score

        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        alert = await fire_alert(engine)
        event = engine._events[alert.event.event_id]
        event.score = Score(2, 1)  # Tor gefallen
        await redis_state.set_event(event)

        results = await engine.run_followups(now=now_ts() + 120)
        assert results[0]["verdict"] == Verdict.SUPERSEDED.value
        assert results[0]["clv_percent"] is None

    async def test_unveraenderter_spielstand_wird_bewertet(self, redis_state):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        await fire_alert(engine)
        results = await engine.run_followups(now=now_ts() + 120)
        assert results[0]["verdict"] != Verdict.SUPERSEDED.value

    async def test_urteile_werden_gezaehlt(self, redis_state):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        await fire_alert(engine)
        await engine.run_followups(now=now_ts() + 120)
        await redis_state.add_verdicts(dict(engine._verdicts))
        counts = await redis_state.get_verdicts()
        assert sum(counts.values()) == 1


class TestDatenbank:
    async def test_urteil_landet_am_alarm(self, redis_state, repository):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=repository, providers=[]
        )
        alert = await fire_alert(engine)
        await repository.save_alert(alert)
        await engine.run_followups(now=now_ts() + 120)

        rows = await repository.list_alerts(limit=10)
        stored = next(r for r in rows if r.fingerprint == alert.fingerprint)
        assert stored.verdict == Verdict.HELD.value
        assert stored.status == "resolved"
        assert stored.resolved_at is not None
        assert stored.closing_odds == pytest.approx(3.80)

    async def test_unbekannter_fingerprint_wird_gemeldet(self, repository):
        """Ein Urteil ohne Alarm darf nicht still verschwinden."""
        missing = await repository.resolve_alerts(
            [{"fingerprint": "gibtesnicht", "verdict": "corrected"}]
        )
        assert missing == ["gibtesnicht"]

    async def test_urteil_wartet_auf_den_noch_nicht_geschriebenen_alarm(
        self, redis_state, repository
    ):
        """Der DB-Writer arbeitet gebündelt und kann hinter der Nachkontrolle
        liegen. Das Urteil steht dann vor einer Zeile, die es noch nicht gibt -
        und muss aufgehoben statt verworfen werden."""
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=repository, providers=[]
        )
        alert = await fire_alert(engine)
        # Der Alarm ist absichtlich noch NICHT in der Datenbank.
        await engine.run_followups(now=now_ts() + 120)
        assert alert.fingerprint in engine._unwritten

        # Der Writer holt auf, der nächste Durchlauf schreibt das Urteil nach.
        await repository.save_alert(alert)
        await engine.run_followups(now=now_ts() + 130)
        assert engine._unwritten == {}

        rows = await repository.list_alerts(limit=10)
        stored = next(r for r in rows if r.fingerprint == alert.fingerprint)
        assert stored.verdict is not None

    async def test_aussichtslose_urteile_werden_irgendwann_aufgegeben(
        self, redis_state, repository
    ):
        """Der Puffer darf bei einem dauerhaft fehlenden Alarm nicht wachsen."""
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=repository, providers=[]
        )
        await fire_alert(engine)
        for tick in range(ScannerEngine.WRITE_ATTEMPTS + 1):
            await engine.run_followups(now=now_ts() + 120 + tick)
        assert engine._unwritten == {}

    async def test_bilanz_trennt_offen_und_ausgewertet(self, redis_state, repository):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=repository, providers=[]
        )
        alert = await fire_alert(engine)
        await repository.save_alert(alert)

        before = await repository.scorecard()
        assert before["pending"] == 1
        assert before["resolved"] == 0

        await engine.run_followups(now=now_ts() + 120)
        after = await repository.scorecard()
        assert after["pending"] == 0
        assert after["resolved"] == 1
        assert after["verdicts"][Verdict.HELD.value] == 1

    async def test_durchschnitt_je_alarmart_umfasst_alle_urteile(self, repository):
        """Der Wert je Art darf nicht der einer einzelnen Urteilsgruppe sein."""
        from backend.tests.test_database import make_alert

        alerts = [
            make_alert(bookmaker="a", odds=4.20),
            make_alert(bookmaker="b", odds=4.30),
            make_alert(bookmaker="c", odds=4.40),
        ]
        await repository.write_batch(alerts=alerts)
        await repository.resolve_alerts(
            [
                {"fingerprint": alerts[0].fingerprint, "verdict": "corrected", "clv_percent": 30.0},
                {"fingerprint": alerts[1].fingerprint, "verdict": "corrected", "clv_percent": 20.0},
                {
                    "fingerprint": alerts[2].fingerprint,
                    "verdict": "market_followed",
                    "clv_percent": -50.0,
                },
            ]
        )
        data = await repository.scorecard()
        # (30 + 20 - 50) / 3 = 0.0 - nicht -50.0 (nur market_followed)
        # und nicht 25.0 (nur corrected).
        assert data["by_kind"]["fixed_error"]["avg_clv_percent"] == pytest.approx(0.0)
        assert data["by_kind"]["fixed_error"]["scored"] == 3
        assert data["avg_clv_percent"] == pytest.approx(0.0)

    async def test_offene_alarme_verfaelschen_den_durchschnitt_nicht(self, repository):
        from backend.tests.test_database import make_alert

        alerts = [make_alert(bookmaker="a", odds=4.20), make_alert(bookmaker="b", odds=4.30)]
        await repository.write_batch(alerts=alerts)
        await repository.resolve_alerts(
            [{"fingerprint": alerts[0].fingerprint, "verdict": "corrected", "clv_percent": 10.0}]
        )
        data = await repository.scorecard()
        assert data["by_kind"]["fixed_error"]["avg_clv_percent"] == pytest.approx(10.0)
        assert data["by_kind"]["fixed_error"]["scored"] == 1
        assert data["by_kind"]["fixed_error"]["total"] == 2

    async def test_bilanz_ohne_daten_wirft_nicht(self, repository):
        data = await repository.scorecard()
        assert data["resolved"] == 0
        assert data["avg_clv_percent"] is None
        assert data["beat_close_share"] is None

    async def test_clv_geht_in_die_bilanz_ein(self, redis_state, repository):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=repository, providers=[]
        )
        alert = await fire_alert(engine)
        await repository.save_alert(alert)
        await engine.run_followups(now=now_ts() + 120)
        data = await repository.scorecard()
        assert data["scored"] == 1
        assert data["avg_clv_percent"] > 0
        assert data["beat_close"] == 1
        assert data["beat_close_share"] == 100.0
        assert data["by_bookmaker"][0]["bookmaker"] == "off"


class TestKonfigurationswarnung:
    async def test_nachkontrolle_nach_ttl_wird_gemeldet(self, redis_state, capsys):
        """Eine Nachkontrolle nach Ablauf des Zustands könnte nie urteilen."""
        engine = ScannerEngine(
            followup_settings(followup_after_seconds=1200.0, odds_state_ttl_seconds=900),
            state=redis_state,
            repository=None,
            providers=[],
        )
        engine._warn_about_self_defeating_config()
        assert "Nachkontrolle" in capsys.readouterr().out

    async def test_sinnvolle_konfiguration_schweigt(self, redis_state, capsys):
        engine = ScannerEngine(
            followup_settings(), state=redis_state, repository=None, providers=[]
        )
        engine._warn_about_self_defeating_config()
        assert "Nachkontrolle" not in capsys.readouterr().out


class TestAufraeumen:
    async def test_alte_alarme_verlieren_ihre_urteile_mit(self, repository):
        """Die Nachkontrolle hängt am Alarm - sie darf nichts überleben."""
        await repository.prune(snapshot_days=0, alert_days=0)
        async with repository.session_factory() as session:
            from sqlalchemy import func, select

            count = (await session.execute(select(func.count(AlertRow.id)))).scalar_one()
        assert count == 0
