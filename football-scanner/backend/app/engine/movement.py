"""Odds movement summary.

Movement is reported as what it is — a change in price. It is never read as
evidence that a match is manipulated; the strongest wording the scanner uses
is "Strong market movement detected".
"""

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class MovementSummary:
    opening: float
    current: float
    lowest: float
    highest: float
    movement_pct: float
    opened_at: datetime
    updated_at: datetime
    samples: int
    direction: str  # shortening / drifting / stable
    alert: str | None


def summarize(
    points: list[tuple[datetime, float]], strong_pct: float = 10.0
) -> MovementSummary | None:
    if not points:
        return None
    ordered = sorted(points, key=lambda p: p[0])
    opening = ordered[0][1]
    current = ordered[-1][1]
    prices = [p for _, p in ordered]
    movement = (current - opening) / opening * 100
    if movement <= -0.5:
        direction = "shortening"
    elif movement >= 0.5:
        direction = "drifting"
    else:
        direction = "stable"
    alert = "Strong market movement detected" if abs(movement) >= strong_pct else None
    return MovementSummary(
        opening=opening,
        current=current,
        lowest=min(prices),
        highest=max(prices),
        movement_pct=movement,
        opened_at=ordered[0][0],
        updated_at=ordered[-1][0],
        samples=len(ordered),
        direction=direction,
        alert=alert,
    )
