"""Value Engine: faire Quoten, Margin-Bereinigung, Confidence."""

from __future__ import annotations

import pytest

from backend.core.value_engine import (
    BOOKMAKER_WEIGHTS,
    EngineConfig,
    MarketBook,
    ValueEngine,
    deviation_percent,
    implied_probability,
    remove_margin,
    value_percent,
)
from backend.models.domain import Selection, now_ts
from backend.models.enums import SelectionCode
from backend.tests.conftest import (
    MATCH_ODDS,
    OVER,
    OVER_UNDER_25,
    UNDER,
    make_book,
    make_quote,
)

HOME = Selection(code=SelectionCode.HOME, label="Heim")
DRAW = Selection(code=SelectionCode.DRAW, label="Draw")
AWAY = Selection(code=SelectionCode.AWAY, label="Auswärts")


class TestFormulas:
    def test_implied_probability(self):
        assert implied_probability(2.0) == pytest.approx(0.5)
        assert implied_probability(4.0) == pytest.approx(0.25)
        assert implied_probability(0.0) == 0.0

    def test_value_percent_matches_spec_formula(self):
        # value = (odds * fair_probability) - 1
        assert value_percent(3.40, 1 / 2.65) == pytest.approx(28.30, abs=0.05)

    def test_value_is_zero_at_fair_price(self):
        assert value_percent(2.5, 0.4) == pytest.approx(0.0)

    def test_negative_value(self):
        assert value_percent(1.8, 0.5) < 0

    def test_deviation_percent(self):
        assert deviation_percent(3.80, 2.45) == pytest.approx(55.10, abs=0.05)


class TestMarginRemoval:
    def test_proportional_sums_to_one(self):
        probs = {"home": 0.50, "draw": 0.30, "away": 0.28}  # Overround 1.08
        fair = remove_margin(probs, "proportional")
        assert sum(fair.values()) == pytest.approx(1.0)
        # Reihenfolge der Favoriten bleibt erhalten
        assert fair["home"] > fair["draw"] > fair["away"]

    def test_equal_margin_sums_to_one(self):
        probs = {"over": 0.55, "under": 0.53}
        fair = remove_margin(probs, "equal_margin")
        assert sum(fair.values()) == pytest.approx(1.0)
        assert fair["over"] - fair["under"] == pytest.approx(0.02)

    def test_equal_margin_falls_back_when_it_would_go_negative(self):
        # Außenseiter mit sehr kleiner Wahrscheinlichkeit -> additive Methode
        # würde negativ; dann greift proportional.
        probs = {"a": 0.97, "b": 0.004, "c": 0.30}
        fair = remove_margin(probs, "equal_margin")
        assert all(v > 0 for v in fair.values())
        assert sum(fair.values()) == pytest.approx(1.0)

    def test_zero_total_is_safe(self):
        assert remove_margin({"a": 0.0}) == {"a": 0.0}


class TestFairOdds:
    def setup_method(self):
        self.engine = ValueEngine(EngineConfig(max_quote_age=30.0))

    def test_median_of_the_market(self):
        # Marktbeispiel aus der Aufgabenstellung
        book = make_book({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42, "b5": 2.48})
        result = self.engine.fair_odds(book, OVER.key)
        assert result is not None
        # Median der Quoten ist 2.45; nach Margin-Bereinigung etwas höher.
        assert 2.45 <= result.fair_odds <= 2.62
        assert result.bookmaker_count == 5

    def test_target_bookmaker_is_excluded(self):
        book = make_book({"b1": 2.40, "b2": 2.45, "b3": 2.50, "outlier": 3.80})
        with_outlier = self.engine.fair_odds(book, OVER.key)
        without = self.engine.fair_odds(book, OVER.key, exclude_bookmaker="outlier")
        assert without is not None and with_outlier is not None
        # Ohne den Ausreißer ist die faire Quote niedriger.
        assert without.fair_odds < with_outlier.fair_odds
        assert without.bookmaker_count == 3

    def test_returns_none_without_data(self):
        book = MarketBook(event_id="x", market=OVER_UNDER_25)
        assert self.engine.fair_odds(book, OVER.key) is None

    def test_stale_quotes_are_ignored(self):
        book = MarketBook(event_id="x", market=OVER_UNDER_25)
        old = now_ts() - 300
        for name, price in (("b1", 2.4), ("b2", 2.45)):
            book.add(make_quote(bookmaker=name, price=price, selection=OVER, ts=old))
            book.add(make_quote(bookmaker=name, price=2.6, selection=UNDER, ts=old))
        assert self.engine.fair_odds(book, OVER.key) is None

    def test_suspended_quotes_are_ignored(self):
        book = make_book({"b1": 2.40, "b2": 2.45, "b3": 2.50})
        book.add(make_quote(bookmaker="b4", price=9.0, selection=OVER, suspended=True))
        result = self.engine.fair_odds(book, OVER.key)
        assert result is not None
        assert result.bookmaker_count == 3

    def test_all_three_models_run_on_a_complete_book(self):
        book = make_book({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42})
        result = self.engine.fair_odds(book, OVER.key)
        assert result is not None
        assert result.model_a_odds is not None
        assert result.model_b_odds is not None
        assert result.model_c_odds is not None
        assert result.overround is not None
        assert 1.0 < result.overround < 1.2

    def test_incomplete_book_uses_median_only(self):
        book = MarketBook(event_id="x", market=OVER_UNDER_25)
        for name, price in (("b1", 2.4), ("b2", 2.45), ("b3", 2.5)):
            book.add(make_quote(bookmaker=name, price=price, selection=OVER))
        result = self.engine.fair_odds(book, OVER.key)
        assert result is not None
        assert result.model_b_odds is None
        assert any("Margin-Modell" in note for note in result.notes)

    def test_three_way_market(self):
        book = MarketBook(event_id="x", market=MATCH_ODDS)
        prices = {"b1": (2.10, 3.50, 3.60), "b2": (2.05, 3.55, 3.70), "b3": (2.12, 3.45, 3.55)}
        for bookmaker, (h, d, a) in prices.items():
            book.add(make_quote(bookmaker=bookmaker, price=h, selection=HOME, market=MATCH_ODDS))
            book.add(make_quote(bookmaker=bookmaker, price=d, selection=DRAW, market=MATCH_ODDS))
            book.add(make_quote(bookmaker=bookmaker, price=a, selection=AWAY, market=MATCH_ODDS))
        result = self.engine.fair_odds(book, HOME.key)
        assert result is not None
        assert result.model_b_odds is not None
        assert result.fair_odds > 2.10  # margenbereinigt liegt fair über der Marktquote

    def test_exchange_weight_pulls_the_consensus(self):
        assert BOOKMAKER_WEIGHTS["pinnacle"] > 2.0
        book = MarketBook(event_id="x", market=OVER_UNDER_25)
        for bookmaker, price in (("pinnacle", 2.60), ("unibet", 2.30), ("bwin", 2.30)):
            book.add(make_quote(bookmaker=bookmaker, price=price, selection=OVER))
            book.add(
                make_quote(bookmaker=bookmaker, price=1.0 / (1.05 - 1 / price), selection=UNDER)
            )
        result = self.engine.fair_odds(book, OVER.key)
        assert result is not None
        assert result.model_c_odds is not None
        # Das scharfe Buch zieht den Konsens über den einfachen Mittelwert.
        assert result.model_c_odds > result.model_b_odds


