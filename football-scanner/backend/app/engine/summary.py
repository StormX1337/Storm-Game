"""Descriptive team summaries for the match page.

Every figure is computed from stored matches; a figure whose inputs are
missing is ``None`` and rendered as N/A. Nothing is estimated here.
"""

from collections.abc import Callable
from datetime import datetime

from app.engine.types import MatchRecord


def _avg(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _vals(records: list[MatchRecord], get: Callable[[MatchRecord], float | int | None]):
    return [float(v) for r in records if (v := get(r)) is not None]


def _rate(records: list[MatchRecord], pred) -> float | None:
    return sum(1 for r in records if pred(r)) / len(records) if records else None


def result_letter(r: MatchRecord) -> str:
    if r.goals_for > r.goals_against:
        return "W"
    if r.goals_for < r.goals_against:
        return "L"
    return "D"


def form_block(records: list[MatchRecord]) -> dict:
    n = len(records)
    if n == 0:
        return {"matches": 0}
    gf = sum(r.goals_for for r in records)
    ga = sum(r.goals_against for r in records)
    ht = [r for r in records if r.ht_goals_for is not None and r.ht_goals_against is not None]
    return {
        "matches": n,
        "sequence": "".join(result_letter(r) for r in records),
        "wins": sum(1 for r in records if r.goals_for > r.goals_against),
        "draws": sum(1 for r in records if r.goals_for == r.goals_against),
        "losses": sum(1 for r in records if r.goals_for < r.goals_against),
        "goals_for": gf,
        "goals_against": ga,
        "goals_for_per_game": gf / n,
        "goals_against_per_game": ga / n,
        "clean_sheets": sum(1 for r in records if r.goals_against == 0),
        "btts_rate": _rate(records, lambda r: r.goals_for > 0 and r.goals_against > 0),
        "over_1_5_rate": _rate(records, lambda r: r.goals_for + r.goals_against > 1.5),
        "over_2_5_rate": _rate(records, lambda r: r.goals_for + r.goals_against > 2.5),
        "under_2_5_rate": _rate(records, lambda r: r.goals_for + r.goals_against < 2.5),
        "points_per_game": sum(
            3 if r.goals_for > r.goals_against else 1 if r.goals_for == r.goals_against else 0
            for r in records
        )
        / n,
        "ht_results": "".join(
            "W"
            if r.ht_goals_for > r.ht_goals_against  # type: ignore[operator]
            else "L"
            if r.ht_goals_for < r.ht_goals_against  # type: ignore[operator]
            else "D"
            for r in ht
        )
        or None,
        "results": [
            {
                "fixture_id": r.fixture_id,
                "date": r.date.isoformat(),
                "home": r.is_home,
                "score": f"{r.goals_for}-{r.goals_against}",
                "ht": f"{r.ht_goals_for}-{r.ht_goals_against}"
                if r.ht_goals_for is not None and r.ht_goals_against is not None
                else None,
                "result": result_letter(r),
            }
            for r in records
        ],
    }


def attack_block(records: list[MatchRecord]) -> dict:
    goals = _vals(records, lambda r: r.goals_for)
    shots = _vals(records, lambda r: r.shots_for)
    sot = _vals(records, lambda r: r.sot_for)
    with_shots = [r for r in records if r.shots_for]
    conversion = (
        sum(r.goals_for for r in with_shots) / sum(r.shots_for for r in with_shots)  # type: ignore[misc]
        if with_shots
        else None
    )
    return {
        "goals_per_game": _avg(goals),
        "xg_per_game": _avg(_vals(records, lambda r: r.xg_for)),
        "shots_per_game": _avg(shots),
        "shots_on_target_per_game": _avg(sot),
        "conversion_rate": conversion,
        "possession": _avg(_vals(records, lambda r: r.possession)),
        "big_chances_per_game": None,  # not provided by the configured data source
    }


def defence_block(records: list[MatchRecord]) -> dict:
    return {
        "conceded_per_game": _avg(_vals(records, lambda r: r.goals_against)),
        "xga_per_game": _avg(_vals(records, lambda r: r.xg_against)),
        "clean_sheets": sum(1 for r in records if r.goals_against == 0) if records else None,
        "clean_sheet_rate": _rate(records, lambda r: r.goals_against == 0),
        "shots_conceded_per_game": _avg(_vals(records, lambda r: r.shots_against)),
        "shots_on_target_conceded_per_game": _avg(_vals(records, lambda r: r.sot_against)),
        "first_half_conceded_per_game": _avg(_vals(records, lambda r: r.ht_goals_against)),
        "second_half_conceded_per_game": _avg(
            [
                float(r.goals_against - r.ht_goals_against)
                for r in records
                if r.ht_goals_against is not None
            ]
        ),
        "defensive_errors_per_game": None,  # not provided by the configured data source
    }


def count_block(records: list[MatchRecord], stat: str) -> dict:
    f = {"corners": (lambda r: r.corners_for), "cards": (lambda r: r.cards_for)}[stat]
    a = {"corners": (lambda r: r.corners_against), "cards": (lambda r: r.cards_against)}[stat]
    fhf = {"corners": (lambda r: r.fh_corners_for), "cards": (lambda r: r.fh_cards_for)}[stat]
    fha = {"corners": (lambda r: r.fh_corners_against), "cards": (lambda r: r.fh_cards_against)}[
        stat
    ]
    home = [r for r in records if r.is_home]
    away = [r for r in records if not r.is_home]
    totals = [
        float(f(r) + a(r))  # type: ignore[operator]
        for r in records
        if f(r) is not None and a(r) is not None
    ]
    return {
        "matches_with_data": len(_vals(records, f)),
        "for_per_game": _avg(_vals(records, f)),
        "against_per_game": _avg(_vals(records, a)),
        "home_for_per_game": _avg(_vals(home, f)),
        "home_against_per_game": _avg(_vals(home, a)),
        "away_for_per_game": _avg(_vals(away, f)),
        "away_against_per_game": _avg(_vals(away, a)),
        "first_half_for_per_game": _avg(_vals(records, fhf)),
        "first_half_against_per_game": _avg(_vals(records, fha)),
        "total_per_game": _avg(totals),
    }


def team_summary(records: list[MatchRecord], before: datetime, venue_home: bool) -> dict:
    past = sorted((r for r in records if r.date < before), key=lambda r: r.date, reverse=True)
    venue = [r for r in past if r.is_home == venue_home]
    return {
        "form": {
            "last5": form_block(past[:5]),
            "last10": form_block(past[:10]),
            "last15": form_block(past[:15]),
            "venue": form_block(venue[:10]),
        },
        "attack": attack_block(past[:10]),
        "defence": defence_block(past[:10]),
        "corners": count_block(past[:10], "corners"),
        "cards": count_block(past[:10], "cards"),
    }
