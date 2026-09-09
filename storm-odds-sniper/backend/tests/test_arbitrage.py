"""Sichere Wetten: Arithmetik statt Schätzung.

Der Rest des Projekts schätzt. Hier wird gerechnet - und deshalb prüfen die
Tests vor allem die Fälle, in denen die Rechnung zwar aufgeht, die Sache in
der Wirklichkeit aber trotzdem keine ist: ein Buch, das sich selbst
widerspricht; ein unvollständiges Buch; ein Fund, der zu gut ist, um wahr zu
sein.
"""

from __future__ import annotations

import pytest

from backend.core.arbitrage import ArbitrageConfig, find_arbitrage, stake_split
from backend.core.value_engine import MarketBook
from backend.models.domain import MarketKey, OddsQuote, Selection, now_ts
from backend.models.enums import MarketType, Period, SelectionCode

OVER_UNDER = MarketKey(MarketType.OVER_UNDER, 2.5, Period.FULL_TIME)
MATCH_ODDS = MarketKey(MarketType.MATCH_ODDS, None, Period.FULL_TIME)


def quote(selection, bookmaker, price, *, market=OVER_UNDER, age=0.0, suspended=False):
    jetzt = now_ts()
    return OddsQuote(
        event_id="e1",
        market=market,
        selection=selection,
        bookmaker=bookmaker,
        price=price,
        provider="test",
        ts=jetzt - age,
        received_at=jetzt - age,
        confirmed_at=jetzt - age,
        suspended=suspended,
    )


OVER = Selection(SelectionCode.OVER, "Über 2.5")
UNDER = Selection(SelectionCode.UNDER, "Unter 2.5")
HOME = Selection(SelectionCode.HOME, "Heim")
DRAW = Selection(SelectionCode.DRAW, "Unentschieden")
AWAY = Selection(SelectionCode.AWAY, "Gast")


def book(*quotes, market=OVER_UNDER):
    return MarketBook.from_quotes("e1", market, list(quotes))


class TestEinsatzverteilung:
    def test_jeder_ausgang_gibt_dasselbe_zurueck(self):
        """Das ist der ganze Trick: der Rückfluss hängt nicht am Ergebnis."""
        anteile = stake_split([2.10, 2.15])
        rueck = [
            100.0 * anteil * quote for anteil, quote in zip(anteile, [2.10, 2.15], strict=True)
        ]
        assert rueck[0] == pytest.approx(rueck[1], abs=0.01)
        assert sum(anteile) == pytest.approx(1.0)

    def test_auch_bei_drei_ausgaengen(self):
        quoten = [3.60, 3.90, 2.90]
        anteile = stake_split(quoten)
        rueck = [a * q for a, q in zip(anteile, quoten, strict=True)]
        assert rueck[0] == pytest.approx(rueck[1]) == pytest.approx(rueck[2])

    def test_kaputte_quoten_ergeben_nichts(self):
        assert stake_split([]) == []
        assert stake_split([0.0]) == []


class TestErkennung:
    def test_widerspruch_wird_gefunden(self):
        """1/2.10 + 1/2.15 = 94,1 % - da bleiben 6,2 % übrig."""
        arb = find_arbitrage(book(quote(OVER, "a", 2.10), quote(UNDER, "b", 2.15)))
        assert arb is not None
        assert arb.total_probability == pytest.approx(0.94131, abs=1e-4)
        assert arb.profit_percent == pytest.approx(6.235, abs=0.01)
        assert arb.bookmakers == ["a", "b"]

    def test_rueckfluss_ist_ausgangsunabhaengig(self):
        arb = find_arbitrage(book(quote(OVER, "a", 2.10), quote(UNDER, "b", 2.15)))
        assert arb.payout(100.0) == pytest.approx(106.24, abs=0.01)
        for leg in arb.legs:
            assert 100.0 * leg.stake_share * leg.odds == pytest.approx(106.24, abs=0.01)

    def test_normaler_markt_ergibt_nichts(self):
        """Der Normalfall: die Bücher verdienen an der Marge."""
        assert find_arbitrage(book(quote(OVER, "a", 1.90), quote(UNDER, "b", 1.90))) is None

    def test_bester_preis_je_ausgang_zaehlt(self):
        arb = find_arbitrage(
            book(
                quote(OVER, "schlecht", 1.90),
                quote(OVER, "gut", 2.10),
                quote(UNDER, "b", 2.15),
            )
        )
        assert arb is not None
        assert {leg.bookmaker for leg in arb.legs} == {"gut", "b"}

    def test_drei_wege_markt(self):
        arb = find_arbitrage(
            book(
                quote(HOME, "a", 3.60, market=MATCH_ODDS),
                quote(DRAW, "b", 3.90, market=MATCH_ODDS),
                quote(AWAY, "c", 3.60, market=MATCH_ODDS),
                market=MATCH_ODDS,
            ),
        )
        assert arb is not None
        assert len(arb.legs) == 3
        assert sum(leg.stake_share for leg in arb.legs) == pytest.approx(1.0)


