"""SQLAlchemy-Modelle.

Zeitreihen (``odds_snapshots``, ``odds_changes``) sind der mit Abstand größte
Teil der Daten. Sie sind deshalb schmal gehalten und über
``(selection_id, ts DESC)`` indiziert; die Alembic-Migration ergänzt auf
PostgreSQL zusätzlich einen BRIN-Index über ``ts``, der bei streng monoton
wachsenden Zeitstempeln nur einen Bruchteil eines B-Trees kostet.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

#: JSON portabel: JSONB auf PostgreSQL, JSON überall sonst (Tests mit SQLite).
JSONType = JSON().with_variant(JSONB(), "postgresql")

#: SQLite kennt nur ``INTEGER PRIMARY KEY`` als Autoincrement-Spalte. Für die
#: Tests wird BIGINT dort deshalb auf INTEGER abgebildet; PostgreSQL bekommt
#: weiterhin echtes BIGINT für die Zeitreihen.
BigIntType = BigInteger().with_variant(Integer(), "sqlite")

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Bookmaker(Base):
    __tablename__ = "bookmakers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(128), default="")
    is_exchange: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    sport: Mapped[str] = mapped_column(String(16), index=True)
    league: Mapped[str | None] = mapped_column(String(128), nullable=True)
    home: Mapped[str] = mapped_column(String(128))
    away: Mapped[str] = mapped_column(String(128))
    start_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(16), index=True, default="UNKNOWN")
    score_home: Mapped[int | None] = mapped_column(Integer, nullable=True)
    score_away: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Sportartspezifische Live-Details (Minute/Karten bzw. Satz/Game/Punkte).
    #: Nicht gelieferte Felder fehlen hier - sie werden nicht ergänzt.
    live_state: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    providers: Mapped[list | None] = mapped_column(JSONType, nullable=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, index=True
    )

    markets: Mapped[list[Market]] = relationship(back_populates="event", lazy="noload")

    __table_args__ = (Index("ix_events_sport_status", "sport", "status"),)


class Market(Base):
    __tablename__ = "markets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("events.id", ondelete="CASCADE"), index=True
    )
    market_key: Mapped[str] = mapped_column(String(96))
    market_type: Mapped[str] = mapped_column(String(32), index=True)
    line: Mapped[float | None] = mapped_column(Float, nullable=True)
    period: Mapped[str] = mapped_column(String(24), default="full_time")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    event: Mapped[Event] = relationship(back_populates="markets", lazy="noload")
    selections: Mapped[list[SelectionRow]] = relationship(back_populates="market", lazy="noload")

    __table_args__ = (UniqueConstraint("event_id", "market_key", name="uq_markets_event_market"),)


class SelectionRow(Base):
    __tablename__ = "selections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    market_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("markets.id", ondelete="CASCADE"), index=True
    )
    selection_key: Mapped[str] = mapped_column(String(96))
    label: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    market: Mapped[Market] = relationship(back_populates="selections", lazy="noload")

    __table_args__ = (
        UniqueConstraint("market_id", "selection_key", name="uq_selections_market_selection"),
    )


class OddsSnapshot(Base):
    """Zeitreihe aller beobachteten Preise."""

    __tablename__ = "odds_snapshots"

    id: Mapped[int] = mapped_column(BigIntType, primary_key=True, autoincrement=True)
    selection_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("selections.id", ondelete="CASCADE")
    )
    bookmaker_id: Mapped[int] = mapped_column(Integer, ForeignKey("bookmakers.id"))
    price: Mapped[float] = mapped_column(Float)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    provider: Mapped[str] = mapped_column(String(32))
    suspended: Mapped[bool] = mapped_column(Boolean, default=False)
    liquidity: Mapped[float | None] = mapped_column(Float, nullable=True)

    __table_args__ = (
        Index("ix_odds_snapshots_selection_ts", "selection_id", "ts"),
        Index("ix_odds_snapshots_ts", "ts"),
    )


class OddsChangeRow(Base):
    """Nur echte Preisänderungen - Basis für Bewegungsanalysen."""

    __tablename__ = "odds_changes"

    id: Mapped[int] = mapped_column(BigIntType, primary_key=True, autoincrement=True)
    selection_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("selections.id", ondelete="CASCADE")
    )
    bookmaker_id: Mapped[int] = mapped_column(Integer, ForeignKey("bookmakers.id"))
    old_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    new_price: Mapped[float] = mapped_column(Float)
    delta_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    elapsed_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    __table_args__ = (Index("ix_odds_changes_selection_ts", "selection_id", "ts"),)


class AlertRow(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(BigIntType, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(24), index=True)
    event_id: Mapped[str] = mapped_column(String(64), index=True)
    sport: Mapped[str] = mapped_column(String(16), index=True)
    market_key: Mapped[str] = mapped_column(String(96))
    market_label: Mapped[str] = mapped_column(String(128), default="")
    selection_key: Mapped[str] = mapped_column(String(96))
    selection_label: Mapped[str] = mapped_column(String(128), default="")
    bookmaker: Mapped[str] = mapped_column(String(64), index=True)
    odds: Mapped[float] = mapped_column(Float)
    fair_odds: Mapped[float] = mapped_column(Float)
    value_percent: Mapped[float] = mapped_column(Float)
    deviation_percent: Mapped[float] = mapped_column(Float)
    confidence: Mapped[int] = mapped_column(Integer)
    error_score: Mapped[int] = mapped_column(Integer)
    bookmaker_count: Mapped[int] = mapped_column(Integer)
    provider: Mapped[str] = mapped_column(String(32), default="")
    fingerprint: Mapped[str] = mapped_column(String(32), unique=True)
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    payload: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    telegram_sent: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="new")

    __table_args__ = (Index("ix_alerts_detected_kind", "detected_at", "kind"),)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigIntType, primary_key=True, autoincrement=True)
    telegram_id: Mapped[int] = mapped_column(BigIntType, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    first_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    settings: Mapped[UserSettings | None] = relationship(back_populates="user", lazy="noload")


class UserSettings(Base):
    __tablename__ = "user_settings"

    user_id: Mapped[int] = mapped_column(
        BigIntType, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    min_value_percent: Mapped[float] = mapped_column(Float, default=10.0)
    min_outlier_percent: Mapped[float] = mapped_column(Float, default=15.0)
    min_odds: Mapped[float] = mapped_column(Float, default=1.50)
    max_odds: Mapped[float] = mapped_column(Float, default=51.0)
    min_bookmakers: Mapped[int] = mapped_column(Integer, default=3)
    min_confidence: Mapped[int] = mapped_column(Integer, default=60)
    cooldown_seconds: Mapped[int] = mapped_column(Integer, default=60)
    sports: Mapped[list | None] = mapped_column(JSONType, default=lambda: ["football", "tennis"])
    markets: Mapped[list | None] = mapped_column(JSONType, nullable=True)
    live_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    prematch_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    user: Mapped[User] = relationship(back_populates="settings", lazy="noload")


class ProviderHealthRow(Base):
    __tablename__ = "provider_health"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    provider: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default="disconnected")
    connected_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    messages: Mapped[int] = mapped_column(BigIntType, default=0)
    quotes: Mapped[int] = mapped_column(BigIntType, default=0)
    errors: Mapped[int] = mapped_column(Integer, default=0)
    reconnects: Mapped[int] = mapped_column(Integer, default=0)
    rate_limit_remaining: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    detail: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


__all__ = [
    "AlertRow",
    "Base",
    "Bookmaker",
    "Event",
    "Market",
    "OddsChangeRow",
    "OddsSnapshot",
    "ProviderHealthRow",
    "SelectionRow",
    "User",
    "UserSettings",
]
