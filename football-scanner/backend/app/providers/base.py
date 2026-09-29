"""Provider-neutral data shapes and the interfaces providers implement.

Services talk only to these interfaces, so switching data vendor means writing
one adapter — nothing upstream changes.
"""

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Protocol

from app.engine.markets import Selection


class ProviderError(Exception):
    pass


class ProviderNotConfigured(ProviderError):
    pass


@dataclass(frozen=True)
class LeagueDTO:
    id: int
    name: str
    country: str | None
    logo: str | None
    type: str | None
    season: int | None


@dataclass(frozen=True)
class TeamRef:
    id: int
    name: str
    logo: str | None = None


@dataclass(frozen=True)
class FixtureDTO:
    id: int
    league_id: int | None
    league_name: str | None
    country: str | None
    season: int | None
    round: str | None
    kickoff: datetime
    status: str
    elapsed: int | None
    home: TeamRef
    away: TeamRef
    venue: str | None = None
    referee: str | None = None
    home_goals: int | None = None
    away_goals: int | None = None
    ht_home_goals: int | None = None
    ht_away_goals: int | None = None


@dataclass(frozen=True)
class TeamStatsDTO:
    team_id: int
    shots: int | None = None
    shots_on_target: int | None = None
    possession: float | None = None
    corners: int | None = None
    yellow_cards: int | None = None
    red_cards: int | None = None
    fouls: int | None = None
    xg: float | None = None
    fh_corners: int | None = None
    fh_cards: int | None = None
    raw: dict | None = None


@dataclass(frozen=True)
class EventDTO:
    team_id: int | None
    minute: int | None
    extra: int | None
    type: str
    detail: str | None
    player_id: int | None
    player_name: str | None
    assist_id: int | None = None
    assist_name: str | None = None


@dataclass(frozen=True)
class LineupDTO:
    team_id: int
    formation: str | None
    coach: str | None
    start_xi: list[dict]
    substitutes: list[dict]


@dataclass(frozen=True)
class FixtureDetailsDTO:
    fixture: FixtureDTO
    stats: list[TeamStatsDTO] = field(default_factory=list)
    events: list[EventDTO] = field(default_factory=list)
    lineups: list[LineupDTO] = field(default_factory=list)


@dataclass(frozen=True)
class InjuryDTO:
    fixture_id: int
    team_id: int
    player_id: int
    player_name: str
    type: str | None
    reason: str | None


@dataclass(frozen=True)
class PriceDTO:
    selection: Selection
    bookmaker: str
    odds: float


@dataclass(frozen=True)
class FixtureRef:
    """What an odds provider needs to find a fixture in its own catalogue."""

    id: int
    league_id: int | None
    season: int | None
    kickoff: datetime
    home_name: str
    away_name: str
    odds_key: str | None = None  # provider-specific competition key
    odds_event_id: str | None = None


class FootballDataProvider(Protocol):
    name: str

    def leagues(self) -> list[LeagueDTO]: ...

    def fixtures_between(
        self, league_id: int, season: int, start: date, end: date
    ) -> list[FixtureDTO]: ...

    def league_season_fixtures(self, league_id: int, season: int) -> list[FixtureDTO]: ...

    def team_last_fixtures(self, team_id: int, last: int) -> list[FixtureDTO]: ...

    def fixture_details(self, ids: list[int]) -> list[FixtureDetailsDTO]: ...

    def injuries(self, fixture_id: int) -> list[InjuryDTO]: ...

    def head_to_head(self, home_id: int, away_id: int, last: int) -> list[FixtureDTO]: ...

    def live_fixtures(self) -> list[FixtureDTO]: ...


class OddsProvider(Protocol):
    name: str

    def prices(self, fixtures: list[FixtureRef]) -> dict[int, list[PriceDTO]]:
        """Prices keyed by our fixture id; fixtures it cannot match are absent."""
        ...
