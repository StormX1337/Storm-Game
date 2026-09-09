"""Empfehlung: was soll man spielen - und mit wie viel?

Die wichtigste Eigenschaft steht in ``TestGrosseZahlGewinntNicht``: eine
riesige gemeldete Abweichung darf **nicht** oben in der Liste landen. Genau
das würde eine naive Sortierung nach Value tun, und genau das wäre der
teuerste Fehler, den dieses Modul machen könnte.
"""

from __future__ import annotations

import pytest

from backend.core.recommendation import (
    GRADE_LABELS,
    PLAYABLE_GRADES,
    REASON_LABELS,
    Grade,
    Recommendation,
    RecommendationConfig,
    build_slip,
    config_from_settings,
    evaluate,
    kelly_stake_percent,
    plausibility_scale,
    plausibility_weight,
    recommend_all,
    reliability_weight,
)
from backend.models.domain import Alert, EventSnapshot, MarketKey, Selection
from backend.models.enums import AlertKind, EventStatus, MarketType, Period, SelectionCode, Sport


def make_alert(
    value: float = 12.0,
    *,
    kind: AlertKind = AlertKind.VALUE,
    odds: float = 2.10,
    confidence: int = 80,
    error_score: int = 0,
    bookmakers: int = 20,
    odds_age: float = 2.0,
    event_id: str = "e1",
    status: EventStatus = EventStatus.LIVE,
    selection: SelectionCode = SelectionCode.OVER,
    line: float = 2.5,
) -> Alert:
    event = EventSnapshot(
        event_id=event_id,
        sport=Sport.FOOTBALL,
        home="Heim",
        away="Gast",
        provider="sportsgameodds",
        provider_event_id=event_id,
        status=status,
    )
    return Alert(
        kind=kind,
        event=event,
        market=MarketKey(MarketType.OVER_UNDER, line, Period.FULL_TIME),
        selection=Selection(selection, "Über 2.5"),
        bookmaker="bet365",
        odds=odds,
        fair_odds=odds / (1.0 + value / 100.0),
        value_percent=value,
        deviation_percent=value,
        confidence=confidence,
        error_score=error_score,
        bookmaker_count=bookmakers,
        odds_age=odds_age,
    )


class TestGrosseZahlGewinntNicht:
    """Der Kern: mehr Abweichung ist ab einem Punkt ein Argument *dagegen*."""

    def test_absurder_value_wird_abgelehnt(self):
        result = evaluate(make_alert(250.0))
        assert result.grade is Grade.SKIP
        assert result.reason_code == "unplausibel"
        assert result.stake_percent == 0.0

    def test_glaubwuerdiger_vorteil_faellt_jenseits_des_maximums_wieder(self):
        """Erst steigend, dann fallend - eine redeszendierende Kurve."""
        edges = [evaluate(make_alert(v)).credible_edge_percent for v in (5, 10, 15, 20, 30)]
        assert edges[1] > edges[0]  # steigend bis zum Maximum
        assert edges[1] > edges[2] > edges[3] > edges[4]  # danach fallend
        assert edges[4] < 0.5

    def test_kleinerer_alarm_schlaegt_den_groesseren(self):
        """+11 % ist eine bessere Wette als +40 % - und muss vorne stehen."""
        klein = evaluate(make_alert(11.0))
        gross = evaluate(make_alert(40.0))
        assert klein.rank_score > gross.rank_score
        assert klein.credible_edge_percent > gross.credible_edge_percent

    def test_liste_sortiert_nicht_nach_rohem_value(self):
        alerts = [
            make_alert(250.0, event_id="absurd"),
            make_alert(45.0, event_id="gross"),
            make_alert(11.0, event_id="massvoll"),
        ]
        slip = recommend_all(alerts)
        assert [pick.alert.event.event_id for pick in slip.picks] == ["massvoll"]
        assert slip.dropped["unplausibel"] == 1

    def test_belegter_fehlpreis_darf_weiter_weg_liegen(self):
        """Ein Fehlpreis mit hohem Error-Score bekommt mehr Spielraum -
        aber auch er wird jenseits jeder Vernunft abgewiesen."""
        value = evaluate(make_alert(22.0, kind=AlertKind.VALUE))
        fehlpreis = evaluate(make_alert(22.0, kind=AlertKind.FIXED_ERROR, error_score=90))
        assert fehlpreis.credible_edge_percent > value.credible_edge_percent
        assert evaluate(make_alert(80.0, kind=AlertKind.FIXED_ERROR, error_score=90)).grade is (
            Grade.SKIP
        )


