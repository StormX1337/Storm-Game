"""Prüft die Prüfung.

Die Auswertung soll zwei Dinge können: einen echten Unterschied zeigen, und
bei dünner Datenlage den Mund halten. Das zweite ist wichtiger - eine Zahl
aus fünf Alarmen sieht aus wie Erkenntnis und ist Rauschen.
"""

from __future__ import annotations

import pytest

from backend.core.backtest import HEAD_TO_HEAD, Sample, analyse, sample_from
from backend.core.recommendation import Grade, evaluate
from backend.tests.test_recommendation import make_alert


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
                )
            )
        return rows

    def test_schrumpfung_gewinnt_wird_erkannt(self):
        ergebnis = analyse(self._welt(True))
        duell = ergebnis.head_to_head
        assert duell.credible_avg_clv == pytest.approx(8.0)
        assert duell.raw_avg_clv == pytest.approx(-4.0)
        assert duell.difference > 0
        assert "liegt vorn" in duell.verdict

    def test_schrumpfung_verliert_wird_ebenso_erkannt(self):
        """Der Test muss auch das Gegenteil zeigen können - sonst prüft er
        nichts, sondern bestätigt nur."""
        duell = analyse(self._welt(False)).head_to_head
        assert duell.difference < 0
        assert "liegt zurück" in duell.verdict
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
