from dataclasses import asdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import require_admin
from app.config import get_settings
from app.db import get_db, utcnow
from app.engine.performance import SettledBet, calibration, summarize
from app.models import (
    ApiCredential,
    ApiUsage,
    Fixture,
    FixtureAnalysis,
    JobRun,
    League,
    OddsSnapshot,
    Signal,
    SystemLog,
    User,
    UserSession,
)
from app.providers import registry
from app.providers.base import ProviderError, ProviderNotConfigured
from app.providers.the_odds_api import TheOddsApi
from app.security import encrypt_secret, mask_secret
from app.services import settings_service, sync
from app.services.jobs import JOB_DESCRIPTIONS, JOBS
from app.services.telemetry import system_log

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ------------------------------------------------------------------ overview


@router.get("/overview")
def overview(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    count = lambda model: db.scalar(select(func.count()).select_from(model))  # noqa: E731
    return {
        "users": count(User),
        "leagues_enabled": db.scalar(select(func.count(League.id)).where(League.enabled.is_(True))),
        "leagues_total": count(League),
        "fixtures": count(Fixture),
        "analysed_fixtures": count(FixtureAnalysis),
        "odds_snapshots": count(OddsSnapshot),
        "signals": count(Signal),
        "jobs": jobs(admin, db),
    }


# ------------------------------------------------------------------ API keys


class KeyUpdate(BaseModel):
    provider: str
    key: str | None = Field(None, max_length=256)


@router.get("/api-keys")
def list_keys(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    out = []
    env = get_settings()
    env_keys = {"api_football": env.api_football_key, "the_odds_api": env.the_odds_api_key}
    for provider, desc in registry.PROVIDERS.items():
        row = db.get(ApiCredential, provider)
        key = registry.api_key(db, provider)
        out.append(
            {
                "provider": provider,
                "description": desc,
                "configured": bool(key),
                "source": "admin" if row else ("environment" if env_keys.get(provider) else None),
                "masked": mask_secret(key),
                "updated_at": row.updated_at if row else None,
            }
        )
    return out


@router.put("/api-keys")
def set_key(body: KeyUpdate, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if body.provider not in registry.PROVIDERS:
        raise HTTPException(404, "Unknown provider")
    row = db.get(ApiCredential, body.provider)
    if not body.key:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(
            ApiCredential(
                provider=body.provider,
                encrypted_key=encrypt_secret(body.key.strip()),
                updated_by=admin.id,
            )
        )
    else:
        row.encrypted_key = encrypt_secret(body.key.strip())
        row.updated_by = admin.id
    db.commit()
    system_log(
        "INFO",
        "admin",
        f"API key for {body.provider} {'removed' if not body.key else 'updated'} by {admin.email}",
    )
    return list_keys(admin, db)


# ------------------------------------------------------------------ leagues


class LeagueUpdate(BaseModel):
    enabled: bool | None = None
    odds_key: str | None = Field(None, max_length=64)


@router.get("/leagues")
def leagues(
    q: str | None = Query(None, max_length=64),
    enabled: bool | None = None,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    query = select(League)
    if q:
        like = f"%{q}%"
        query = query.where(or_(League.name.ilike(like), League.country.ilike(like)))
    if enabled is not None:
        query = query.where(League.enabled.is_(enabled))
    rows = db.scalars(query.order_by(League.enabled.desc(), League.country, League.name).limit(500))
    return [
        {
            "id": lg.id,
            "name": lg.name,
            "country": lg.country,
            "logo": lg.logo,
            "type": lg.type,
            "season": lg.season,
            "enabled": lg.enabled,
            "odds_key": lg.odds_key,
        }
        for lg in rows
    ]


@router.post("/leagues/sync")
def sync_leagues(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    try:
        n = sync.upsert_leagues(db, registry.football_provider(db).leagues())
    except ProviderError as exc:
        raise HTTPException(502, str(exc)) from exc
    system_log("INFO", "admin", f"League catalogue refreshed: {n} leagues")
    return {"leagues": n}


@router.patch("/leagues/{league_id}")
def update_league(
    league_id: int,
    body: LeagueUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    lg = db.get(League, league_id)
    if lg is None:
        raise HTTPException(404, "League not found")
    if body.enabled is not None:
        lg.enabled = body.enabled
    if "odds_key" in body.model_fields_set:
        lg.odds_key = body.odds_key or None
    db.commit()
    return {"id": lg.id, "enabled": lg.enabled, "odds_key": lg.odds_key}


@router.get("/odds-sports")
def odds_sports(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Competition keys from The Odds API, for mapping leagues to odds.

    Empty when no key is configured: the page then offers a free-text field.
    """
    try:
        provider = registry.odds_provider(db)
    except ProviderNotConfigured:
        return []
    if not isinstance(provider, TheOddsApi):
        return []
    try:
        return [s for s in provider.sports() if str(s.get("key", "")).startswith("soccer")]
    except ProviderError as exc:
        raise HTTPException(502, str(exc)) from exc


# ------------------------------------------------------------------ settings


@router.get("/settings")
def get_all_settings(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return settings_service.all_settings(db)


@router.put("/settings/{key}")
def put_setting(
    key: str, value: dict, admin: User = Depends(require_admin), db: Session = Depends(get_db)
):
    try:
        saved = settings_service.put(db, key, value, admin.id)
    except KeyError as exc:
        raise HTTPException(404, "Unknown setting") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    system_log("INFO", "admin", f"Setting '{key}' changed by {admin.email}", {"value": saved})
    return saved


# ------------------------------------------------------------------ users


class UserUpdate(BaseModel):
    role: str | None = Field(None, pattern="^(user|admin)$")
    is_active: bool | None = None


@router.get("/users")
def users(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return [
        {
            "id": u.id,
            "email": u.email,
            "role": u.role,
            "is_active": u.is_active,
            "created_at": u.created_at,
            "last_login_at": u.last_login_at,
        }
        for u in db.scalars(select(User).order_by(User.id))
    ]


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    body: UserUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(404, "User not found")
    demoting = (body.role == "user" and u.role == "admin") or (
        body.is_active is False and u.role == "admin"
    )
    if demoting:
        admins = db.scalar(
            select(func.count(User.id)).where(User.role == "admin", User.is_active.is_(True))
        )
        if admins <= 1:
            raise HTTPException(409, "At least one active admin must remain")
    if body.role is not None:
        u.role = body.role
    if body.is_active is not None:
        u.is_active = body.is_active
        if not body.is_active:
            for s in db.scalars(select(UserSession).where(UserSession.user_id == u.id)):
                db.delete(s)
    db.commit()
    system_log(
        "INFO",
        "admin",
        f"User {u.email} updated by {admin.email}",
        body.model_dump(exclude_none=True),
    )
    return {"id": u.id, "role": u.role, "is_active": u.is_active}


# ------------------------------------------------------------------ usage, logs, jobs


@router.get("/usage")
def usage(
    days: int = Query(7, ge=1, le=90),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    since = (datetime.now(UTC) - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    rows = db.scalars(
        select(ApiUsage)
        .where(ApiUsage.day >= since)
        .order_by(ApiUsage.day.desc(), ApiUsage.provider)
    )
    return [
        {
            "provider": r.provider,
            "day": r.day,
            "endpoint": r.endpoint,
            "calls": r.calls,
            "errors": r.errors,
            "remaining": r.remaining,
        }
        for r in rows
    ]


@router.get("/logs")
def logs(
    level: str | None = Query(None, max_length=10),
    source: str | None = Query(None, max_length=64),
    limit: int = Query(200, ge=1, le=1000),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    q = select(SystemLog).order_by(SystemLog.created_at.desc()).limit(limit)
    if level:
        q = q.where(SystemLog.level == level.upper())
    if source:
        q = q.where(SystemLog.source.like(f"{source}%"))
    return [
        {
            "id": r.id,
            "time": r.created_at,
            "level": r.level,
            "source": r.source,
            "message": r.message,
            "context": r.context,
        }
        for r in db.scalars(q)
    ]


@router.get("/jobs")
def jobs(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    runs = {r.name: r for r in db.scalars(select(JobRun))}
    intervals = settings_service.get(db, "sync")["interval_minutes"]
    return [
        {
            "name": name,
            "description": JOB_DESCRIPTIONS[name],
            "interval_minutes": intervals.get(name),
            "last_started_at": runs[name].last_started_at if name in runs else None,
            "last_finished_at": runs[name].last_finished_at if name in runs else None,
            "last_status": runs[name].last_status if name in runs else None,
            "last_message": runs[name].last_message if name in runs else None,
            "requested": bool(runs[name].requested_at) if name in runs else False,
        }
        for name in JOBS
    ]


@router.post("/jobs/{name}/run", status_code=202)
def request_job(name: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if name not in JOBS:
        raise HTTPException(404, "Unknown job")
    run = db.get(JobRun, name)
    if run is None:
        run = JobRun(name=name)
        db.add(run)
    run.requested_at = utcnow()
    db.commit()
    return {"queued": name, "note": "The worker picks this up on its next tick."}


# ------------------------------------------------------------------ model performance


@router.get("/performance")
def performance(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    graded = ("won", "half_won", "push", "half_lost", "lost", "void")
    rows = list(
        db.scalars(
            select(Signal).where(Signal.status.in_(graded)).order_by(Signal.settled_at, Signal.id)
        )
    )
    bets = [
        SettledBet(s.odds, s.probability, s.status, s.profit_units or 0.0, s.category) for s in rows
    ]
    by_market: dict[str, list[SettledBet]] = {}
    for s, b in zip(rows, bets, strict=True):
        by_market.setdefault(s.market, []).append(b)
    return {
        "overall": asdict(summarize(bets)),
        "calibration": calibration(bets),
        "by_market": {m: asdict(summarize(v)) for m, v in by_market.items()},
        "note": "Brier score and log loss use won/lost signals only; lower is better.",
    }
