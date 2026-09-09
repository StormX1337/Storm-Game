"""Wett-Tagebuch: Abrechnung und Bilanz.

Die Trefferbilanz misst, ob die *Alarme* etwas taugten. Hier geht es um die
andere Frage - hat es Geld gebracht? Der wichtigste Fall ist der annullierte
Einsatz: er darf weder als Treffer noch als Fehlschlag zählen und auch nicht
in den riskierten Einsatz, sonst sieht jede Rendite besser aus als sie war.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.core.betlog import (
    MIN_SETTLED,
    STATUS_ICONS,
    STATUS_LABELS,
    BetStatus,
    settle_profit,
    stake_from_recommendation,
    summarise,
)


def bet(status="won", *, stake=10.0, odds=2.50, profit=None, edge=None):
    return SimpleNamespace(
        status=status,
        stake=stake,
        odds=odds,
        profit=profit if profit is not None else settle_profit(status, stake=stake, odds=odds),
        expected_edge_percent=edge,
    )


class TestAbrechnung:
    def test_gewonnen_bringt_den_nettogewinn(self):
        """10 zu 2.50: zurück kommen 25, verdient sind 15."""
        assert settle_profit("won", stake=10.0, odds=2.50) == pytest.approx(15.0)

    def test_verloren_kostet_den_einsatz(self):
        assert settle_profit("lost", stake=10.0, odds=2.50) == pytest.approx(-10.0)

    def test_annulliert_ist_exakt_null(self):
        assert settle_profit("void", stake=10.0, odds=2.50) == 0.0

    def test_offen_hat_kein_ergebnis(self):
        """``None`` heißt "läuft noch" - nicht "null verdient"."""
        assert settle_profit("open", stake=10.0, odds=2.50) is None

    def test_jeder_ausgang_hat_klartext_und_symbol(self):
        for status in BetStatus:
            assert STATUS_LABELS[status]
            assert STATUS_ICONS[status]


class TestBilanz:
    def test_gewinn_und_rendite(self):
        ledger = summarise([bet("won"), bet("won"), bet("lost")])
        assert ledger.settled == 3
        assert ledger.staked == pytest.approx(30.0)
        assert ledger.profit == pytest.approx(15.0 + 15.0 - 10.0)
        assert ledger.roi_percent == pytest.approx(20.0 / 30.0 * 100.0)
        assert ledger.hit_rate_percent == pytest.approx(2 / 3 * 100.0)

    def test_annullierte_wette_verzerrt_nichts(self):
        ohne = summarise([bet("won"), bet("lost")])
        mit = summarise([bet("won"), bet("lost"), bet("void")])
        assert mit.staked == ohne.staked
        assert mit.profit == ohne.profit
        assert mit.roi_percent == pytest.approx(ohne.roi_percent)
        assert mit.hit_rate_percent == pytest.approx(ohne.hit_rate_percent)
        assert mit.voids == 1
        assert mit.settled == 3

    def test_offene_wetten_zaehlen_in_keine_rendite(self):
        ledger = summarise([bet("won"), bet("open", stake=25.0)])
        assert ledger.open_count == 1
        assert ledger.open_stake == pytest.approx(25.0)
        assert ledger.staked == pytest.approx(10.0)
        assert ledger.settled == 1
        assert any("laufen noch" in note for note in ledger.notes)

    def test_ohne_abgerechnete_wetten_keine_rendite(self):
        ledger = summarise([bet("open"), bet("open")])
        assert ledger.roi_percent is None
        assert ledger.hit_rate_percent is None

    def test_kleine_stichprobe_wird_als_zufall_ausgewiesen(self):
        """Eine Rendite aus fünf Wetten ist keine Rendite."""
        ledger = summarise([bet("won") for _ in range(5)])
        assert ledger.reliable is False
        assert any("Zufall" in note for note in ledger.notes)

    def test_genug_wetten_gilt_als_kennzahl(self):
        ledger = summarise([bet("won") for _ in range(MIN_SETTLED)])
        assert ledger.reliable is True
        assert not any("Zufall" in note for note in ledger.notes)

    def test_vergleich_gegen_die_vorhersage(self):
        """Was die Empfehlung versprach, steht neben dem, was herauskam."""
        ledger = summarise([bet("won", edge=4.0), bet("lost", edge=4.0)])
        assert ledger.expected_profit == pytest.approx(20.0 * 0.04)
        assert ledger.expected_roi_percent == pytest.approx(4.0)
        assert ledger.roi_percent == pytest.approx(25.0)

    def test_fehlender_gewinn_wird_nachgerechnet(self):
        """Alte Zeilen ohne gespeicherten Gewinn dürfen die Bilanz nicht
        stillschweigend auf null ziehen."""
        roh = SimpleNamespace(
            status="won", stake=10.0, odds=3.0, profit=None, expected_edge_percent=None
        )
        assert summarise([roh]).profit == pytest.approx(20.0)

    def test_leere_bilanz_ist_still(self):
        ledger = summarise([])
        assert ledger.to_json()["total"] == 0
        assert ledger.roi_percent is None
        assert ledger.notes == []

    def test_einheit_steht_dabei(self):
        """Ohne Bankroll sind Einsätze Anteile, keine Beträge - das muss
        dranstehen, sonst liest jemand Euro."""
        assert summarise([bet()], unit="% der Bankroll").to_json()["unit"] == "% der Bankroll"


class TestEinsatzAusDerEmpfehlung:
    """Der Prozentsatz ist die dauerhafte Größe, der Betrag nur seine
    Darstellung gegen die aktuelle Bankroll."""

    def test_ohne_bankroll_ist_der_einsatz_ein_anteil(self):
        rec = {"stake_percent": 0.7, "math": {"stake_amount": None}}
        assert stake_from_recommendation(rec, bankroll=0.0) == pytest.approx(0.7)

    def test_mit_bankroll_wird_der_betrag_genommen(self):
        rec = {"stake_percent": 0.7, "math": {"stake_amount": 7.0}}
        assert stake_from_recommendation(rec, bankroll=1000.0) == pytest.approx(7.0)

    def test_bankroll_spaeter_hinterlegt_rechnet_nach(self):
        """Sonst landete ein Prozentwert als Betrag im Tagebuch - genau der
        Fehler, vor dem die Bilanz sonst warnt."""
        rec = {"stake_percent": 0.7, "math": {}}
        assert stake_from_recommendation(rec, bankroll=1000.0) == pytest.approx(7.0)

    def test_ohne_vorschlag_kein_einsatz(self):
        assert stake_from_recommendation({}, bankroll=1000.0) == 0.0
