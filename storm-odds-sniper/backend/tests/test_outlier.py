"""Fixed-Odds-Error-Detector."""

from __future__ import annotations

import pytest

from backend.core.outlier import WEIGHTS, OutlierConfig, score_outlier


def base_call(**overrides):
    kwargs = {
        "odds": 3.80,
        "fair_odds": 2.45,
        "bookmaker_count": 5,
        "confidence": 80,
        "quote_age": 1.0,
        "is_live": False,
    }
    kwargs.update(overrides)
    return score_outlier(**kwargs)


class TestSpecExample:
    """Das Beispiel aus der Aufgabenstellung.

    Markt 2.40/2.45/2.50/2.42/2.48 -> faire Quote 2.45, Bookie 3.80.
    """

    def test_deviation_matches(self):
        result = base_call()
        assert result.deviation_percent == pytest.approx(55.10, abs=0.05)

    def test_is_flagged_with_a_high_score(self):
        result = base_call()
        assert result.is_outlier
        assert result.error_score >= 60

    def test_score_stays_within_bounds(self):
        assert 0 <= base_call().error_score <= 100


class TestThresholds:
    def test_below_threshold_scores_zero(self):
        result = base_call(odds=2.60)  # nur +6 %
        assert result.error_score == 0
        assert result.is_outlier is False
        assert "unter Schwelle" in result.reasons[0]

    def test_exactly_at_threshold_is_counted(self):
        config = OutlierConfig(min_deviation_percent=15.0)
        result = base_call(odds=2.45 * 1.15, config=config)
        assert result.error_score > 0

    def test_negative_deviation_is_never_an_outlier(self):
        # Zu niedrige Quote ist kein spielbarer Fehler.
        assert base_call(odds=2.0).error_score == 0

    def test_invalid_prices_are_rejected(self):
        assert base_call(odds=1.0).error_score == 0
        assert base_call(fair_odds=0.0).error_score == 0


class TestSignals:
    def test_bigger_deviation_scores_higher(self):
        small = base_call(odds=2.90)
        large = base_call(odds=4.90)
        assert large.error_score > small.error_score

    def test_more_bookmakers_score_higher(self):
        thin = base_call(bookmaker_count=2)
        broad = base_call(bookmaker_count=12)
        assert broad.error_score > thin.error_score
        assert any("Dünne Referenz" in r for r in thin.reasons)

    def test_own_price_jump_is_a_strong_signal(self):
        steady = base_call(previous_price=3.78)
        jumped = base_call(previous_price=2.40)
        assert jumped.error_score > steady.error_score
        assert any("Sprung" in r for r in jumped.reasons)

    def test_lagging_book_while_market_moves(self):
        quiet = base_call(market_drift_percent=None)
        lagging = base_call(market_drift_percent=-9.0)
        assert lagging.error_score > quiet.error_score
        assert any("Markt bewegte sich" in r for r in lagging.reasons)

    def test_fresh_live_quote_scores_higher_than_old_one(self):
        fresh = base_call(is_live=True, quote_age=0.5)
        old = base_call(is_live=True, quote_age=9.5)
        assert fresh.error_score > old.error_score

    def test_low_confidence_lowers_the_score(self):
        assert base_call(confidence=20).error_score < base_call(confidence=95).error_score

    def test_liquidity_raises_the_score(self):
        assert base_call(liquidity=8000).error_score > base_call(liquidity=None).error_score

    def test_missing_liquidity_is_neutral_not_punished(self):
        result = base_call(liquidity=None)
        assert result.components["liquidity"] == pytest.approx(WEIGHTS["liquidity"] * 0.5)
        assert any("Keine Liquiditätsdaten" in r for r in result.reasons)

    def test_exchange_reference_substitutes_for_liquidity(self):
        assert (
            base_call(exchange_references=2).components["liquidity"]
            > base_call(exchange_references=0).components["liquidity"]
        )

    def test_stale_quote_is_reported(self):
        result = base_call(quote_age=30.0)
        assert any("alt" in r for r in result.reasons)


class TestComponents:
    def test_weights_sum_to_one_hundred(self):
        assert sum(WEIGHTS.values()) == pytest.approx(100.0)

    def test_all_components_are_present(self):
        components = base_call().components
        assert set(components) == set(WEIGHTS)

    def test_no_component_exceeds_its_weight(self):
        for name, value in base_call(
            odds=20.0, bookmaker_count=40, confidence=100, liquidity=1e9, quote_age=0.0
        ).components.items():
            assert value <= WEIGHTS[name] + 1e-6

    def test_score_never_exceeds_hundred(self):
        result = base_call(
            odds=50.0,
            bookmaker_count=50,
            confidence=100,
            quote_age=0.0,
            is_live=True,
            liquidity=1e6,
            previous_price=2.0,
            market_drift_percent=-25.0,
        )
        assert result.error_score <= 100
