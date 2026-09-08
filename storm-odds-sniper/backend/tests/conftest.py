"""Gemeinsame Test-Fixtures.

Die Tests laufen ohne echte Infrastruktur:

* Redis -> ``fakeredis`` (inkl. Pipelines und Pub/Sub)
* PostgreSQL -> SQLite via ``aiosqlite`` (Schema aus den ORM-Modellen)
* Provider -> handgebaute Nachrichten
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.core.config import Settings
from backend.database.repository import Repository
from backend.database.tables import Base
from backend.models.domain import (
    EventSnapshot,
    FootballState,
    MarketKey,
    OddsQuote,
    Score,
    Selection,
    TennisState,
    now_ts,
)
from backend.models.enums import EventStatus, MarketType, Period, SelectionCode, Sport
from backend.services.redis_state import RedisState


@pytest.fixture(scope="session")
def event_loop_policy():
    return asyncio.get_event_loop_policy()


@pytest.fixture
def settings() -> Settings:
    """Testkonfiguration - bewusst ohne .env-Datei."""
    return Settings(
        _env_file=None,
        providers="sportsgameodds",
        redis_url="redis://localhost:6379/15",
        min_value_percent=10.0,
        min_outlier_percent=15.0,
        min_bookmakers=3,
        min_odds=1.5,
        max_odds_age_seconds=10.0,
        alert_cooldown_seconds=60,
        min_confidence=50,
        min_error_score=50,
        db_writer_interval=0.05,
        provider_health_interval=0.05,
    )


@pytest_asyncio.fixture
async def redis_state() -> AsyncIterator[RedisState]:
    from fakeredis import aioredis

    client = aioredis.FakeRedis(decode_responses=False)
    state = RedisState("redis://fake", ttl=300, client=client)
    yield state
    await client.flushall()
    await client.aclose()


@pytest_asyncio.fixture
async def repository(tmp_path) -> AsyncIterator[Repository]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    yield Repository(factory)
    await engine.dispose()


# --------------------------------------------------------------- Baukästen


def make_event(
    *,
    event_id: str = "foo_test",
    sport: Sport = Sport.FOOTBALL,
    status: EventStatus = EventStatus.LIVE,
    home: str = "Bayern München",
    away: str = "Borussia Dortmund",
    minute: int | None = 67,
    score: tuple[int, int] | None = (1, 1),
    provider: str = "sportsgameodds",
    provider_event_id: str = "p-1",
    start_time: datetime | None = None,
) -> EventSnapshot:
    return EventSnapshot(
        event_id=event_id,
        sport=sport,
        home=home,
        away=away,
        provider=provider,
        provider_event_id=provider_event_id,
        league="Bundesliga",
        start_time=start_time or datetime.now(UTC) - timedelta(minutes=67),
        status=status,
        score=Score(*score) if score else None,
        football=FootballState(minute=minute, period="2H") if sport is Sport.FOOTBALL else None,
        tennis=None,
    )


def make_tennis_event(
    *, event_id: str = "ten_test", status: EventStatus = EventStatus.LIVE
) -> EventSnapshot:
    return EventSnapshot(
        event_id=event_id,
        sport=Sport.TENNIS,
        home="Jannik Sinner",
        away="Carlos Alcaraz",
        provider="sportsgameodds",
        provider_event_id="p-t1",
        league="ATP Masters",
        start_time=datetime.now(UTC) - timedelta(minutes=90),
        status=status,
        score=Score(1, 1),
        tennis=TennisState(
            set_number=2,
            sets_home=1,
            sets_away=1,
            games_home=4,
            games_away=3,
            points_home="30",
            points_away="15",
            server="home",
        ),
    )


OVER_UNDER_25 = MarketKey(type=MarketType.OVER_UNDER, line=2.5, period=Period.FULL_TIME)
MATCH_ODDS = MarketKey(type=MarketType.MATCH_ODDS, line=None, period=Period.FULL_TIME)
OVER = Selection(code=SelectionCode.OVER, label="Over")
UNDER = Selection(code=SelectionCode.UNDER, label="Under")


def make_quote(
    *,
    bookmaker: str,
    price: float,
    event_id: str = "foo_test",
    market: MarketKey = OVER_UNDER_25,
    selection: Selection = OVER,
    ts: float | None = None,
    confirmed_at: float | None = None,
    suspended: bool = False,
    liquidity: float | None = None,
    is_exchange: bool = False,
    provider: str = "sportsgameodds",
) -> OddsQuote:
    stamp = now_ts() if ts is None else ts
    # Standardfall: der Preis wurde zuletzt gesehen, als er gesetzt wurde.
    # Für "vergessene" Quoten lässt sich confirmed_at getrennt setzen.
    seen = stamp if confirmed_at is None else confirmed_at
    return OddsQuote(
        event_id=event_id,
        market=market,
        selection=selection,
        bookmaker=bookmaker,
        price=price,
        provider=provider,
        ts=stamp,
        received_at=seen,
        confirmed_at=seen,
        suspended=suspended,
        liquidity=liquidity,
        is_exchange=is_exchange,
    )


def make_book(prices: dict[str, float], counter_prices: dict[str, float] | None = None):
    """Zweiseitiges Over/Under-Buch bauen.

    ``counter_prices`` fehlt -> Gegenseite wird so gewählt, dass jeder
    Buchmacher einen Overround von ca. 5 % hat.
    """
    from backend.core.value_engine import MarketBook

    book = MarketBook(event_id="foo_test", market=OVER_UNDER_25)
    for bookmaker, price in prices.items():
        book.add(make_quote(bookmaker=bookmaker, price=price, selection=OVER))
        if counter_prices and bookmaker in counter_prices:
            counter = counter_prices[bookmaker]
        else:
            counter = 1.0 / max(0.01, (1.05 - 1.0 / price))
        book.add(make_quote(bookmaker=bookmaker, price=counter, selection=UNDER))
    return book
