from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, JSONType, utcnow

# ------------------------------------------------------------------ accounts


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16), default="user")  # user | admin
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    preferences: Mapped[dict] = mapped_column(JSONType, default=dict)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(nullable=True)


class UserSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Only a digest of the cookie value is stored: a database leak does not
    # hand out live sessions.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    expires_at: Mapped[datetime] = mapped_column()
    last_seen_at: Mapped[datetime] = mapped_column(default=utcnow)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)


# ------------------------------------------------------------------ configuration


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict | list | int | float | str | bool | None] = mapped_column(JSONType)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    updated_by: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ApiCredential(Base):
    __tablename__ = "api_credentials"

    provider: Mapped[str] = mapped_column(String(32), primary_key=True)
    encrypted_key: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    updated_by: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ApiUsage(Base):
    __tablename__ = "api_usage"
    __table_args__ = (UniqueConstraint("provider", "day", "endpoint"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(32))
    day: Mapped[str] = mapped_column(String(10))  # YYYY-MM-DD (UTC)
    endpoint: Mapped[str] = mapped_column(String(128))
    calls: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[int] = mapped_column(Integer, default=0)
    remaining: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class SystemLog(Base):
    __tablename__ = "system_logs"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)
    level: Mapped[str] = mapped_column(String(10))
    source: Mapped[str] = mapped_column(String(64))
    message: Mapped[str] = mapped_column(Text)
    context: Mapped[dict | None] = mapped_column(JSONType, nullable=True)


class JobRun(Base):
    __tablename__ = "job_runs"

    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    last_started_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_finished_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    last_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_at: Mapped[datetime | None] = mapped_column(nullable=True)


# ------------------------------------------------------------------ football data


class League(Base):
    __tablename__ = "leagues"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)  # provider league id
    name: Mapped[str] = mapped_column(String(128))
    country: Mapped[str | None] = mapped_column(String(64), nullable=True)
    logo: Mapped[str | None] = mapped_column(String(512), nullable=True)
    type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    season: Mapped[int | None] = mapped_column(Integer, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # The Odds API sport key when odds come from there (e.g. soccer_epl).
    odds_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    country: Mapped[str | None] = mapped_column(String(64), nullable=True)
    logo: Mapped[str | None] = mapped_column(String(512), nullable=True)


class Fixture(Base):
    __tablename__ = "fixtures"
    __table_args__ = (Index("ix_fixtures_kickoff", "kickoff_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)  # provider fixture id
    league_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    league_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    country: Mapped[str | None] = mapped_column(String(64), nullable=True)
    season: Mapped[int | None] = mapped_column(Integer, nullable=True)
    round: Mapped[str | None] = mapped_column(String(64), nullable=True)
    kickoff_at: Mapped[datetime] = mapped_column()
    status: Mapped[str] = mapped_column(String(8))  # NS, 1H, HT, 2H, FT, AET, PEN, PST, ...
    elapsed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    home_team_id: Mapped[int] = mapped_column(Integer, index=True)
    away_team_id: Mapped[int] = mapped_column(Integer, index=True)
    home_name: Mapped[str] = mapped_column(String(128))
    away_name: Mapped[str] = mapped_column(String(128))
    home_logo: Mapped[str | None] = mapped_column(String(512), nullable=True)
    away_logo: Mapped[str | None] = mapped_column(String(512), nullable=True)
    venue: Mapped[str | None] = mapped_column(String(128), nullable=True)
    referee: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    home_goals: Mapped[int | None] = mapped_column(Integer, nullable=True)
    away_goals: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ht_home_goals: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ht_away_goals: Mapped[int | None] = mapped_column(Integer, nullable=True)
    details_synced_at: Mapped[datetime | None] = mapped_column(nullable=True)
    odds_event_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class FixtureTeamStats(Base):
    __tablename__ = "fixture_team_stats"

    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), primary_key=True
    )
    team_id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    is_home: Mapped[bool] = mapped_column(Boolean)
    shots: Mapped[int | None] = mapped_column(Integer, nullable=True)
    shots_on_target: Mapped[int | None] = mapped_column(Integer, nullable=True)
    possession: Mapped[float | None] = mapped_column(Float, nullable=True)
    corners: Mapped[int | None] = mapped_column(Integer, nullable=True)
    yellow_cards: Mapped[int | None] = mapped_column(Integer, nullable=True)
    red_cards: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fouls: Mapped[int | None] = mapped_column(Integer, nullable=True)
    xg: Mapped[float | None] = mapped_column(Float, nullable=True)
    fh_corners: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fh_cards: Mapped[int | None] = mapped_column(Integer, nullable=True)
    raw: Mapped[dict | None] = mapped_column(JSONType, nullable=True)


class FixtureEvent(Base):
    __tablename__ = "fixture_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), index=True
    )
    team_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    minute: Mapped[int | None] = mapped_column(Integer, nullable=True)
    extra: Mapped[int | None] = mapped_column(Integer, nullable=True)
    type: Mapped[str] = mapped_column(String(16))  # Goal / Card / subst / Var
    detail: Mapped[str | None] = mapped_column(String(64), nullable=True)
    player_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    player_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    assist_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    assist_name: Mapped[str | None] = mapped_column(String(128), nullable=True)


