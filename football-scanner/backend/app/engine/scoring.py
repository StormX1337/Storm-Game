"""Confidence, risk and value ranking.

These three are deliberately separate numbers:

* probability — what the model thinks happens;
* confidence — how much the inputs behind that probability can be trusted;
* risk — how likely the result is to swing regardless of the estimate.

A 68% probability with 84/100 confidence is still a 68% probability.
"""

from dataclasses import dataclass, field
from enum import IntEnum, StrEnum


class Risk(IntEnum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3
    VERY_HIGH = 4

    @property
    def label(self) -> str:
        return self.name.replace("_", " ")

    @classmethod
    def parse(cls, value: str) -> "Risk":
        return cls[value.strip().upper().replace(" ", "_")]


class Rank(StrEnum):
    BEST_VALUE = "BEST_VALUE"
    STRONG_VALUE = "STRONG_VALUE"
    MODERATE_VALUE = "MODERATE_VALUE"
    NO_VALUE = "NO_VALUE"
    AVOID = "AVOID"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


RANK_ORDER = {
    Rank.BEST_VALUE: 0,
    Rank.STRONG_VALUE: 1,
    Rank.MODERATE_VALUE: 2,
    Rank.NO_VALUE: 3,
    Rank.AVOID: 4,
    Rank.INSUFFICIENT_DATA: 5,
}


@dataclass(frozen=True)
class ConfidenceInputs:
    data_quality: float  # 0..1 share of the needed statistics actually present
    min_matches: int
    target_matches: int
    model_spread: float | None  # max-min probability across models; None = one model
    form_drift: float | None  # |form rate - season rate| / season rate
    squad_score: float  # 0..1
    bookmakers: int
    price_dispersion: float | None  # coefficient of variation across books
    edge_pp: float | None
    relative_stderr: float


CONFIDENCE_WEIGHTS = {
    "data_quality": 0.20,
    "sample_size": 0.15,
    "model_agreement": 0.15,
    "form": 0.10,
    "squad": 0.15,
    "market_consistency": 0.15,
    "statistical_stability": 0.10,
}


@dataclass(frozen=True)
class Confidence:
    score: int
    components: dict[str, float]


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def confidence(inp: ConfidenceInputs) -> Confidence:
    comp = {
        "data_quality": _clamp(inp.data_quality),
        "sample_size": _clamp(inp.min_matches / max(1, inp.target_matches)),
        "model_agreement": 0.5 if inp.model_spread is None else _clamp(1 - inp.model_spread / 0.15),
        "form": 0.5 if inp.form_drift is None else _clamp(1 - inp.form_drift / 0.5),
        "squad": _clamp(inp.squad_score),
        "market_consistency": _market_consistency(inp),
        "statistical_stability": _clamp(1 - inp.relative_stderr / 0.5),
    }
    score = sum(CONFIDENCE_WEIGHTS[k] * v for k, v in comp.items()) * 100
    return Confidence(score=round(score), components={k: round(v, 3) for k, v in comp.items()})


def _market_consistency(inp: ConfidenceInputs) -> float:
    if inp.bookmakers <= 0:
        return 0.5
    base = (
        0.5
        if inp.bookmakers == 1 or inp.price_dispersion is None
        else _clamp(1 - inp.price_dispersion / 0.08)
    )
    # A model that disagrees with the whole market by a huge margin is more
    # often missing information than finding value.
    if inp.edge_pp is not None and abs(inp.edge_pp) > 15:
        base *= 0.6
    return base


def squad_score(lineup_confirmed: bool | None, injuries_known: bool, key_missing: int) -> float:
    if lineup_confirmed:
        base = 1.0
    elif injuries_known:
        base = 0.8
    else:
        base = 0.5
    return max(0.2, base - 0.1 * key_missing)


@dataclass(frozen=True)
class RiskInputs:
    probability: float
    stat: str  # goals / corners / cards
    data_quality: float
    squad_known: bool
    key_missing: int
    bookmakers: int
    relative_stderr: float
    movement_pct: float | None


@dataclass(frozen=True)
class RiskAssessment:
    level: Risk
    points: float
    factors: list[str] = field(default_factory=list)


def assess_risk(inp: RiskInputs) -> RiskAssessment:
    points = 0.0
    factors: list[str] = []

    p = inp.probability
    if p < 0.30:
        points += 3
        factors.append("Low-probability outcome (high volatility)")
    elif p < 0.45:
        points += 2
        factors.append("Below-even outcome (elevated volatility)")
    elif p < 0.60:
        points += 1
    if inp.stat == "cards":
        points += 1
        factors.append("Cards depend on referee and game state")
    elif inp.stat == "corners":
        points += 0.5

    if inp.data_quality < 0.6:
        points += 2
        factors.append("Incomplete statistics")
    elif inp.data_quality < 0.8:
        points += 1
        factors.append("Some statistics missing")

    if not inp.squad_known:
        points += 1
        factors.append("Line-ups and absences not confirmed")
    if inp.key_missing:
        points += 1
        factors.append(f"{inp.key_missing} key player(s) missing")

    if inp.bookmakers < 2:
        points += 2
        factors.append("Thin market (fewer than 2 bookmakers)")
    elif inp.bookmakers < 4:
        points += 1
        factors.append("Limited market liquidity")

    if inp.relative_stderr > 0.35:
        points += 2
        factors.append("High statistical variance")
    elif inp.relative_stderr > 0.2:
        points += 1

    if inp.movement_pct is not None:
        move = abs(inp.movement_pct)
        if move >= 15:
            points += 2
            factors.append("Strong market movement detected")
        elif move >= 8:
            points += 1
            factors.append("Notable odds movement")

    if points <= 1.5:
        level = Risk.LOW
    elif points <= 3.5:
        level = Risk.MEDIUM
    elif points <= 5.5:
        level = Risk.HIGH
    else:
        level = Risk.VERY_HIGH
    return RiskAssessment(level=level, points=points, factors=factors)


@dataclass(frozen=True)
class RankThresholds:
    best_value: float = 10.0
    best_confidence: int = 75
    strong_value: float = 6.0
    strong_confidence: int = 60
    moderate_value: float = 2.0
    moderate_confidence: int = 45
    avoid_value: float = -10.0
    unreliable_confidence: int = 35
    implausible_value: float = 50.0


def rank(
    value_pct: float | None,
    confidence_score: int,
    risk: Risk,
    thresholds: RankThresholds = RankThresholds(),
) -> tuple[Rank, str | None]:
    """Label for the quality of the statistical signal — never a promise."""
    t = thresholds
    if value_pct is None:
        return Rank.NO_VALUE, "No odds available"
    if value_pct > t.implausible_value:
        return Rank.AVOID, "Edge implausibly large — verify data before trusting it"
    if value_pct <= t.avoid_value:
        return Rank.AVOID, None
    if risk is Risk.VERY_HIGH:
        return Rank.AVOID, "Very high risk"
    if value_pct > 0 and confidence_score < t.unreliable_confidence:
        return Rank.AVOID, "Positive value but confidence too low to rely on"
    if value_pct >= t.best_value and confidence_score >= t.best_confidence and risk <= Risk.MEDIUM:
        return Rank.BEST_VALUE, None
    if (
        value_pct >= t.strong_value
        and confidence_score >= t.strong_confidence
        and risk <= Risk.MEDIUM
    ):
        return Rank.STRONG_VALUE, None
    if (
        value_pct >= t.moderate_value
        and confidence_score >= t.moderate_confidence
        and risk <= Risk.HIGH
    ):
        return Rank.MODERATE_VALUE, None
    return Rank.NO_VALUE, None
