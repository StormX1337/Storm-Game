"""Nachkontrolle: Urteil und Closing Line Value.

Der Kern ist eine reine Funktion - hier wird sie gegen die Fälle gehalten,
die in der Praxis vorkommen. Der wichtigste Unterschied ist der zwischen
"der Buchmacher hat korrigiert" (echter Fehlpreis) und "der Markt ist
nachgezogen" (nur ein schnelleres Buch, kein Vorteil).
"""

from __future__ import annotations

import pytest

from backend.core.verdict import (
    POSITIVE_VERDICTS,
    VERDICT_LABELS,
    Verdict,
    VerdictConfig,
    resolve,
)


def value_case(**kwargs):
    base = {
        "kind": "fixed_error",
        "alert_odds": 3.80,
        "alert_fair": 2.45,
        "final_price": 3.80,
        "final_fair": 2.45,
    }
    base.update(kwargs)
    return resolve(**base)


class TestKorrektur:
    def test_buchmacher_faellt_allein_gilt_als_korrigiert(self):
        """3.80 -> 2.50, während der Markt steht: der Fehlpreis war echt."""
        result = value_case(final_price=2.50, final_fair=2.47)
        assert result.verdict is Verdict.CORRECTED
        assert result.price_move_percent < 0
        assert result.gap_closed_percent > 0

    def test_korrektur_zaehlt_als_beleg(self):
        assert Verdict.CORRECTED in POSITIVE_VERDICTS
        assert Verdict.MARKET_FOLLOWED not in POSITIVE_VERDICTS

    def test_clv_misst_gegen_den_spaeteren_markt(self):
        """3.80 gemeldet, Markt steht später bei 2.50 -> +52 %."""
        result = value_case(final_price=2.50, final_fair=2.50)
        assert result.clv_percent == pytest.approx((3.80 / 2.50 - 1) * 100, abs=0.01)
        assert result.beat_the_close is True


class TestRichtungSchlaegtBetrag:
    """Wer die Lücke geschlossen hat, entscheidet die *Richtung* - nicht der
    Betrag. Sonst gilt ein Buchmacher als "korrigiert", während der Markt in
    Wahrheit über den gemeldeten Preis hinweggezogen ist."""

    def test_buch_faellt_aber_markt_zieht_darueber_hinweg(self):
        result = resolve(
            kind="value",
            alert_odds=2.50,
            alert_fair=2.30,
            final_price=2.20,
            final_fair=2.55,
        )
        assert result.verdict is Verdict.MARKET_FOLLOWED
        assert result.clv_percent < 0

    def test_buch_faellt_und_vorsprung_bleibt(self):
        result = value_case(final_price=3.00, final_fair=2.70)
        assert result.verdict is Verdict.CORRECTED
        assert result.clv_percent > 0

    @pytest.mark.parametrize(
        ("alert_odds", "alert_fair", "final_price", "final_fair"),
        [
            (2.50, 2.30, 2.20, 2.32),
            (3.80, 2.45, 3.00, 2.70),
            (3.80, 2.45, 2.50, 2.47),
            (2.50, 2.30, 2.20, 2.55),
            (3.80, 2.45, 3.85, 3.70),
            (2.00, 1.90, 1.70, 1.95),
        ],
    )
    def test_korrigiert_heisst_immer_besser_als_der_markt(
        self, alert_odds, alert_fair, final_price, final_fair
    ):
        """Die Zusage des Urteils: ein Treffer schlägt den späteren Markt."""
        result = resolve(
            kind="fixed_error",
            alert_odds=alert_odds,
            alert_fair=alert_fair,
            final_price=final_price,
            final_fair=final_fair,
        )
        if result.verdict is Verdict.CORRECTED:
            assert result.clv_percent > 0, "korrigiert ohne Vorsprung zum Markt"

    def test_gleichlaeufiger_markt_ist_keine_korrektur(self):
        """Fallen Buch und Markt gemeinsam, ist das Nachrichtenlage."""
        result = value_case(final_price=3.42, final_fair=2.20)
        assert result.verdict is Verdict.HELD


class TestMarktFolgt:
    def test_markt_zieht_nach_ist_kein_fehlpreis(self):
        """Der Markt steigt von 2.45 auf 3.70 - das Buch war nur schneller."""
        result = value_case(final_price=3.85, final_fair=3.70)
        assert result.verdict is Verdict.MARKET_FOLLOWED
        assert result.market_move_percent > 0

    def test_markt_folgt_kostet_den_vorteil(self):
        result = value_case(final_price=3.85, final_fair=3.90)
        assert result.clv_percent < 0
        assert result.beat_the_close is False


class TestUnveraendert:
    def test_stillstand_bleibt_offen_bewertet(self):
        result = value_case()
        assert result.verdict is Verdict.HELD
        assert result.clv_percent == pytest.approx(55.1, abs=0.2)

    def test_winzige_bewegung_ist_keine_bewegung(self):
        """Rundung der Buchmacher darf kein Urteil auslösen."""
        result = value_case(final_price=3.79, final_fair=2.45)
        assert result.verdict is Verdict.HELD