class FixtureLineup(Base):
    __tablename__ = "fixture_lineups"

    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), primary_key=True
    )
    team_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    formation: Mapped[str | None] = mapped_column(String(16), nullable=True)
    coach: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # [{id, name, number, pos}]
    start_xi: Mapped[list] = mapped_column(JSONType, default=list)
    substitutes: Mapped[list] = mapped_column(JSONType, default=list)
    fetched_at: Mapped[datetime] = mapped_column(default=utcnow)


class Injury(Base):
    __tablename__ = "injuries"
    __table_args__ = (UniqueConstraint("fixture_id", "team_id", "player_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), index=True
    )
    team_id: Mapped[int] = mapped_column(Integer)
    player_id: Mapped[int] = mapped_column(Integer)
    player_name: Mapped[str] = mapped_column(String(128))
    type: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )  # Missing Fixture / Questionable
    reason: Mapped[str | None] = mapped_column(String(128), nullable=True)
    fetched_at: Mapped[datetime] = mapped_column(default=utcnow)


class InjuryCheck(Base):
    """Records that absences were fetched, so "none reported" differs from "unknown"."""

    __tablename__ = "injury_checks"

    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), primary_key=True
    )
    checked_at: Mapped[datetime] = mapped_column(default=utcnow)


# ------------------------------------------------------------------ odds and analysis


class OddsSnapshot(Base):
    __tablename__ = "odds_snapshots"
    __table_args__ = (
        Index("ix_odds_fixture_key_time", "fixture_id", "selection_key", "captured_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    fixture_id: Mapped[int] = mapped_column(ForeignKey("fixtures.id", ondelete="CASCADE"))
    selection_key: Mapped[str] = mapped_column(String(64))
    market: Mapped[str] = mapped_column(String(32))
    bookmaker: Mapped[str] = mapped_column(String(64))
    odds: Mapped[float] = mapped_column(Float)
    captured_at: Mapped[datetime] = mapped_column(default=utcnow)
    # A price is stored again only when it changes; until then each batch that
    # still sees it moves this forward, so "currently offered" stays knowable.
    last_seen_at: Mapped[datetime] = mapped_column(default=utcnow)
    source: Mapped[str] = mapped_column(String(32))


class FixtureAnalysis(Base):
    __tablename__ = "fixture_analyses"

    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), primary_key=True
    )
    computed_at: Mapped[datetime] = mapped_column(default=utcnow)
    payload: Mapped[dict] = mapped_column(JSONType)
    value_count: Mapped[int] = mapped_column(Integer, default=0)
    strong_count: Mapped[int] = mapped_column(Integer, default=0)
    high_risk_count: Mapped[int] = mapped_column(Integer, default=0)
    best_value_pct: Mapped[float | None] = mapped_column(Float, nullable=True)


class Signal(Base):
    """A value opportunity as it looked when the scanner flagged it.

    Signals keep updating with the market until kick-off and are frozen from
    then on, so the track record reflects prices that were actually available.
    """

    __tablename__ = "signals"
    __table_args__ = (UniqueConstraint("fixture_id", "selection_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), index=True
    )
    selection_key: Mapped[str] = mapped_column(String(64))
    market: Mapped[str] = mapped_column(String(32))
    category: Mapped[str] = mapped_column(String(16), index=True)
    label: Mapped[str] = mapped_column(String(64))
    odds: Mapped[float] = mapped_column(Float)
    bookmaker: Mapped[str | None] = mapped_column(String(64), nullable=True)
    probability: Mapped[float] = mapped_column(Float)
    fair_odds: Mapped[float] = mapped_column(Float)
    implied_probability: Mapped[float] = mapped_column(Float)
    edge_pp: Mapped[float] = mapped_column(Float)
    value_pct: Mapped[float] = mapped_column(Float)
    confidence: Mapped[int] = mapped_column(Integer)
    risk: Mapped[str] = mapped_column(String(16))
    rank: Mapped[str] = mapped_column(String(24), index=True)
    first_seen_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    result_detail: Mapped[str | None] = mapped_column(String(64), nullable=True)
    profit_units: Mapped[float | None] = mapped_column(Float, nullable=True)
    settled_at: Mapped[datetime | None] = mapped_column(nullable=True)
