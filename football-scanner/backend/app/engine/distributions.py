"""Count distributions used by the goal, corner and card models.

Everything returns a plain list of probabilities indexed by count, truncated
at ``max_count`` with the tail mass folded into the last bucket so the vector
always sums to one. Pure Python: the vectors are short and the dependency is
not worth it.
"""

import math

Vector = list[float]


def poisson_pmf(mean: float, max_count: int) -> Vector:
    if mean < 0:
        raise ValueError("mean must be non-negative")
    if mean == 0:
        return [1.0] + [0.0] * max_count
    probs = []
    log_mean = math.log(mean)
    for k in range(max_count + 1):
        probs.append(math.exp(k * log_mean - mean - math.lgamma(k + 1)))
    return _fold_tail(probs)


def negative_binomial_pmf(mean: float, dispersion: float | None, max_count: int) -> Vector:
    """Negative binomial parameterised by mean and size ``r``.

    Variance is ``mean + mean**2 / r``. Corner and card counts are usually
    over-dispersed relative to Poisson; with no usable dispersion estimate
    (``None`` or non-positive) this degrades to Poisson rather than guessing.
    """
    if dispersion is None or dispersion <= 0 or not math.isfinite(dispersion):
        return poisson_pmf(mean, max_count)
    if mean == 0:
        return [1.0] + [0.0] * max_count
    r = dispersion
    p = r / (r + mean)
    probs = []
    for k in range(max_count + 1):
        log_pmf = (
            math.lgamma(k + r)
            - math.lgamma(r)
            - math.lgamma(k + 1)
            + r * math.log(p)
            + k * math.log1p(-p)
        )
        probs.append(math.exp(log_pmf))
    return _fold_tail(probs)


def estimate_dispersion(mean: float, variance: float) -> float | None:
    """Method-of-moments size parameter; ``None`` when data is not over-dispersed."""
    if mean <= 0 or variance <= mean:
        return None
    return mean * mean / (variance - mean)


def convolve(a: Vector, b: Vector, max_count: int | None = None) -> Vector:
    size = len(a) + len(b) - 1
    out = [0.0] * size
    for i, pa in enumerate(a):
        if pa == 0:
            continue
        for j, pb in enumerate(b):
            out[i + j] += pa * pb
    if max_count is not None and len(out) > max_count + 1:
        out = out[:max_count] + [sum(out[max_count:])]
    return out


def mean_of(vector: Vector) -> float:
    return sum(k * p for k, p in enumerate(vector))


def _fold_tail(probs: Vector) -> Vector:
    total = sum(probs)
    if total < 1.0:
        probs[-1] += 1.0 - total
    else:
        probs = [p / total for p in probs]
    return probs
