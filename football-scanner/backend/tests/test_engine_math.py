import math

import pytest

from app.engine.distributions import (
    convolve,
    estimate_dispersion,
    mean_of,
    negative_binomial_pmf,
    poisson_pmf,
)
from app.engine.joint import JointDistribution, dixon_coles_matrix
from app.engine.markets import (
    Market,
    Outcome,
    grade,
    handicap_selection,
    make_selection,
    price,
    profit_units,
    total_selection,
)
from app.engine.pricing import assess, kelly_fraction, overround, remove_margin


def test_poisson_sums_to_one_and_has_right_mean():
    pmf = poisson_pmf(1.7, 20)
    assert math.isclose(sum(pmf), 1.0, abs_tol=1e-12)
    assert math.isclose(mean_of(pmf), 1.7, rel_tol=1e-6)


def test_negative_binomial_mean_and_overdispersion():
    pmf = negative_binomial_pmf(5.0, 8.0, 60)
    assert math.isclose(sum(pmf), 1.0, abs_tol=1e-12)
    assert math.isclose(mean_of(pmf), 5.0, rel_tol=1e-4)
    var = sum((k - 5.0) ** 2 * p for k, p in enumerate(pmf))
    assert math.isclose(var, 5.0 + 25 / 8, rel_tol=1e-3)


def test_negative_binomial_without_dispersion_is_poisson():
    assert negative_binomial_pmf(3.0, None, 15) == poisson_pmf(3.0, 15)
    assert estimate_dispersion(4.0, 3.0) is None
    assert math.isclose(estimate_dispersion(4.0, 6.0), 8.0)


def test_convolve_matches_poisson_additivity():
    a = poisson_pmf(1.0, 30)
    b = poisson_pmf(2.0, 30)
    c = poisson_pmf(3.0, 60)
    ab = convolve(a, b)
    for k in range(10):
        assert math.isclose(ab[k], c[k], rel_tol=1e-9)


def test_dixon_coles_is_a_distribution_and_moves_mass_to_draws():
    dc = dixon_coles_matrix(1.4, 1.1, rho=-0.1)
    indep = dixon_coles_matrix(1.4, 1.1, rho=0.0)
    assert math.isclose(sum(p for *_, p in dc.cells()), 1.0, abs_tol=1e-12)
    assert dc.probs[0][0] > indep.probs[0][0]
    assert dc.probs[1][1] > indep.probs[1][1]
    assert dc.probs[1][0] < indep.probs[1][0]
    assert math.isclose(indep.expected_home(), 1.4, rel_tol=1e-3)


@pytest.mark.parametrize(
    "market,side,line,home,away,expected",
    [
        (Market.OVER_UNDER, "over", 2.5, 2, 1, Outcome.WIN),
        (Market.OVER_UNDER, "under", 2.5, 2, 1, Outcome.LOSS),
        (Market.ASIAN_TOTAL, "over", 2.25, 1, 1, Outcome.HALF_LOSS),
        (Market.ASIAN_TOTAL, "over", 2.25, 2, 1, Outcome.WIN),
        (Market.ASIAN_TOTAL, "over", 2.75, 2, 1, Outcome.HALF_WIN),
        (Market.ASIAN_TOTAL, "under", 2.75, 2, 1, Outcome.HALF_LOSS),
        (Market.ASIAN_TOTAL, "over", 2.0, 1, 1, Outcome.PUSH),
        (Market.ASIAN_TOTAL, "under", 3.0, 1, 1, Outcome.WIN),
        (Market.ASIAN_HANDICAP, "home", -0.25, 1, 1, Outcome.HALF_LOSS),
        (Market.ASIAN_HANDICAP, "away", 0.25, 1, 1, Outcome.HALF_WIN),
        (Market.ASIAN_HANDICAP, "home", -0.75, 2, 1, Outcome.HALF_WIN),
        (Market.ASIAN_HANDICAP, "home", -1.0, 2, 1, Outcome.PUSH),
        (Market.ASIAN_HANDICAP, "home", -1.25, 2, 1, Outcome.HALF_LOSS),
        (Market.ASIAN_HANDICAP, "away", 1.5, 2, 1, Outcome.WIN),
        (Market.DRAW_NO_BET, "home", None, 0, 0, Outcome.PUSH),
        (Market.DRAW_NO_BET, "away", None, 0, 1, Outcome.WIN),
        (Market.RESULT_1X2, "draw", None, 1, 1, Outcome.WIN),
        (Market.DOUBLE_CHANCE, "X2", None, 1, 0, Outcome.LOSS),
        (Market.DOUBLE_CHANCE, "12", None, 0, 3, Outcome.WIN),
        (Market.BTTS, "yes", None, 1, 0, Outcome.LOSS),
        (Market.BTTS, "no", None, 1, 0, Outcome.WIN),
    ],
)
def test_grading(market, side, line, home, away, expected):
    assert grade(make_selection(market, side, line), home, away) is expected


