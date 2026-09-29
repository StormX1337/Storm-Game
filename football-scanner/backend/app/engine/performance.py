"""Track-record statistics over settled signals, at a flat one-unit stake."""

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class SettledBet:
    odds: float
    probability: float
    outcome: str  # won / half_won / push / half_lost / lost / void
    profit: float  # units at a one-unit stake
    category: str


@dataclass(frozen=True)
class PerformanceSummary:
    total_bets: int
    settled_bets: int
    wins: int
    losses: int
    pushes: int
    win_rate: float | None
    average_odds: float | None
    profit: float
    staked: float
    roi: float | None
    max_drawdown: float
    brier_score: float | None
    log_loss: float | None


def summarize(bets: list[SettledBet]) -> PerformanceSummary:
    """``bets`` must be in settlement order; drawdown depends on it."""
    graded = [b for b in bets if b.outcome != "void"]
    wins = sum(1 for b in graded if b.outcome in ("won", "half_won"))
    losses = sum(1 for b in graded if b.outcome in ("lost", "half_lost"))
    pushes = sum(1 for b in graded if b.outcome == "push")
    decided = wins + losses
    staked = float(len(graded))
    profit = sum(b.profit for b in graded)

    peak = cum = drawdown = 0.0
    for b in graded:
        cum += b.profit
        peak = max(peak, cum)
        drawdown = max(drawdown, peak - cum)

    binary = [b for b in graded if b.outcome in ("won", "lost")]
    brier = logloss = None
    if binary:
        brier = sum((b.probability - (b.outcome == "won")) ** 2 for b in binary) / len(binary)
        eps = 1e-6
        logloss = -sum(
            math.log(max(eps, b.probability if b.outcome == "won" else 1 - b.probability))
            for b in binary
        ) / len(binary)

    return PerformanceSummary(
        total_bets=len(bets),
        settled_bets=len(graded),
        wins=wins,
        losses=losses,
        pushes=pushes,
        win_rate=wins / decided if decided else None,
        average_odds=sum(b.odds for b in graded) / len(graded) if graded else None,
        profit=round(profit, 4),
        staked=staked,
        roi=profit / staked if staked else None,
        max_drawdown=round(drawdown, 4),
        brier_score=brier,
        log_loss=logloss,
    )


def calibration(bets: list[SettledBet], bins: int = 10) -> list[dict]:
    """Predicted vs observed win rate per probability bucket (won/lost only)."""
    buckets: list[list[SettledBet]] = [[] for _ in range(bins)]
    for b in bets:
        if b.outcome not in ("won", "lost"):
            continue
        idx = min(bins - 1, int(b.probability * bins))
        buckets[idx].append(b)
    out = []
    for i, bucket in enumerate(buckets):
        if not bucket:
            continue
        out.append(
            {
                "bucket": f"{i * 100 // bins}-{(i + 1) * 100 // bins}%",
                "count": len(bucket),
                "predicted": sum(b.probability for b in bucket) / len(bucket),
                "observed": sum(1 for b in bucket if b.outcome == "won") / len(bucket),
            }
        )
    return out
