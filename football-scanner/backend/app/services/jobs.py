"""Background jobs: what each does, how often, and the bookkeeping around it."""

import time
import traceback
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app import cache
from app.db import session_factory, utcnow
from app.models import JobRun
from app.providers import registry
from app.providers.base import ProviderNotConfigured
from app.services import analysis_service, settings_service, settlement, sync
from app.services.telemetry import system_log


def _sync_cfg(db: Session) -> dict:
    return settings_service.get(db, "sync")


def job_fixtures(db: Session) -> str:
    n = sync.sync_fixtures(db, registry.football_provider(db), int(_sync_cfg(db)["days_ahead"]))
    return f"{n} fixtures upserted"


def job_league_history(db: Session) -> str:
    n = sync.sync_league_history(db, registry.football_provider(db))
    return f"{n} league fixtures upserted"


def job_team_history(db: Session) -> str:
    cfg = _sync_cfg(db)
    provider = registry.football_provider(db)
    detailed = sync.sync_team_history(
        db, provider, int(cfg["days_ahead"]), int(cfg["history_matches"])
    )
    h2h = 0
    for fx in sync.upcoming(db, int(cfg["days_ahead"]) * 24):
        for dto in provider.head_to_head(fx.home_team_id, fx.away_team_id, 10):
            sync.upsert_fixture(db, dto)
            h2h += 1
        db.commit()
    return f"{detailed} fixtures detailed, {h2h} head-to-head fixtures"


def job_injuries(db: Session) -> str:
    return f"{sync.sync_injuries(db, registry.football_provider(db))} absences stored"


def job_lineups(db: Session) -> str:
    return f"{sync.sync_lineups_and_live(db, registry.football_provider(db))} fixtures refreshed"


def job_live(db: Session) -> str:
    provider = registry.football_provider(db)
    known = 0
    from app.models import Fixture

    for dto in provider.live_fixtures():
        if db.get(Fixture, dto.id) is not None:
            sync.upsert_fixture(db, dto)
            known += 1
    db.commit()
    return f"{known} live fixtures updated"


def job_odds(db: Session) -> str:
    n = sync.sync_odds(db, registry.odds_provider(db), int(_sync_cfg(db)["days_ahead"]))
    return f"{n} price changes stored"


def job_analysis(db: Session) -> str:
    n = analysis_service.run_analysis(db, int(_sync_cfg(db)["days_ahead"]))
    return f"{n} fixtures analysed"


def job_settlement(db: Session) -> str:
    analysis_service.lock_started(db)
    return f"{settlement.settle(db)} signals settled"


JOBS: dict[str, Callable[[Session], str]] = {
    "fixtures": job_fixtures,
    "league_history": job_league_history,
    "team_history": job_team_history,
    "injuries": job_injuries,
    "lineups": job_lineups,
    "live": job_live,
    "odds": job_odds,
    "analysis": job_analysis,
    "settlement": job_settlement,
}

JOB_DESCRIPTIONS = {
    "fixtures": "Upcoming fixtures for enabled leagues",
    "league_history": "Season results for league baselines",
    "team_history": "Recent matches, statistics and head-to-head for teams playing soon",
    "injuries": "Injuries and suspensions for fixtures in the next 48 hours",
    "lineups": "Line-ups near kick-off, live and final statistics",
    "live": "Live scores and status",
    "odds": "Bookmaker prices",
    "analysis": "Model probabilities, value, confidence and risk",
    "settlement": "Grade finished signals",
}


def run_job(name: str) -> tuple[str, str]:
    fn = JOBS[name]
    if not cache.acquire_lock(f"job:{name}", 3600):
        return "skipped", "already running"
    Session = session_factory()
    try:
        with Session() as db:
            run = db.get(JobRun, name) or JobRun(name=name)
            db.add(run)
            run.last_started_at = utcnow()
            run.requested_at = None
            db.commit()
        started = time.monotonic()
        try:
            with Session() as db:
                message = fn(db)
            status = "ok"
        except ProviderNotConfigured as exc:
            status, message = "skipped", str(exc)
        except Exception as exc:
            status, message = "error", f"{type(exc).__name__}: {exc}"
            system_log("ERROR", f"job:{name}", message, {"trace": traceback.format_exc()[-3000:]})
        took = time.monotonic() - started
        with Session() as db:
            run = db.get(JobRun, name)
            run.last_finished_at = utcnow()
            run.last_status = status
            run.last_message = f"{message} ({took:.1f}s)"
            db.commit()
        if status == "ok":
            system_log("INFO", f"job:{name}", f"{message} ({took:.1f}s)")
        return status, message
    finally:
        cache.release_lock(f"job:{name}")


def due_jobs(db: Session, now: datetime | None = None) -> list[str]:
    now = now or datetime.now(UTC)
    intervals = _sync_cfg(db)["interval_minutes"]
    due = []
    for name in JOBS:
        run = db.get(JobRun, name)
        if run is not None and run.requested_at is not None:
            due.append(name)
            continue
        minutes = float(intervals.get(name, 60))
        last = run.last_started_at if run is not None else None
        if last is None or now - last >= timedelta(minutes=minutes):
            due.append(name)
    # Data before analysis before settlement.
    order = list(JOBS)
    return sorted(due, key=order.index)
