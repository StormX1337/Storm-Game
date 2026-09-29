"""Grades locked signals once their fixture is over."""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engine.markets import Selection, grade, profit_units
from app.models import Fixture, FixtureTeamStats, Signal
from app.services.sync import FINISHED, VOID


def _counts(db: Session, fx: Fixture, stat: str) -> tuple[int, int] | None:
    if stat == "goals":
        if fx.home_goals is None or fx.away_goals is None:
            return None
        return fx.home_goals, fx.away_goals
    if fx.status != "FT":
        # Provider corner/card totals include extra time; bookmakers settle
        # on 90 minutes, so these cannot be graded honestly.
        return None
    rows = {
        r.team_id: r
        for r in db.scalars(select(FixtureTeamStats).where(FixtureTeamStats.fixture_id == fx.id))
    }
    h, a = rows.get(fx.home_team_id), rows.get(fx.away_team_id)
    if h is None or a is None:
        return None
    if stat == "corners":
        if h.corners is None or a.corners is None:
            return None
        return h.corners, a.corners
    if h.yellow_cards is None and h.red_cards is None:
        return None
    if a.yellow_cards is None and a.red_cards is None:
        return None
    return (h.yellow_cards or 0) + (h.red_cards or 0), (a.yellow_cards or 0) + (a.red_cards or 0)


def settle(db: Session) -> int:
    now = datetime.now(UTC)
    n = 0
    pending = db.scalars(
        select(Signal).where(Signal.status == "pending", Signal.locked.is_(True))
    ).all()
    for sig in pending:
        fx = db.get(Fixture, sig.fixture_id)
        if fx is None:
            continue
        if fx.status in VOID:
            sig.status, sig.profit_units, sig.settled_at = "void", 0.0, now
            sig.result_detail = f"Fixture {fx.status}"
            n += 1
            continue
        if fx.status not in FINISHED:
            continue
        selection = Selection.from_key(sig.selection_key)
        counts = _counts(db, fx, selection.stat)
        if counts is None:
            if selection.stat != "goals" and (
                fx.status != "FT" or fx.details_synced_at is not None
            ):
                sig.status, sig.profit_units, sig.settled_at = "void", 0.0, now
                sig.result_detail = f"{selection.stat} not gradable on 90 minutes"
                n += 1
            continue
        outcome = grade(selection, *counts)
        sig.status = outcome.value
        sig.profit_units = round(profit_units(outcome, sig.odds), 4)
        sig.result_detail = f"{counts[0]}-{counts[1]} {selection.stat}"
        sig.settled_at = now
        n += 1
    db.commit()
    return n
