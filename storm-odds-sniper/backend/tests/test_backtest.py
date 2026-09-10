"""Prüft die Prüfung.

Die Auswertung soll zwei Dinge können: einen echten Unterschied zeigen, und
bei dünner Datenlage den Mund halten. Das zweite ist wichtiger - eine Zahl
aus fünf Alarmen sieht aus wie Erkenntnis und ist Rauschen.
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest

from backend.core.backtest import (
    HEAD_TO_HEAD,
    Sample,
    analyse,
    sample_from,
    threshold_curve,
)
from backend.core.recommendation import Grade, evaluate
from backend.tests.test_recommendation import make_alert

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "backtest.py"


def load_script():
    spec = importlib.util.spec_from_file_location("backtest_script", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def s(grade, *, credible=3.0, raw=11.0, clv=5.0):
    return Sample(grade=grade, credible_edge=credible, raw_edge=raw, clv_percent=clv)


class TestGradeTrennt:
    def test_gruppen_werden_getrennt_ausgewiesen(self):
        rows = [s("strong", clv=8.0)] * 25 + [s("skip", clv=-3.0, credible=0.0)] * 25
        ergebnis = analyse(rows)
        nach_grad = {g.grade: g for g in ergebnis.groups}
        assert nach_grad["strong"].avg_clv_percent == pytest.approx(8.0)
        assert nach_grad["skip"].avg_clv_percent == pytest.approx(-3.0)
        assert ergebnis.separates is True

    def test_kein_unterschied_wird_auch_so_gesagt(self):
        rows = [s("strong", clv=1.0)] * 25 + [s("skip", clv=4.0, credible=0.0)] * 25
        assert analyse(rows).separates is False

    def test_ohne_genug_daten_kein_urteil(self):
        """Fünf Alarme je Seite sind kein Beleg."""
        rows = [s("strong", clv=9.0)] * 5 + [s("skip", clv=-9.0)] * 5
        ergebnis = analyse(rows)
        assert ergebnis.separates is None
        assert any("fehlen Daten" in note for note in ergebnis.notes)

    def test_offene_alarme_zaehlen_in_keinen_mittelwert(self):
        rows = [s("strong", clv=6.0)] * 3 + [s("strong", clv=None)] * 7
        gruppe = analyse(rows).groups[0]
        assert gruppe.count == 10
        assert gruppe.scored == 3
        assert gruppe.avg_clv_percent == pytest.approx(6.0)
        assert gruppe.reliable is False

    def test_trefferanteil_gegen_den_markt(self):
        rows = [s("strong", clv=5.0)] * 3 + [s("strong", clv=-5.0)]
        gruppe = analyse(rows).groups[0]
        assert gruppe.beat_close == 3
        assert gruppe.beat_close_share == pytest.approx(75.0)


class TestKopfAnKopf:
    """Die eigentliche Streitfrage: schrumpfen oder nach Value sortieren?"""

    @staticmethod
    def _welt(schrumpfung_gewinnt: bool):
        """Alarme, bei denen der glaubwürdige Vorteil das Gegenteil des
        gemeldeten Value ordnet - so trennt der Vergleich überhaupt."""
        rows = []
        for _ in range(HEAD_TO_HEAD):
            # Maßvolle Alarme: kleiner Rohwert, hoher glaubwürdiger Vorteil.
            rows.append(
                Sample(
                    grade="moderate",
                    credible_edge=5.0,
                    raw_edge=11.0,
                    clv_percent=8.0 if schrumpfung_gewinnt else -4.0,
                    verdict="corrected" if schrumpfung_gewinnt else "market_followed",
                )
            )
        for _ in range(HEAD_TO_HEAD):
            # Ausreißer: riesiger Rohwert, geschrumpft auf fast nichts.
            rows.append(
                Sample(
                    grade="skip",
                    credible_edge=0.1,
                    raw_edge=200.0,
                    clv_percent=-4.0 if schrumpfung_gewinnt else 8.0,
                    verdict="market_followed" if schrumpfung_gewinnt else "corrected",
                )
            )
        return rows

    def test_schrumpfung_gewinnt_wird_erkannt(self):
        ergebnis = analyse(self._welt(True))
        duell = ergebnis.head_to_head
        assert duell.credible_median_clv == pytest.approx(8.0)
        assert duell.raw_median_clv == pytest.approx(-4.0)
        assert duell.difference > 0
        assert "liegt vorn" in duell.verdict

    def test_schrumpfung_verliert_wird_ebenso_erkannt(self):
        """Der Test muss auch das Gegenteil zeigen können - sonst prüft er
        nichts, sondern bestätigt nur."""
        duell = analyse(self._welt(False)).head_to_head
        assert duell.difference < 0
        assert "zurück" in duell.verdict
        # Verliert die Schrumpfung AUCH beim unabhängigen Maß, ist das der
        # ernste Fall - und nur dann darf die Einstellung angezweifelt werden.
        assert duell.corrected_difference < 0
        assert "PLAUSIBLE_EDGE_PERCENT" in duell.verdict

    def test_bei_duenner_lage_kein_urteil(self):
        duell = analyse([s("strong", clv=9.0)] * 4).head_to_head
        assert duell.reliable is False
        assert "Noch keine Aussage" in duell.verdict

    def test_ueberschneidung_wird_ausgewiesen(self):
        """Sortieren beide Seiten dieselben Alarme nach oben, sagt der
        Vergleich wenig - das muss man sehen."""
        rows = [
            Sample(grade="strong", credible_edge=float(i), raw_edge=float(i), clv_percent=1.0)
            for i in range(40)
        ]
        duell = analyse(rows).head_to_head
        assert duell.overlap == duell.n

    def test_kleiner_unterschied_gilt_nicht_als_beleg(self):
        rows = []
        for _ in range(HEAD_TO_HEAD):
            rows.append(Sample(grade="moderate", credible_edge=5.0, raw_edge=11.0, clv_percent=3.4))
            rows.append(Sample(grade="skip", credible_edge=0.1, raw_edge=200.0, clv_percent=3.0))
        duell = analyse(rows).head_to_head
        assert abs(duell.difference) < 1.0
        assert "Kein nennenswerter Unterschied" in duell.verdict


class TestOhneNachkontrolle:
    def test_ohne_clv_sagt_die_auswertung_warum(self):
        ergebnis = analyse([s("strong", clv=None)] * 50)
        assert ergebnis.scored == 0
        assert any("FOLLOWUP_ENABLED" in note for note in ergebnis.notes)
        assert ergebnis.separates is None

    def test_leere_eingabe_stuerzt_nicht_ab(self):
        ergebnis = analyse([])
        assert ergebnis.total == 0
        assert ergebnis.to_json()["groups"] == []


class TestAusEinerEchtenEmpfehlung:
    def test_probe_uebernimmt_grad_und_beide_vorteile(self):
        alert = make_alert(11.0)
        empfehlung = evaluate(alert)
        probe = sample_from(empfehlung, clv_percent=4.0)
        assert probe.grade == empfehlung.grade.value
        assert probe.raw_edge == pytest.approx(11.0)
        assert probe.credible_edge < probe.raw_edge
        assert probe.clv_percent == 4.0

    def test_verworfener_alarm_kommt_als_skip_an(self):
        probe = sample_from(evaluate(make_alert(250.0)), clv_percent=None)
        assert probe.grade == Grade.SKIP.value
        assert probe.clv_percent is None


class TestMeldetDenEchtenFehler:
    """Was schiefging, muss dastehen - nicht das, was zufällig danach kommt.

    Die .env gehört auf einem Server meist root. Lief das Skript als anderer
    Benutzer, scheiterte schon das Einlesen der Einstellungen - gemeldet wurde
    aber „Datenbank nicht erreichbar". Damit sucht man am falschen Ende: an
    Netz, Passwort und Container, während die Datenbank nie im Spiel war.
    """

    @pytest.fixture(scope="class")
    def script(self):
        return load_script()

    def _lauf(self, script, monkeypatch, capsys, *, fehler, wo):
        monkeypatch.setattr(script.sys, "argv", ["backtest.py", "--days", "7"])
        if wo == "settings":
            monkeypatch.setattr(script, "get_settings", lambda: (_ for _ in ()).throw(fehler))
        else:
            monkeypatch.setattr(script, "get_settings", lambda: object())

            async def kaputt(*_args, **_kwargs):
                raise fehler

            monkeypatch.setattr(script, "sammeln", kaputt)
        code = asyncio.run(script.main())
        return code, capsys.readouterr().err

    def test_rechtefehler_an_der_env_ist_kein_datenbankfehler(self, script, monkeypatch, capsys):
        code, err = self._lauf(
            script,
            monkeypatch,
            capsys,
            fehler=PermissionError(13, "Permission denied", ".env"),
            wo="settings",
        )
        assert code == 1
        assert "Einstellungen nicht lesbar" in err
        assert "Datenbank nicht erreichbar" not in err
        # Und der Ausweg steht dabei, sonst hilft die Diagnose niemandem.
        assert "root" in err

    def test_echter_datenbankfehler_heisst_weiterhin_so(self, script, monkeypatch, capsys):
        code, err = self._lauf(
            script,
            monkeypatch,
            capsys,
            fehler=OSError("connection refused"),
            wo="datenbank",
        )
        assert code == 1
        assert "Datenbank nicht erreichbar" in err
        assert "Einstellungen nicht lesbar" not in err


class TestKaputteReferenzen:
    """Der erste Lauf gegen echte Daten lieferte für die verworfenen Alarme
    einen mittleren CLV von +92 % und für die Value-Auswahl +768 %. Solche
    Zahlen sind keine Vorteile, sondern zusammengebrochene faire Quoten. Die
    Auswertung darf sich davon nicht umwerfen lassen."""

    def _mit_ausreissern(self, n_normal: int, n_extrem: int, grade: str) -> list[Sample]:
        rows = [s(grade, clv=2.0, credible=3.0, raw=11.0) for _ in range(n_normal)]
        rows += [s(grade, clv=900.0, credible=0.1, raw=400.0) for _ in range(n_extrem)]
        return rows

    def test_median_bleibt_stehen_wo_der_mittelwert_kippt(self):
        rows = self._mit_ausreissern(40, 5, "skip")
        gruppe = analyse(rows).groups[0]
        assert gruppe.median_clv_percent == pytest.approx(2.0)
        # Der Mittelwert wird von fünf Zeilen aus dem Fenster getragen.
        assert gruppe.avg_clv_percent > 90.0
        assert gruppe.extreme == 5

    def test_ausreisser_werden_gezaehlt_und_benannt(self):
        ergebnis = analyse(self._mit_ausreissern(40, 5, "skip"))
        assert ergebnis.extreme == 5
        assert any("zusammengebrochene" in note for note in ergebnis.notes)

    def test_trennung_entscheidet_ueber_den_median(self):
        """Verworfene Alarme mit ein paar Fantasie-CLV dürfen die Trennung
        nicht umdrehen - genau das ist am 10.09. passiert."""
        spielbar = [s("strong", clv=6.0) for _ in range(30)]
        verworfen = self._mit_ausreissern(30, 8, "skip")
        ergebnis = analyse(spielbar + verworfen)
        # Über den Mittelwert wäre "verworfen" scheinbar besser gewesen.
        skip = next(g for g in ergebnis.groups if g.grade == "skip")
        assert skip.avg_clv_percent > 6.0
        assert skip.median_clv_percent < 6.0
        assert ergebnis.separates is True

    def test_value_auswahl_voller_ausreisser_ist_kein_urteil(self):
        """Besteht die Value-Auswahl überwiegend aus kaputten Referenzen,
        vergleicht der Kopf-an-Kopf nichts Sinnvolles - und sagt das."""
        rows = [s("strong", clv=5.0, credible=9.0, raw=9.0) for _ in range(30)]
        rows += [s("skip", clv=2000.0, credible=0.1, raw=500.0) for _ in range(30)]
        duell = analyse(rows).head_to_head
        assert duell.raw_extreme > duell.n / 2
        assert "Nicht auswertbar" in duell.verdict

    def test_unabhaengiges_mass_entscheidet_bei_befangenem_clv(self):
        """CLV spricht für die Value-Auswahl, das Urteil für die Schrumpfung.
        Dann muss der Satz beides nennen und darf nicht kippen."""
        rows = [
            Sample(
                grade="strong",
                credible_edge=20.0,
                raw_edge=9.0,
                clv_percent=1.0,
                verdict="corrected",
            )
            for _ in range(25)
        ]
        rows += [
            Sample(
                grade="skip",
                credible_edge=0.1,
                raw_edge=300.0,
                clv_percent=40.0,
                verdict="market_followed",
            )
            for _ in range(25)
        ]
        duell = analyse(rows).head_to_head
        assert duell.difference < 0
        assert duell.corrected_difference > 0
        assert "befangener Vergleich" in duell.verdict
        assert "unabhängigen Maß liegt die Schrumpfung vorn" in duell.verdict


class TestGenauigkeitskurve:
    """„Mach die Prognosen zu 85 % richtig" hat keine Antwort im Code.

    Es hat eine in den Daten: bei welcher Strenge wie oft richtig, und wie
    viele Gelegenheiten davon übrig bleiben. Beides gehört nebeneinander -
    und dazu die Quote, ohne die eine Trefferquote nichts bedeutet.
    """

    def test_mehr_strenge_laesst_weniger_uebrig(self):
        proben = [
            Sample(grade="strong", credible_edge=float(i), raw_edge=11.0, clv_percent=1.0)
            for i in range(10)
        ]
        kurve = {p.min_edge: p.kept for p in threshold_curve(proben, [0.0, 3.0, 8.0])}
        assert kurve[0.0] == 10
        assert kurve[3.0] == 7
        assert kurve[8.0] == 2

    def test_hohe_trefferquote_bei_niedriger_quote_ist_kein_vorteil(self):
        """Der Kern der Sache: 85 % klingt gut und ist bei Quote 1.15 ein
        Verlustgeschäft - dort wären 87 % nötig, nur um bei null zu landen."""
        proben = [
            Sample(
                grade="strong",
                credible_edge=5.0,
                raw_edge=5.0,
                clv_percent=1.0 if i < 85 else -1.0,
                odds=1.15,
            )
            for i in range(100)
        ]
        punkt = threshold_curve(proben, [0.0])[0]
        assert punkt.beat_share == pytest.approx(85.0)
        assert punkt.needed_share == pytest.approx(86.96, abs=0.1)
        # Erreicht liegt UNTER nötig - trotz 85 %.
        assert punkt.beat_share < punkt.needed_share

    def test_niedrigere_trefferquote_bei_hoher_quote_ist_einer(self):
        proben = [
            Sample(
                grade="strong",
                credible_edge=5.0,
                raw_edge=5.0,
                clv_percent=1.0 if i < 40 else -1.0,
                odds=3.00,
            )
            for i in range(100)
        ]
        punkt = threshold_curve(proben, [0.0])[0]
        assert punkt.beat_share == pytest.approx(40.0)
        assert punkt.needed_share == pytest.approx(33.33, abs=0.1)
        assert punkt.beat_share > punkt.needed_share

    def test_ohne_quote_keine_erfundene_schwelle(self):
        proben = [s("strong", clv=2.0) for _ in range(30)]
        punkt = threshold_curve(proben, [0.0])[0]
        assert punkt.avg_odds is None
        assert punkt.needed_share is None

    def test_duenne_stufe_wird_als_solche_ausgewiesen(self):
        proben = [
            Sample(grade="strong", credible_edge=9.0, raw_edge=9.0, clv_percent=1.0, odds=2.0)
            for _ in range(3)
        ]
        punkt = threshold_curve(proben, [8.0])[0]
        assert punkt.kept == 3
        assert punkt.reliable is False
