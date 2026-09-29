"""Plain data the engine consumes. No ORM, no HTTP: the engine is pure."""

from dataclasses import dataclass, field
from datetime import datetime

from app.engine.markets import Selection


@dataclass(frozen=True)
class MatchRecord:
    """One finished match from one team's point of view.

    Every statistic other than goals is optional: providers do not cover every
    league, and a missing value must stay missing rather than become zero.
    """

    fixture_id: int
    date: datetime
    is_home: bool
    opponent_id: int
    goals_for: int
    goals_against: int
    xg_for: float | None = None
    xg_against: float | None = None
    corners_for: int | None = None
    corners_against: int | None = None
    cards_for: int | None = None
    cards_against: int | None = None
    shots_for: int | None = None
    shots_against: int | None = None
    sot_for: int | None = None
    sot_against: int | None = None
    possession: float | None = None
    ht_goals_for: int | None = None
    ht_goals_against: int | None = None
    fh_corners_for: int | None = None
    fh_corners_against: int | None = None
    fh_cards_for: int | None = None
    fh_cards_against: int | None = None
    competition_id: int | None = None
    referee: str | None = None


@dataclass(frozen=True)
class StatBaseline:
    """League averages of a count per team per match, split by venue."""

    home_mean: float
    away_mean: float
    home_var: float
    away_var: float
    matches: int


@dataclass(frozen=True)
class LeagueBaseline:
    goals: StatBaseline | None
    xg: StatBaseline | None
    corners: StatBaseline | None
    cards: StatBaseline | None


@dataclass(frozen=True)
class SquadStatus:
    """What is known about one side's availability for this fixture.

    ``None`` means the provider gave no information, which is different from
    "nobody is missing" and is scored differently for confidence and risk.
    """

    lineup_confirmed: bool | None = None
    injuries_known: bool = False
    missing_players: list[str] = field(default_factory=list)
    missing_goal_share: float | None = None  # share of team goals+assists missing
    missing_key_defenders: int = 0
    returning_players: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class RefereeProfile:
    name: str
    matches: int
    avg_cards: float
    avg_fouls: float | None = None
    avg_home_cards: float | None = None
    avg_away_cards: float | None = None


@dataclass(frozen=True)
class Schedule:
    rest_days: float | None
    matches_last_7: int
    matches_last_14: int
    travel_km: float | None = None


@dataclass(frozen=True)
class Quote:
    """Best available price for one selection plus market context."""

    selection: Selection
    odds: float
    bookmaker: str
    bookmakers: int = 1
    prices: tuple[float, ...] = ()
    opening_odds: float | None = None
    no_vig_probability: float | None = None


@dataclass(frozen=True)
class MatchContext:
    fixture_id: int
    kickoff: datetime
    home_id: int
    away_id: int
    home_history: list[MatchRecord]
    away_history: list[MatchRecord]
    league: LeagueBaseline
    home_squad: SquadStatus = field(default_factory=SquadStatus)
    away_squad: SquadStatus = field(default_factory=SquadStatus)
    referee: RefereeProfile | None = None
    home_schedule: Schedule | None = None
    away_schedule: Schedule | None = None
    quotes: list[Quote] = field(default_factory=list)