class TestSpielstandwechsel:
    """Über ein Tor hinweg lässt sich kein Preis vergleichen. Ohne diese
    Sperre entstehen Fantasiezahlen: beobachtet wurde ein Markt, der von
    43.66 auf 2.71 sprang - gerechnet als "+1677 % Vorteil"."""

    def test_geaenderter_spielstand_erzeugt_kein_urteil(self):
        result = resolve(
            kind="fixed_error",
            alert_odds=48.25,
            alert_fair=43.66,
            final_price=2.69,
            final_fair=2.71,
            state_changed=True,
        )
        assert result.verdict is Verdict.SUPERSEDED
        assert result.clv_percent is None

    def test_ueberholt_zaehlt_nie_als_beleg(self):
        assert Verdict.SUPERSEDED not in POSITIVE_VERDICTS

    def test_ohne_wechsel_wird_normal_bewertet(self):
        result = resolve(
            kind="fixed_error",
            alert_odds=48.25,
            alert_fair=43.66,
            final_price=2.69,
            final_fair=2.71,
            state_changed=False,
        )
        assert result.verdict is not Verdict.SUPERSEDED
        assert result.clv_percent is not None

    def test_gilt_auch_fuer_bewegungsalarme(self):
        result = resolve(
            kind="odds_move",
            alert_odds=2.50,
            alert_fair=2.00,
            final_price=1.20,
            final_fair=None,
            previous_odds=2.00,
            state_changed=True,
        )
        assert result.verdict is Verdict.SUPERSEDED


class TestVerschwundenUndOffen:
    def test_zurueckgezogene_quote(self):
        result = value_case(final_price=None)
        assert result.verdict is Verdict.VANISHED
        assert result.clv_percent is not None

    def test_gesperrte_quote_zaehlt_wie_zurueckgezogen(self):
        result = value_case(final_price=3.80, suspended=True)
        assert result.verdict is Verdict.VANISHED

    def test_ohne_folgedaten_kein_urteil(self):
        result = value_case(final_price=None, final_fair=None)
        assert result.verdict is Verdict.UNRESOLVED
        assert result.clv_percent is None

    def test_ohne_marktkonsens_kein_urteil(self):
        """Der Preis steht noch, aber es gibt nichts mehr zum Vergleichen."""
        result = value_case(final_fair=None)
        assert result.verdict is Verdict.UNRESOLVED

    def test_offen_ist_nie_ein_beleg(self):
        assert Verdict.UNRESOLVED not in POSITIVE_VERDICTS


class TestBewegungsalarme:
    def test_zurueckgelaufene_bewegung(self):
        """2.00 -> 2.50 gemeldet, danach zurück auf 2.05."""
        result = resolve(
            kind="odds_move",
            alert_odds=2.50,
            alert_fair=2.00,
            final_price=2.05,
            final_fair=None,
            previous_odds=2.00,
        )
        assert result.verdict is Verdict.REVERTED
        assert "zurückgelaufen" in result.note

    def test_haltende_bewegung(self):
        result = resolve(
            kind="odds_move",
            alert_odds=2.50,
            alert_fair=2.00,
            final_price=2.48,
            final_fair=None,
            previous_odds=2.00,
        )
        assert result.verdict is Verdict.HELD

    def test_ueber_den_ausgangspunkt_hinaus_bleibt_bei_100_prozent(self):
        """Ein Preis, der am Ausgangswert vorbeischießt, ist nicht 300 % zurück."""
        result = resolve(
            kind="odds_move",
            alert_odds=2.50,
            alert_fair=2.00,
            final_price=1.20,
            final_fair=None,
            previous_odds=2.00,
        )
        assert result.verdict is Verdict.REVERTED
        assert "100 %" in result.note

    def test_weiterlaufende_bewegung_rechnet_nicht_ueber_hundert(self):
        """3.65 -> 3.10 gemeldet, danach 1.90: die Bewegung lief weiter."""
        result = resolve(
            kind="odds_move",
            alert_odds=3.10,
            alert_fair=3.65,
            final_price=1.90,
            final_fair=1.93,
            previous_odds=3.65,
        )
        assert result.verdict is Verdict.HELD
        assert "weitergelaufen" in result.note
        assert "%" not in result.note

    def test_bewegungsalarm_bekommt_keinen_clv(self):
        """Bewegungsalarme haben keine faire Quote - CLV wäre erfunden."""
        result = resolve(
            kind="odds_move",
            alert_odds=2.50,
            alert_fair=2.00,
            final_price=2.48,
            final_fair=2.30,
            previous_odds=2.00,
        )
        assert result.clv_percent is None


class TestRobustheit:
    def test_nullpreise_werfen_nicht(self):
        result = resolve(
            kind="value",
            alert_odds=2.0,
            alert_fair=0.0,
            final_price=2.0,
            final_fair=0.0,
        )
        assert result.verdict in set(Verdict)

    def test_schwelle_ist_einstellbar(self):
        """Mit einer groben Schwelle gilt dieselbe Bewegung als Stillstand."""
        strict = value_case(final_price=3.60, final_fair=2.45)
        lax = value_case(final_price=3.60, final_fair=2.45, config=VerdictConfig(move_percent=20.0))
        assert strict.verdict is Verdict.CORRECTED
        assert lax.verdict is Verdict.HELD

    def test_jedes_urteil_hat_klartext(self):
        for verdict in Verdict:
            assert VERDICT_LABELS[verdict]
            assert " " in VERDICT_LABELS[verdict]

    def test_json_ist_serialisierbar(self):
        import orjson

        payload = value_case(final_price=2.50, final_fair=2.47).to_json()
        assert orjson.loads(orjson.dumps(payload))["verdict"] == "corrected"