class TestHarteAusschluesse:
    def test_bewegungsalarm_bekommt_keine_empfehlung(self):
        """Bei ``odds_move`` steht im Feld ``fair_odds`` der Vorpreis, keine
        faire Quote. Daraus einen Vorteil zu rechnen wäre erfunden."""
        result = evaluate(make_alert(30.0, kind=AlertKind.ODDS_MOVE))
        assert result.grade is Grade.SKIP
        assert result.reason_code == "keine_referenz"
        assert result.raw_edge_percent == 0.0

    def test_kein_vorteil_kein_einsatz(self):
        assert evaluate(make_alert(-3.0)).reason_code == "kein_vorteil"

    def test_zu_wenige_buchmacher(self):
        result = evaluate(make_alert(12.0, bookmakers=2))
        assert result.reason_code == "zu_wenige_buchmacher"

    def test_zu_geringe_confidence(self):
        assert evaluate(make_alert(12.0, confidence=40)).reason_code == "confidence_zu_niedrig"

    def test_alte_quote(self):
        assert evaluate(make_alert(12.0, odds_age=60.0)).reason_code == "quote_zu_alt"

    def test_beendetes_event(self):
        result = evaluate(make_alert(12.0, status=EventStatus.FINISHED))
        assert result.reason_code == "markt_gesperrt"

    def test_jeder_ablehnungsgrund_hat_einen_klartext(self):
        for code in REASON_LABELS:
            assert REASON_LABELS[code]
        for grade in Grade:
            assert GRADE_LABELS[grade]


class TestEinsatz:
    def test_kelly_skaliert_mit_dem_vorteil(self):
        klein = kelly_stake_percent(
            odds=2.0, credible_edge_percent=2.0, config=RecommendationConfig()
        )
        gross = kelly_stake_percent(
            odds=2.0, credible_edge_percent=4.0, config=RecommendationConfig()
        )
        assert gross == pytest.approx(2 * klein)

    def test_hohe_quote_bekommt_weniger_einsatz(self):
        """Gleicher Vorteil, längere Quote: Kelly kürzt - zu Recht."""
        kurz = kelly_stake_percent(
            odds=2.0, credible_edge_percent=4.0, config=RecommendationConfig()
        )
        lang = kelly_stake_percent(
            odds=11.0, credible_edge_percent=4.0, config=RecommendationConfig()
        )
        assert lang < kurz

    def test_einsatz_ist_gedeckelt(self):
        config = RecommendationConfig(max_stake_percent=1.0)
        stake = kelly_stake_percent(odds=1.5, credible_edge_percent=50.0, config=config)
        assert stake == 1.0

    def test_viertel_kelly_ist_ein_viertel(self):
        voll = RecommendationConfig(kelly_fraction=1.0, max_stake_percent=100.0)
        viertel = RecommendationConfig(kelly_fraction=0.25, max_stake_percent=100.0)
        assert kelly_stake_percent(
            odds=3.0, credible_edge_percent=6.0, config=viertel
        ) == pytest.approx(
            0.25 * kelly_stake_percent(odds=3.0, credible_edge_percent=6.0, config=voll)
        )

    def test_betrag_nur_mit_hinterlegter_bankroll(self):
        ohne = evaluate(make_alert(11.0))
        assert ohne.stake_amount is None
        assert "Bankroll" in ohne.play

        mit = evaluate(make_alert(11.0), RecommendationConfig(bankroll=1000.0))
        assert mit.stake_amount == pytest.approx(1000.0 * mit.stake_percent / 100.0, abs=0.01)

    def test_einsatz_wird_nie_aus_dem_rohwert_gerechnet(self):
        """Der Einsatz folgt dem glaubwürdigen, nicht dem gemeldeten Vorteil."""
        result = evaluate(make_alert(15.0))
        aus_roh = kelly_stake_percent(
            odds=2.10, credible_edge_percent=15.0, config=RecommendationConfig()
        )
        assert result.stake_percent < aus_roh


