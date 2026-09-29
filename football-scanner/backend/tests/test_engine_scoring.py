from datetime import UTC, datetime, timedelta

import pytest

from app.engine.bankroll import StakeMethod, recommend
from app.engine.movement import summarize as movement
from app.engine.performance import SettledBet, calibration
from app.engine.performance import summarize as perf
from app.engine.scoring import (
    ConfidenceInputs,
    Rank,
    Risk,
    RiskInputs,
    assess_risk,
    confidence,
    rank,
)


def _conf(**kw):
    base = dict(
        data_quality=1.0,
        min_matches=10,
        target_matches=10,
        model_spread=0.0,
        form_drift=0.0,
        squad_score=1.0,
        bookmakers=8,
        price_dispersion=0.0,
        edge_pp=5.0,
        relative_stderr=0.0,
    )
    base.update(kw)
    return confidence(ConfidenceInputs(**base))


def test_confidence_bounds_and_monotonicity():
    assert _conf().score == 100
    assert _conf(min_matches=3).score < _conf().score
    assert _conf(model_spread=0.12).score < _conf().score
    # Huge disagreement with the market is treated as suspicious, not strong.
    assert _conf(edge_pp=25).score < _conf(edge_pp=5).score
    worst = _conf(
        data_quality=0,
        min_matches=0,
        model_spread=1,
        form_drift=5,
        squad_score=0,
        bookmakers=1,
        price_dispersion=None,
        relative_stderr=5,
        edge_pp=30,
    )
    assert 0 <= worst.score < 20


def _risk(**kw):
    base = dict(
        probability=0.7,
        stat="goals",
        data_quality=1.0,
        squad_known=True,
        key_missing=0,
        bookmakers=10,
        relative_stderr=0.1,
        movement_pct=0.0,
    )
    base.update(kw)
    return assess_risk(RiskInputs(**base))


def test_risk_levels():
    assert _risk().level is Risk.LOW
    assert _risk(probability=0.4, stat="cards").level is Risk.MEDIUM
    very = _risk(probability=0.2, data_quality=0.4, squad_known=False, bookmakers=1)
    assert very.level is Risk.VERY_HIGH
    assert "Strong market movement detected" in _risk(movement_pct=-20).factors
    assert not any("fixed" in f.lower() for f in very.factors)


def test_rank_labels():
    assert rank(12, 80, Risk.LOW)[0] is Rank.BEST_VALUE
    assert rank(12, 70, Risk.LOW)[0] is Rank.STRONG_VALUE
    assert rank(3, 50, Risk.HIGH)[0] is Rank.MODERATE_VALUE
    assert rank(1, 90, Risk.LOW)[0] is Rank.NO_VALUE
    assert rank(-15, 90, Risk.LOW)[0] is Rank.AVOID
    assert rank(20, 90, Risk.VERY_HIGH)[0] is Rank.AVOID
    assert rank(8, 20, Risk.LOW)[0] is Rank.AVOID
    r, note = rank(80, 90, Risk.LOW)
    assert r is Rank.AVOID and "verify" in note
    assert rank(None, 90, Risk.LOW)[0] is Rank.NO_VALUE


def test_risk_parse():
    assert Risk.parse("very high") is Risk.VERY_HIGH
    assert Risk.parse("MEDIUM") is Risk.MEDIUM


def test_movement_summary():
    t0 = datetime(2026, 9, 28, tzinfo=UTC)
    pts = [(t0 + timedelta(hours=i), o) for i, o in enumerate([2.0, 2.1, 1.9, 1.75])]
    m = movement(pts)
    assert (m.opening, m.current, m.lowest, m.highest) == (2.0, 1.75, 1.75, 2.1)
    assert m.movement_pct == pytest.approx(-12.5)
    assert m.direction == "shortening"
    assert m.alert == "Strong market movement detected"
    assert movement([]) is None
    assert movement([(t0, 2.0), (t0 + timedelta(hours=1), 2.02)]).alert is None


def test_bankroll_methods():
    assert recommend(5000, StakeMethod.PERCENTAGE, percent=1, cap_percent=None).stake == 50
    assert recommend(5000, StakeMethod.FIXED, fixed_amount=40).stake == 40
    full = recommend(1000, StakeMethod.KELLY, probability=0.6, odds=2.0, cap_percent=None)
    half = recommend(1000, StakeMethod.HALF_KELLY, probability=0.6, odds=2.0, cap_percent=None)
    assert full.stake == 200 and half.stake == 100
    capped = recommend(1000, StakeMethod.HALF_KELLY, probability=0.6, odds=2.0)
    assert capped.capped and capped.stake == 20  # default 2% cap
    none = recommend(1000, StakeMethod.HALF_KELLY, probability=0.5, odds=1.9)
    assert none.stake == 0 and none.note
    with pytest.raises(ValueError):
        recommend(1000, StakeMethod.KELLY)


def test_performance_summary():
    bets = [
        SettledBet(2.0, 0.55, "won", 1.0, "GOALS"),
        SettledBet(2.0, 0.55, "lost", -1.0, "GOALS"),
        SettledBet(2.0, 0.55, "lost", -1.0, "GOALS"),
        SettledBet(1.9, 0.6, "push", 0.0, "ASIAN"),
        SettledBet(3.0, 0.4, "won", 2.0, "1X2"),
        SettledBet(1.8, 0.6, "void", 0.0, "1X2"),
    ]
    s = perf(bets)
    assert s.total_bets == 6 and s.settled_bets == 5
    assert s.wins == 2 and s.losses == 2 and s.pushes == 1
    assert s.win_rate == 0.5
    assert s.profit == pytest.approx(1.0)
    assert s.roi == pytest.approx(0.2)
    assert s.max_drawdown == pytest.approx(2.0)
    assert s.brier_score is not None
    assert calibration(bets)
