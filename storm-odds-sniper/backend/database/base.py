"""Datenbankverbindung (async).

Ein Engine-Objekt pro Prozess, Connection-Pool inklusive. Der Scanner schreibt
gebündelt, die API liest - beide teilen sich diese Fabrik, aber niemals eine
Session.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from backend.core.config import Settings, get_settings
from backend.core.logging import get_logger
from backend.database.tables import Base

log = get_logger("database")

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def create_engine(settings: Settings | None = None) -> AsyncEngine:
    settings = settings or get_settings()
    kwargs: dict = {
        "echo": settings.db_echo,
        "pool_pre_ping": True,
        "future": True,
    }
    dsn = settings.sqlalchemy_dsn
    if not dsn.startswith("sqlite"):
        kwargs.update(
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_max_overflow,
            pool_recycle=1800,
        )
    return create_async_engine(dsn, **kwargs)


def get_engine(settings: Settings | None = None) -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_engine(settings)
    return _engine


def get_session_factory(settings: Settings | None = None) -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            bind=get_engine(settings), expire_on_commit=False, autoflush=False
        )
    return _session_factory


@asynccontextmanager
async def session_scope(
    settings: Settings | None = None,
) -> AsyncIterator[AsyncSession]:
    """Transaktionsklammer: commit bei Erfolg, rollback bei Fehler."""
    factory = get_session_factory(settings)
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def create_all(engine: AsyncEngine | None = None) -> None:
    """Schema direkt anlegen.

    Für Tests und den Erststart ohne Alembic. In Produktion läuft
    ``alembic upgrade head`` (siehe ``scripts/entrypoint.sh``).
    """
    engine = engine or get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    log.info("schema angelegt")


async def dispose_engine() -> None:
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None


async def ping(engine: AsyncEngine | None = None) -> bool:
    from sqlalchemy import text

    engine = engine or get_engine()
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception as exc:  # noqa: BLE001 - Healthcheck darf nie werfen
        log.warning("datenbank nicht erreichbar", error=str(exc))
        return False
