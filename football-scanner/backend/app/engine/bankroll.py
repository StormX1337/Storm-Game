"""Stake sizing.

Stakes depend only on the bankroll, the method and — for Kelly — the model's
probability and the price. They never depend on previous results: there is no
chasing losses and no progression after a loss.
"""

from dataclasses import dataclass
from enum import StrEnum

from app.engine.pricing import kelly_fraction


class StakeMethod(StrEnum):
    FIXED = "fixed"
    PERCENTAGE = "percentage"
    KELLY = "kelly"
    HALF_KELLY = "half_kelly"


DEFAULT_METHOD = StakeMethod.HALF_KELLY
DEFAULT_CAP_PERCENT = 2.0


@dataclass(frozen=True)
class StakeRecommendation:
    method: StakeMethod
    stake: float
    fraction_of_bankroll: float
    uncapped_stake: float
    capped: bool
    note: str | None = None


def recommend(
    bankroll: float,
    method: StakeMethod = DEFAULT_METHOD,
    *,
    fixed_amount: float | None = None,
    percent: float | None = None,
    probability: float | None = None,
    odds: float | None = None,
    cap_percent: float | None = DEFAULT_CAP_PERCENT,
) -> StakeRecommendation:
    if bankroll <= 0:
        raise ValueError("bankroll must be positive")

    note = None
    if method is StakeMethod.FIXED:
        if fixed_amount is None or fixed_amount < 0:
            raise ValueError("fixed stake needs a non-negative amount")
        raw = fixed_amount
    elif method is StakeMethod.PERCENTAGE:
        if percent is None or not 0 <= percent <= 100:
            raise ValueError("percentage stake needs a percent between 0 and 100")
        raw = bankroll * percent / 100
    else:
        if probability is None or odds is None:
            raise ValueError("Kelly needs the model probability and the odds")
        if not 0 < probability < 1 or odds <= 1:
            raise ValueError("probability must be in (0, 1) and odds above 1")
        f = kelly_fraction(probability, odds)
        if method is StakeMethod.HALF_KELLY:
            f /= 2
        raw = bankroll * f
        if f == 0:
            note = "No edge at this price — Kelly recommends no stake"

    stake = raw
    capped = False
    if cap_percent is not None and cap_percent > 0:
        cap = bankroll * cap_percent / 100
        if raw > cap:
            stake = cap
            capped = True
    stake = min(stake, bankroll)
    return StakeRecommendation(
        method=method,
        stake=round(stake, 2),
        fraction_of_bankroll=stake / bankroll,
        uncapped_stake=round(raw, 2),
        capped=capped,
        note=note,
    )