class TestWasKeineArbitrageIst:
    def test_ein_buch_das_sich_selbst_widerspricht(self):
        """Fast immer eine falsche Linie oder ein alter Preis - kein Geschenk."""
        assert find_arbitrage(book(quote(OVER, "a", 2.10), quote(UNDER, "a", 2.15))) is None

    def test_unvollstaendiges_buch(self):
        """Fehlt ein Ausgang, ist die Summe zwangsläufig unter 1 - und das
        bedeutet nichts. Genau hier entstünden sonst massenhaft Scheinfunde."""
        assert find_arbitrage(book(quote(OVER, "a", 2.10))) is None
        drei_wege_unvollstaendig = book(
            quote(HOME, "a", 3.60, market=MATCH_ODDS),
            quote(AWAY, "b", 3.60, market=MATCH_ODDS),
            market=MATCH_ODDS,
        )
        assert find_arbitrage(drei_wege_unvollstaendig) is None

    def test_alte_quoten_zaehlen_nicht(self):
        alt = book(quote(OVER, "a", 2.10, age=120.0), quote(UNDER, "b", 2.15))
        assert find_arbitrage(alt) is None

    def test_gesperrte_quote_zaehlt_nicht(self):
        gesperrt = book(quote(OVER, "a", 2.10, suspended=True), quote(UNDER, "b", 2.15))
        assert find_arbitrage(gesperrt) is None

    def test_winzige_marge_lohnt_nicht(self):
        config = ArbitrageConfig(min_profit_percent=1.0)
        knapp = book(quote(OVER, "a", 2.01), quote(UNDER, "b", 2.02))
        assert find_arbitrage(knapp, config=config) is None

    def test_markt_ohne_vollstaendiges_buch_wird_uebersprungen(self):
        """Correct Score & Co. ergänzen sich nicht zu 100 % - dort ist die
        Rechnung gar nicht anwendbar."""
        cs = MarketKey(MarketType.CORRECT_SCORE, None, Period.FULL_TIME)
        assert (
            find_arbitrage(
                book(
                    quote(OVER, "a", 2.10, market=cs), quote(UNDER, "b", 2.15, market=cs), market=cs
                )
            )
            is None
        )


class TestZuSchoenUmWahrZuSein:
    def test_absurder_fund_wird_als_verdacht_markiert(self):
        """0,5-3 % sind real. 40 % sind ein Datenfehler - mitgeliefert, aber
        ausdrücklich als Verdacht, nicht als Empfehlung."""
        arb = find_arbitrage(book(quote(OVER, "a", 3.00), quote(UNDER, "b", 3.00)))
        assert arb is not None
        assert arb.profit_percent > 40
        assert arb.suspicious is True

    def test_realistischer_fund_ist_unverdaechtig(self):
        arb = find_arbitrage(book(quote(OVER, "a", 2.02), quote(UNDER, "b", 2.04)))
        assert arb is not None
        assert arb.profit_percent < 3
        assert arb.suspicious is False


class TestDarstellung:
    def test_json_enthaelt_alles_zum_nachrechnen(self):
        arb = find_arbitrage(
            book(quote(OVER, "a", 2.10), quote(UNDER, "b", 2.15)),
            event_title="A vs B",
            sport="football",
        )
        payload = arb.to_json()
        assert payload["event_title"] == "A vs B"
        assert payload["market_label"] == "Over/Under 2.5"
        assert payload["bookmakers"] == ["a", "b"]
        assert len(payload["legs"]) == 2
        anteile = sum(leg["stake_percent"] for leg in payload["legs"])
        assert anteile == pytest.approx(100.0, abs=0.05)
        for leg in payload["legs"]:
            assert leg["bookmaker"]
            assert leg["odds"] > 1
