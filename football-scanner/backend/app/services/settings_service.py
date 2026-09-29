"""Runtime settings stored in the database and edited from the admin panel."""

import copy
from dataclasses import asdict

from sqlalchemy.orm import Session

from app.engine.analysis import EngineSettings
from app.engine.markets import Market
from app.engine.scoring import RankThresholds, Risk
from app.models import AppSetting

DEFAULTS: dict[str, dict] = {
    # Which evaluations become stored signals (and so enter the track record).
    "signal_policy": {
        "min_probability": 0.0,
        "min_value": 2.0,
        "max_risk": "HIGH",
        "min_confidence": 45,
    },
    # Pre-filled scanner filter for users who have not saved their own.
    "scanner_defaults": {
        "min_probability": 0.65,
        "min_value": 8.0,
        "max_risk": "MEDIUM",
        "min_confidence": 70,
    },
    "thresholds": asdict(RankThresholds()),
    "engine": {
        "min_matches": 5,
        "target_matches": 10,
        "min_league_matches": 20,
        "dixon_coles_rho": -0.05,
    },
    "markets": {"enabled": [m.value for m in Market]},
    "odds": {
        "source": "the_odds_api",  # or api_football
        "regions": "eu",
        "fetch_extra_markets": True,
        "movement_alert_pct": 10.0,
        "max_snapshot_age_hours": 6,
    },
    "sync": {
        "days_ahead": 2,
        "history_matches": 15,
        "interval_minutes": {
            "fixtures": 180,
            "league_history": 1440,
            "team_history": 360,
            "injuries": 120,
            "lineups": 10,
            "live": 2,
            "odds": 20,
            "analysis": 20,
            "settlement": 30,
        },
    },
    "bankroll_defaults": {"method": "half_kelly", "cap_percent": 2.0, "percent": 1.0},
}


def get(db: Session, key: str) -> dict:
    default = copy.deepcopy(DEFAULTS.get(key, {}))
    row = db.get(AppSetting, key)
    if row is None or not isinstance(row.value, dict):
        return default
    return _merge(default, row.value)


def put(db: Session, key: str, value: dict, user_id: int | None = None) -> dict:
    if key not in DEFAULTS:
        raise KeyError(key)
    merged = _merge(copy.deepcopy(DEFAULTS[key]), value)
    _check_types(DEFAULTS[key], merged, key)
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=merged, updated_by=user_id))
    else:
        row.value = merged
        row.updated_by = user_id
    db.commit()
    return merged


def _check_types(default: dict, value: dict, path: str) -> None:
    """Reject values whose type differs from the default's, so a bad edit in the
    admin panel is refused instead of breaking the next analysis run."""
    for k, dv in default.items():
        v = value.get(k)
        where = f"{path}.{k}"
        if isinstance(dv, bool):
            ok = isinstance(v, bool)
        elif isinstance(dv, int | float):
            ok = isinstance(v, int | float) and not isinstance(v, bool)
        elif isinstance(dv, str):
            ok = isinstance(v, str)
        elif isinstance(dv, list):
            ok = isinstance(v, list)
        elif isinstance(dv, dict):
            if not isinstance(v, dict):
                raise ValueError(f"{where} must be an object")
            _check_types(dv, v, where)
            continue
        else:
            ok = True
        if not ok:
            raise ValueError(f"{where} must be a {type(dv).__name__}")
    for risk_key in ("max_risk",):
        if risk_key in value:
            try:
                Risk.parse(str(value[risk_key]))
            except KeyError as exc:
                raise ValueError(
                    f"{path}.{risk_key} must be LOW, MEDIUM, HIGH or VERY HIGH"
                ) from exc


def all_settings(db: Session) -> dict[str, dict]:
    return {k: get(db, k) for k in DEFAULTS}


def _merge(base: dict, override: dict) -> dict:
    for k, v in override.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            base[k] = _merge(base[k], v)
        else:
            base[k] = v
    return base


def engine_settings(db: Session) -> EngineSettings:
    eng = get(db, "engine")
    thr = get(db, "thresholds")
    enabled = get(db, "markets").get("enabled") or []
    valid = {m.value for m in Market}
    return EngineSettings(
        min_matches=int(eng["min_matches"]),
        target_matches=int(eng["target_matches"]),
        min_league_matches=int(eng["min_league_matches"]),
        dixon_coles_rho=float(eng["dixon_coles_rho"]),
        enabled_markets={Market(m) for m in enabled if m in valid},
        thresholds=RankThresholds(**{k: thr[k] for k in asdict(RankThresholds()) if k in thr}),
    )
