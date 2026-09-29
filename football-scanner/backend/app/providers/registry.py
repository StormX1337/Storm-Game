"""Builds provider adapters from the configured keys (admin panel first, env second)."""

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import ApiCredential
from app.providers.api_football import ApiFootball
from app.providers.base import FootballDataProvider, OddsProvider, ProviderNotConfigured
from app.providers.http import ApiClient
from app.providers.the_odds_api import TheOddsApi
from app.security import decrypt_secret
from app.services import settings_service
from app.services.telemetry import record_usage

PROVIDERS = {
    "api_football": "API-Football (fixtures, statistics, line-ups, injuries, odds)",
    "the_odds_api": "The Odds API (bookmaker odds)",
}


def api_key(db: Session, provider: str) -> str | None:
    row = db.get(ApiCredential, provider)
    if row is not None:
        key = decrypt_secret(row.encrypted_key)
        if key:
            return key
    s = get_settings()
    return {"api_football": s.api_football_key, "the_odds_api": s.the_odds_api_key}.get(provider)


def football_provider(db: Session) -> FootballDataProvider:
    key = api_key(db, "api_football")
    if not key:
        raise ProviderNotConfigured("API-Football key is not configured")
    s = get_settings()
    client = ApiClient(
        "api_football",
        s.api_football_base_url,
        headers={"x-apisports-key": key},
        timeout=s.http_timeout_seconds,
        usage_hook=record_usage,
        remaining_header="x-ratelimit-requests-remaining",
    )
    return ApiFootball(client)


def odds_provider(db: Session) -> OddsProvider:
    cfg = settings_service.get(db, "odds")
    s = get_settings()
    if cfg.get("source") == "api_football":
        return football_provider(db)  # type: ignore[return-value]
    key = api_key(db, "the_odds_api")
    if not key:
        raise ProviderNotConfigured("The Odds API key is not configured")
    client = ApiClient(
        "the_odds_api",
        s.the_odds_api_base_url,
        params={"apiKey": key},
        timeout=s.http_timeout_seconds,
        usage_hook=record_usage,
        remaining_header="x-requests-remaining",
    )
    return TheOddsApi(
        client,
        regions=cfg.get("regions", "eu"),
        fetch_extra_markets=bool(cfg.get("fetch_extra_markets")),
    )