class TestAbschlaege:
    def test_mehr_buchmacher_mehr_gewicht(self):
        wenig, _ = reliability_weight(
            bookmaker_count=4, confidence=80, odds_age=1.0, config=RecommendationConfig()
        )
        viel, _ = reliability_weight(
            bookmaker_count=30, confidence=80, odds_age=1.0, config=RecommendationConfig()
        )
        assert viel > wenig

    def test_alte_quote_zaehlt_weniger(self):
        frisch, _ = reliability_weight(
            bookmaker_count=20, confidence=80, odds_age=0.0, config=RecommendationConfig()
        )
        alt, notes = reliability_weight(
            bookmaker_count=20, confidence=80, odds_age=14.0, config=RecommendationConfig()
        )
        assert alt < frisch
        assert any("alt" in note for note in notes)

    def test_plausibilitaet_faellt_monoton(self):
        weights = [plausibility_weight(v, 8.0) for v in (0, 4, 8, 16, 32)]
        assert weights[0] == pytest.approx(1.0)
        assert weights == sorted(weights, reverse=True)
        assert weights[-1] < 0.001

    def test_fehlpreis_skala_waechst_mit_dem_error_score(self):
        config = RecommendationConfig()
        ohne = plausibility_scale(kind=AlertKind.VALUE, error_score=90, config=config)
        schwach = plausibility_scale(kind=AlertKind.FIXED_ERROR, error_score=10, config=config)
        stark = plausibility_scale(kind=AlertKind.FIXED_ERROR, error_score=90, config=config)
        assert ohne == config.plausible_edge_percent
        assert ohne < schwach < stark <= config.max_plausible_edge_percent


class TestListe:
    def test_hoechstens_eine_wette_je_event(self):
        """Zwei Selektionen desselben Spiels hängen zusammen - im Extremfall
        wären es Über *und* Unter."""
        ueber = make_alert(11.0, event_id="e1", selection=SelectionCode.OVER)
        unter = make_alert(11.0, event_id="e1", selection=SelectionCode.UNDER)
        slip = recommend_all([ueber, unter])
        assert len(slip.picks) == 1
        assert slip.dropped["event_belegt"] == 1

    def test_gesamtbudget_wird_eingehalten(self):
        config = RecommendationConfig(max_total_stake_percent=1.5)
        alerts = [make_alert(11.0, event_id=f"e{i}") for i in range(10)]
        slip = recommend_all(alerts, config=config, limit=10)
        assert slip.total_stake_percent <= 1.5 + 1e-9
        assert slip.picks

    def test_gekuerzter_einsatz_wird_im_text_genannt(self):
        config = RecommendationConfig(max_total_stake_percent=1.0)
        alerts = [make_alert(11.0, event_id=f"e{i}") for i in range(4)]
        slip = recommend_all(alerts, config=config)
        letzte = slip.picks[-1].recommendation
        assert letzte.stake_percent <= 1.0
        assert f"{letzte.stake_percent:.1f} %" in letzte.play

    def test_leere_liste_nennt_immer_einen_grund(self):
        slip = recommend_all([make_alert(250.0), make_alert(-5.0)])
        assert slip.picks == []
        assert slip.considered == 2
        assert sum(slip.dropped.values()) == 2
        payload = slip.to_json()
        assert {entry["code"] for entry in payload["dropped"]} == {"unplausibel", "kein_vorteil"}
        assert all(entry["label"] for entry in payload["dropped"])

    def test_limit_begrenzt_die_liste(self):
        alerts = [make_alert(11.0, event_id=f"e{i}") for i in range(8)]
        slip = recommend_all(alerts, limit=3)
        assert len(slip.picks) == 3
        assert slip.dropped["liste_voll"] >= 1

    def test_beobachten_kommt_nicht_in_die_liste(self):
        beobachten = evaluate(make_alert(19.0))
        assert beobachten.grade is Grade.WEAK
        assert beobachten.stake_percent == 0.0
        assert not beobachten.playable
        slip = build_slip([(make_alert(19.0), beobachten)])
        assert slip.picks == []


class TestDarstellung:
    def test_klartext_nennt_wette_buchmacher_quote_und_einsatz(self):
        result = evaluate(make_alert(11.0))
        assert "Heim vs Gast" in result.play
        assert "bet365" in result.play
        assert "2.10" in result.play
        assert "Einsatz" in result.play

    def test_pruefliste_erinnert_daran_dass_niemand_automatisch_setzt(self):
        result = evaluate(make_alert(11.0))
        assert result.checklist
        assert any("prüfen" in item for item in result.checklist)

    def test_warnung_bei_unglaubwuerdig_hohem_wert(self):
        result = evaluate(make_alert(17.0))
        assert any("real erreichbare Vorteile" in warning for warning in result.warnings)

    def test_json_geht_hin_und_zurueck(self):
        result = evaluate(make_alert(11.0), RecommendationConfig(bankroll=500.0))
        wieder = Recommendation.from_json(result.to_json())
        assert wieder.grade is result.grade
        assert wieder.stake_percent == pytest.approx(result.stake_percent)
        assert wieder.play == result.play
        assert wieder.reason_label == result.reason_label

    def test_spielbare_grade_sind_die_mit_einsatz(self):
        assert Grade.STRONG in PLAYABLE_GRADES
        assert Grade.MODERATE in PLAYABLE_GRADES
        assert Grade.WEAK not in PLAYABLE_GRADES
        assert Grade.SKIP not in PLAYABLE_GRADES


