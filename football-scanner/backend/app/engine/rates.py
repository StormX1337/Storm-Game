"""Expected counts (goals, xG, corners, cards) for each side of a fixture.

Each team gets an attack index (how much it produces relative to the league
at that venue) and a defence index (how much it concedes). A fixture's
expected count is the league venue mean scaled by the home side's attack and
the away side's defence, and vice versa. Indices are time-decayed, weight the
relevant venue more heavily and are shrunk toward 1.0 so a team with three
matches of data is not priced as if it had thirty.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from app.engine.types import MatchRecord, StatBaseline

Getter = Callable[[MatchRecord], float | int | None]


@dataclass(frozen=True)
class ModelSpec:
    name: str
    half_life_days: float | None  # None: equal weights
    max_matches: int
    venue_weight: float
    prior_weight: float


SEASON = ModelSpec("season", half_life_days=120, max_matches=20, venue_weight=1.5, prior_weight=3)
FORM = ModelSpec("form", half_life_days=None, max_matches=6, venue_weight=1.0, prior_weight=3)


@dataclass(frozen=True)
class TeamIndex:
    attack: float
    defence: float
    matches: int
    effective_weight: float


@dataclass(frozen=True)
class RateEstimate:
    model: str
    lambda_home: float
    lambda_away: float
    home: TeamIndex
    away: TeamIndex

    @property
    def min_matches(self) -> int:
        return min(self.home.matches, self.away.matches)

    def relative_stderr(self) -> float:
        """Rough relative standard error of the total, from Poisson noise."""
        n = max(1e-9, min(self.home.effective_weight, self.away.effective_weight))
        total = self.lambda_home + self.lambda_away
        if total <= 0:
            return 1.0
        return math.sqrt(total / n) / total


def team_index(
    records: list[MatchRecord],
    target_home: bool,
    baseline: StatBaseline,
    get_for: Getter,
    get_against: Getter,
    ref_date: datetime,
    spec: ModelSpec,
) -> TeamIndex | None:
    usable = [
        r
        for r in sorted(records, key=lambda r: r.date, reverse=True)
        if r.date < ref_date and get_for(r) is not None and get_against(r) is not None
    ][: spec.max_matches]
    if not usable or baseline.home_mean <= 0 or baseline.away_mean <= 0:
        return None

    att_num = def_num = weight_sum = 0.0
    for r in usable:
        w = 1.0
        if spec.half_life_days:
            age = max(0.0, (ref_date - r.date).total_seconds() / 86400)
            w = 0.5 ** (age / spec.half_life_days)
        if r.is_home == target_home:
            w *= spec.venue_weight
        produced_mean = baseline.home_mean if r.is_home else baseline.away_mean
        conceded_mean = baseline.away_mean if r.is_home else baseline.home_mean
        att_num += w * float(get_for(r)) / produced_mean  # type: ignore[arg-type]
        def_num += w * float(get_against(r)) / conceded_mean  # type: ignore[arg-type]
        weight_sum += w

    k = spec.prior_weight
    return TeamIndex(
        attack=(att_num + k) / (weight_sum + k),
        defence=(def_num + k) / (weight_sum + k),
        matches=len(usable),
        effective_weight=weight_sum,
    )


def estimate(
    home_records: list[MatchRecord],
    away_records: list[MatchRecord],
    baseline: StatBaseline | None,
    get_for: Getter,
    get_against: Getter,
    ref_date: datetime,
    spec: ModelSpec,
    min_matches: int,
) -> RateEstimate | None:
    if baseline is None:
        return None
    home = team_index(home_records, True, baseline, get_for, get_against, ref_date, spec)
    away = team_index(away_records, False, baseline, get_for, get_against, ref_date, spec)
    if home is None or away is None:
        return None
    if min(home.matches, away.matches) < min_matches:
        return None
    return RateEstimate(
        model=spec.name,
        lambda_home=baseline.home_mean * home.attack * away.defence,
        lambda_away=baseline.away_mean * away.attack * home.defence,
        home=home,
        away=away,
    )


def blend(estimates: list[tuple[RateEstimate, float]]) -> tuple[float, float]:
    total_w = sum(w for _, w in estimates)
    if total_w <= 0:
        raise ValueError("no weight to blend")
    lh = sum(e.lambda_home * w for e, w in estimates) / total_w
    la = sum(e.lambda_away * w for e, w in estimates) / total_w
    return lh, la


def baseline_from_pairs(pairs: list[tuple[float, float]]) -> StatBaseline | None:
    """League baseline from (home count, away count) per match."""
    if not pairs:
        return None
    n = len(pairs)
    hm = sum(h for h, _ in pairs) / n
    am = sum(a for _, a in pairs) / n
    hv = sum((h - hm) ** 2 for h, _ in pairs) / (n - 1) if n > 1 else 0.0
    av = sum((a - am) ** 2 for _, a in pairs) / (n - 1) if n > 1 else 0.0
    return StatBaseline(home_mean=hm, away_mean=am, home_var=hv, away_var=av, matches=n)


# Getters
def goals_for(r: MatchRecord):
    return r.goals_for


def goals_against(r: MatchRecord):
    return r.goals_against


def xg_for(r: MatchRecord):
    return r.xg_for


def xg_against(r: MatchRecord):
    return r.xg_against


def corners_for(r: MatchRecord):
    return r.corners_for


def corners_against(r: MatchRecord):
    return r.corners_against


def cards_for(r: MatchRecord):
    return r.cards_for


def cards_against(r: MatchRecord):
    return r.cards_against
