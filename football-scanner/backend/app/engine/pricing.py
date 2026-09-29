"""Odds arithmetic: implied probability, margin removal, fair odds, EV, Kelly.

The model's probability is always computed first and independently of the
bookmaker; nothing here ever feeds a price back into a probability.
"""

from dataclasses import dataclass

from app.engine.markets import OutcomeProbabilities


def implied_probability(odds: float) -> float:
    if odds <= 1:
        raise ValueError("decimal odds must be greater than 1")
    return 1 / odds


def overround(odds: list[float]) -> float:
    """Bookmaker margin of a complete set of mutually exclusive outcomes."""
    return sum(1 / o for o in odds) - 1


def remove_margin(odds: list[float]) -> list[float]:
    """Proportional (basic normalisation) no-vig probabilities."""
    raw = [1 / o for o in odds]
    total = sum(raw)
    return [r / total for r in raw]


def fair_odds(probability: float) -> float | None:
    if probability <= 0:
        return None
    return 1 / probability


@dataclass(frozen=True)
class ValueAssessment:
    probability: float  # model, push-excluded
    fair_odds: float | None
    odds: float | None
    implied_probability: float | None  # raw 1/odds, as the spec shows it
    no_vig_probability: float | None  # margin removed across the market
    edge_pp: float | None  # model - implied, percentage points
    value_pct: float | None  # expected return per unit staked, in %
    push_probability: float


def assess(
    outcome: OutcomeProbabilities, odds: float | None, no_vig: float | None = None
) -> ValueAssessment:
    p = outcome.effective_probability
    if odds is None or odds <= 1:
        return ValueAssessment(
            probability=p,
            fair_odds=fair_odds(p),
            odds=None,
            implied_probability=None,
            no_vig_probability=no_vig,
            edge_pp=None,
            value_pct=None,
            push_probability=outcome.push,
        )
    implied = implied_probability(odds)
    return ValueAssessment(
        probability=p,
        fair_odds=fair_odds(p),
        odds=odds,
        implied_probability=implied,
        no_vig_probability=no_vig,
        edge_pp=(p - implied) * 100,
        value_pct=outcome.expected_value(odds) * 100,
        push_probability=outcome.push,
    )


def kelly_fraction(probability: float, odds: float) -> float:
    """Full-Kelly fraction of bankroll; zero when there is no edge."""
    b = odds - 1
    if b <= 0:
        return 0.0
    f = (b * probability - (1 - probability)) / b
    return max(0.0, f)