def test_team_total_grading():
    sel = make_selection(Market.TEAM_GOALS, "over", 1.5, "away")
    assert grade(sel, 0, 2) is Outcome.WIN
    assert grade(sel, 3, 1) is Outcome.LOSS


def test_line_type_decides_market():
    assert total_selection("goals", "over", 2.5).market is Market.OVER_UNDER
    assert total_selection("goals", "over", 2.25).market is Market.ASIAN_TOTAL
    assert total_selection("corners", "under", 9.5).market is Market.CORNERS_OU
    assert total_selection("cards", "under", 4.0).market is Market.ASIAN_CARDS
    assert handicap_selection("corners", "home", -1.5).market is Market.ASIAN_CORNERS
    with pytest.raises(ValueError):
        make_selection(Market.OVER_UNDER, "over", 2.0)
    with pytest.raises(ValueError):
        make_selection(Market.ASIAN_TOTAL, "over", 2.5)
    with pytest.raises(ValueError):
        make_selection(Market.OVER_UNDER, "over", 2.3)


def test_selection_key_round_trip():
    for sel in (
        make_selection(Market.ASIAN_HANDICAP, "home", -0.75),
        make_selection(Market.TEAM_CORNERS, "under", 4.5, "away"),
        make_selection(Market.RESULT_1X2, "draw"),
    ):
        assert type(sel).from_key(sel.key) == sel


@pytest.fixture
def joint():
    return dixon_coles_matrix(1.55, 1.05, rho=-0.05)


def test_market_prices_are_consistent(joint: JointDistribution):
    p = {
        s: price(make_selection(Market.RESULT_1X2, s), joint).win for s in ("home", "draw", "away")
    }
    assert math.isclose(sum(p.values()), 1.0, abs_tol=1e-9)
    dc = price(make_selection(Market.DOUBLE_CHANCE, "1X"), joint).win
    assert math.isclose(dc, p["home"] + p["draw"], abs_tol=1e-9)
    dnb = price(make_selection(Market.DRAW_NO_BET, "home"), joint)
    assert math.isclose(dnb.push, p["draw"], abs_tol=1e-9)
    assert math.isclose(
        dnb.effective_probability, p["home"] / (p["home"] + p["away"]), rel_tol=1e-9
    )
    ah0 = price(make_selection(Market.ASIAN_HANDICAP, "home", 0.0), joint)
    assert math.isclose(ah0.effective_probability, dnb.effective_probability, rel_tol=1e-12)
    over = price(make_selection(Market.OVER_UNDER, "over", 2.5), joint).win
    under = price(make_selection(Market.OVER_UNDER, "under", 2.5), joint).win
    assert math.isclose(over + under, 1.0, abs_tol=1e-9)


def test_quarter_line_is_average_of_neighbours(joint: JointDistribution):
    q = price(make_selection(Market.ASIAN_TOTAL, "over", 2.25), joint)
    lo = price(make_selection(Market.ASIAN_TOTAL, "over", 2.0), joint)
    hi = price(make_selection(Market.OVER_UNDER, "over", 2.5), joint)
    for odds in (1.7, 1.9, 2.1):
        assert math.isclose(
            q.expected_value(odds),
            (lo.expected_value(odds) + hi.expected_value(odds)) / 2,
            abs_tol=1e-12,
        )


def test_spec_value_example():
    # The spec's worked example: 67% at 1.85.
    from app.engine.markets import OutcomeProbabilities

    va = assess(OutcomeProbabilities(0.67, 0, 0, 0, 0.33), 1.85)
    assert math.isclose(va.fair_odds, 1 / 0.67)
    assert round(va.fair_odds, 2) == 1.49
    assert round(va.implied_probability * 100, 2) == 54.05
    assert round(va.edge_pp, 2) == 12.95
    assert round(va.value_pct, 2) == 23.95


def test_push_line_ev_and_fair_odds_are_exact(joint: JointDistribution):
    out = price(make_selection(Market.ASIAN_TOTAL, "over", 2.0), joint)
    fair = assess(out, None).fair_odds
    # At fair odds the expected value is exactly zero.
    assert math.isclose(out.expected_value(fair), 0.0, abs_tol=1e-12)
    va = assess(out, 2.0)
    assert math.isclose(va.value_pct / 100, out.win * 1.0 - out.loss, abs_tol=1e-12)


def test_margin_helpers_and_kelly():
    assert math.isclose(overround([1.9, 1.9]), 2 / 1.9 - 1)
    assert math.isclose(sum(remove_margin([2.2, 3.4, 3.3])), 1.0)
    assert kelly_fraction(0.5, 1.9) == 0.0
    assert math.isclose(kelly_fraction(0.6, 2.0), 0.2)


def test_profit_units():
    assert profit_units(Outcome.WIN, 1.9) == pytest.approx(0.9)
    assert profit_units(Outcome.HALF_WIN, 1.9) == pytest.approx(0.45)
    assert profit_units(Outcome.HALF_LOSS, 1.9) == -0.5
    assert profit_units(Outcome.PUSH, 1.9) == 0.0