class TestKonfiguration:
    def test_aus_den_settings_gebaut(self, settings):
        config = config_from_settings(settings)
        assert config.kelly_fraction == settings.kelly_fraction
        assert config.max_stake_percent == settings.max_stake_percent
        assert config.min_bookmakers == settings.recommend_min_bookmakers


class TestDoppelteWetten:
    """Für dieselbe Selektion entscheidet der Preis, nicht das Modell."""

    def test_hoehere_quote_setzt_sich_durch(self):
        niedrig = make_alert(10.5, event_id="e1")
        hoch = make_alert(11.5, event_id="e1", odds=2.20)
        hoch.bookmaker = "pinnacle"
        slip = recommend_all([niedrig, hoch])
        assert len(slip.picks) == 1
        assert slip.picks[0].alert.bookmaker == "pinnacle"
        assert slip.picks[0].alert.odds == 2.20

    def test_unplausibler_preis_verdraengt_den_brauchbaren_nicht(self):
        """Wenn der Ausreißer als Datenfehler ausscheidet, bleibt die
        maßvolle Quote derselben Wette stehen - nicht beide fallen weg."""
        brauchbar = make_alert(11.0, event_id="e1")
        ausreisser = make_alert(300.0, event_id="e1", odds=9.90)
        ausreisser.bookmaker = "irgendwer"
        slip = recommend_all([ausreisser, brauchbar])
        assert [pick.alert.bookmaker for pick in slip.picks] == ["bet365"]
        assert slip.dropped["unplausibel"] == 1


class TestBankrollNachtraeglich:
    """Die Bankroll wird oft erst später hinterlegt. Eine gespeicherte
    Empfehlung darf dann nicht für immer ohne Betrag bleiben."""

    def test_betrag_kommt_dazu_wenn_die_bankroll_spaeter_gesetzt_wird(self):
        alert = make_alert(11.0)
        ohne = evaluate(alert, RecommendationConfig())
        assert ohne.stake_amount is None

        slip = build_slip([(alert, ohne)], config=RecommendationConfig(bankroll=1000.0))
        rec = slip.picks[0].recommendation
        assert rec.stake_percent == pytest.approx(ohne.stake_percent)
        assert rec.stake_amount == pytest.approx(1000.0 * ohne.stake_percent / 100.0, abs=0.01)
        assert "1000" not in rec.play  # der Betrag, nicht die Bankroll
        assert f"{rec.stake_amount:.2f}" in rec.play

    def test_ungekuerzter_einsatz_traegt_keine_kuerzungswarnung(self):
        alert = make_alert(11.0)
        slip = recommend_all([alert])
        assert not any("gekürzt" in w for w in slip.picks[0].recommendation.warnings)


class TestReadmeTabelle:
    """Die Tabelle in der README nennt konkrete Zahlen. Ändert sich die
    Kurve, muss die Doku mitkommen - sonst steht dort bald etwas Falsches."""

    ERWARTET = {
        5.0: (0.82, 3.2, Grade.STRONG),
        10.0: (0.46, 3.6, Grade.STRONG),
        15.0: (0.17, 2.0, Grade.MODERATE),
        20.0: (0.04, 0.7, Grade.WEAK),
        30.0: (0.00, 0.0, Grade.SKIP),
    }

    @pytest.mark.parametrize("value", sorted(ERWARTET))
    def test_zahlen_stimmen_mit_der_doku(self, value):
        plausibilitaet, edge, grade = self.ERWARTET[value]
        result = evaluate(make_alert(value))
        assert round(result.plausibility, 2) == plausibilitaet
        assert round(result.credible_edge_percent, 1) == edge
        assert result.grade is grade

    def test_absurder_wert_wird_abgelehnt(self):
        assert evaluate(make_alert(250.0)).grade is Grade.SKIP
