"""Abhängigkeiten der API-Routen."""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from backend.core.config import Settings, get_settings
from backend.database.repository import Repository
from backend.services.redis_state import RedisState


def get_state(request: Request) -> RedisState:
    state = getattr(request.app.state, "redis", None)
    if state is None:
        raise HTTPException(status_code=503, detail="Redis nicht verfügbar")
    return state


def get_repository(request: Request) -> Repository:
    repo = getattr(request.app.state, "repository", None)
    if repo is None:
        raise HTTPException(status_code=503, detail="Datenbank nicht verfügbar")
    return repo


def get_optional_repository(request: Request) -> Repository | None:
    return getattr(request.app.state, "repository", None)


def app_settings(request: Request) -> Settings:
    """Die Settings *dieser* Anwendung.

    ``get_settings()`` liest die Umgebung und ist prozessweit gecacht - eine
    App mit abweichender Konfiguration käme damit nie zum Zug.
    """
    return getattr(request.app.state, "settings", None) or get_settings()


def settings_dep() -> Settings:
    return get_settings()


StateDep = Depends(get_state)
RepoDep = Depends(get_repository)
OptionalRepoDep = Depends(get_optional_repository)
SettingsDep = Depends(settings_dep)