class TestConfidence:
    def setup_method(self):
        self.engine = ValueEngine(EngineConfig(max_quote_age=30.0))

    def test_more_bookmakers_means_more_confidence(self):
        few = make_book({"b1": 2.40, "b2": 2.45, "b3": 2.42})
        many = make_book({f"b{i}": 2.40 + i * 0.01 for i in range(10)})
        assert (
            self.engine.fair_odds(many, OVER.key).confidence
            > self.engine.fair_odds(few, OVER.key).confidence
        )

    def test_disagreement_lowers_confidence(self):
        tight = make_book({"b1": 2.40, "b2": 2.41, "b3": 2.42, "b4": 2.40})
        wide = make_book({"b1": 1.80, "b2": 2.40, "b3": 3.20, "b4": 2.60})
        assert (
            self.engine.fair_odds(tight, OVER.key).confidence
            > self.engine.fair_odds(wide, OVER.key).confidence
        )

    def test_live_is_penalised(self):
        book = make_book({"b1": 2.40, "b2": 2.45, "b3": 2.42, "b4": 2.44})
        pre = self.engine.fair_odds(book, OVER.key, is_live=False).confidence
        live = self.engine.fair_odds(book, OVER.key, is_live=True).confidence
        assert live < pre

    def test_old_quotes_lower_confidence(self):
        fresh = make_book({"b1": 2.40, "b2": 2.45, "b3": 2.42})
        stale = MarketBook(event_id="x", market=OVER_UNDER_25)
        old = now_ts() - 25
        for name, price in (("b1", 2.40), ("b2", 2.45), ("b3", 2.42)):
            stale.add(make_quote(bookmaker=name, price=price, selection=OVER, ts=old))
            stale.add(make_quote(bookmaker=name, price=2.6, selection=UNDER, ts=old))
        assert (
            self.engine.fair_odds(fresh, OVER.key).confidence
            > self.engine.fair_odds(stale, OVER.key).confidence
        )

    def test_confidence_is_bounded(self):
        book = make_book({f"b{i}": 2.40 for i in range(20)})
        confidence = self.engine.fair_odds(book, OVER.key).confidence
        assert 0 <= confidence <= 100


class TestMarketBook:
    def test_completeness_detection(self):
        complete = make_book({"b1": 2.4})
        assert complete.is_complete_book() is True

        partial = MarketBook(event_id="x", market=OVER_UNDER_25)
        partial.add(make_quote(bookmaker="b1", price=2.4, selection=OVER))
        assert partial.is_complete_book() is False

    def test_bookmaker_book_requires_all_selections(self):
        book = make_book({"b1": 2.4, "b2": 2.5})
        assert book.bookmaker_book("b1", reference=now_ts(), max_age=30) is not None
        book.quotes[UNDER.key].pop("b2")
        assert book.bookmaker_book("b2", reference=now_ts(), max_age=30) is None

    def test_bookmakers_returns_all(self):
        book = make_book({"b1": 2.4, "b2": 2.5, "b3": 2.6})
        assert book.bookmakers() == {"b1", "b2", "b3"}
