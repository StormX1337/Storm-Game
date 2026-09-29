"""Joint distribution of two team counts (goals, corners or cards).

Every market the scanner prices is a function of this table: 1X2 and
handicaps of the margin, totals of the sum, team totals of one marginal and
BTTS of both. Building the table once and deriving markets from it keeps the
prices consistent with each other — the scanner never says Over 2.5 is likely
while also saying 0:0 and 1:0 are the most likely scores.
"""

from dataclasses import dataclass

from app.engine.distributions import Vector, poisson_pmf


@dataclass(frozen=True)
class JointDistribution:
    # probs[h][a] = P(home count = h, away count = a)
    probs: list[list[float]]

    @classmethod
    def independent(cls, home: Vector, away: Vector) -> "JointDistribution":
        return cls([[ph * pa for pa in away] for ph in home])

    @property
    def max_home(self) -> int:
        return len(self.probs) - 1

    @property
    def max_away(self) -> int:
        return len(self.probs[0]) - 1

    def cells(self):
        for h, row in enumerate(self.probs):
            for a, p in enumerate(row):
                yield h, a, p

    def total_distribution(self) -> dict[int, float]:
        out: dict[int, float] = {}
        for h, a, p in self.cells():
            out[h + a] = out.get(h + a, 0.0) + p
        return out

    def margin_distribution(self) -> dict[int, float]:
        """P(home - away = d)."""
        out: dict[int, float] = {}
        for h, a, p in self.cells():
            out[h - a] = out.get(h - a, 0.0) + p
        return out

    def home_distribution(self) -> dict[int, float]:
        return {h: sum(row) for h, row in enumerate(self.probs)}

    def away_distribution(self) -> dict[int, float]:
        out: dict[int, float] = {}
        for _, a, p in self.cells():
            out[a] = out.get(a, 0.0) + p
        return out

    def expected_home(self) -> float:
        return sum(h * p for h, _, p in self.cells())

    def expected_away(self) -> float:
        return sum(a * p for _, a, p in self.cells())

    def prob(self, predicate) -> float:
        return sum(p for h, a, p in self.cells() if predicate(h, a))

    def top_scores(self, n: int = 15) -> list[tuple[int, int, float]]:
        ranked = sorted(self.cells(), key=lambda c: c[2], reverse=True)
        return ranked[:n]


def dixon_coles_matrix(
    lambda_home: float, lambda_away: float, rho: float = -0.05, max_goals: int = 10
) -> JointDistribution:
    """Independent Poisson scores with the Dixon-Coles low-score correction.

    ``rho`` < 0 moves probability onto 0:0 and 1:1 and off 1:0 and 0:1, which
    is what real low-scoring football does relative to independent Poisson.
    The correction is clamped so no cell can go negative.
    """
    home = poisson_pmf(lambda_home, max_goals)
    away = poisson_pmf(lambda_away, max_goals)
    rho = _clamp_rho(rho, lambda_home, lambda_away)
    probs = [[ph * pa for pa in away] for ph in home]
    probs[0][0] *= 1 - lambda_home * lambda_away * rho
    probs[0][1] *= 1 + lambda_home * rho
    probs[1][0] *= 1 + lambda_away * rho
    probs[1][1] *= 1 - rho
    total = sum(sum(row) for row in probs)
    return JointDistribution([[p / total for p in row] for row in probs])


def _clamp_rho(rho: float, lh: float, la: float) -> float:
    # Each tau factor must stay non-negative.
    lower = max(-1 / lh if lh > 0 else -1.0, -1 / la if la > 0 else -1.0)
    upper = min(1 / (lh * la) if lh * la > 0 else 1.0, 1.0)
    return max(lower + 1e-9, min(upper - 1e-9, rho))
