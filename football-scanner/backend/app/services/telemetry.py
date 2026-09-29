"""API usage accounting and the system log shown in the admin panel.

Both write through their own short sessions so a failed data sync cannot roll
back the record of the calls it made.
"""

import logging
from datetime import UTC, datetime

from sqlalchemy import select

from app.db import session_factory
from app.models import ApiUsage, SystemLog

log = logging.getLogger(__name__)


def record_usage(provider: str, path: str, ok: bool, remaining: int | None) -> None:
    day = datetime.now(UTC).strftime("%Y-%m-%d")
    endpoint = path.split("?")[0][:128]
    with session_factory()() as db:
        row = db.scalar(
            select(ApiUsage).where(
                ApiUsage.provider == provider, ApiUsage.day == day, ApiUsage.endpoint == endpoint
            )
        )
        if row is None:
            row = ApiUsage(provider=provider, day=day, endpoint=endpoint, calls=0, errors=0)
            db.add(row)
        row.calls += 1
        if not ok:
            row.errors += 1
        if remaining is not None:
            row.remaining = remaining
        db.commit()


def system_log(level: str, source: str, message: str, context: dict | None = None) -> None:
    getattr(log, level.lower(), log.info)("[%s] %s", source, message)
    try:
        with session_factory()() as db:
            db.add(
                SystemLog(
                    level=level.upper(), source=source, message=message[:4000], context=context
                )
            )
            db.commit()
    except Exception as exc:  # the log must never take the caller down
        log.warning("could not persist system log: %s", exc)
