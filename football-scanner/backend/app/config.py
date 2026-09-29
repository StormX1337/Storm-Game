"""Runtime configuration, read once from the environment.

Everything an operator can change at runtime (thresholds, enabled markets,
leagues, API keys) lives in the database and is edited from the admin panel.
What is here is what the process needs before it can reach the database.
"""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="FVS_", extra="ignore")

    env: str = "development"
    database_url: str = "postgresql+psycopg://scanner:scanner@127.0.0.1:5432/scanner"
    redis_url: str = "redis://127.0.0.1:6379/0"

    # Signs nothing on its own: it is the key API keys are encrypted with at
    # rest, so it must be long and must never change once keys are stored.
    secret_key: str = Field(min_length=32)

    session_cookie_name: str = "fvs_session"
    session_ttl_hours: int = 24 * 7
    cookie_secure: bool = True
    # Origins allowed to make state-changing requests. The web app proxies
    # /api to the backend, so in production this is the app's own origin.
    # Comma-separated.
    allowed_origins: str = "http://localhost:3000"

    # Provider keys may also be set from the admin panel; the database value
    # wins when both exist.
    api_football_key: str | None = None
    api_football_base_url: str = "https://v3.football.api-sports.io"
    the_odds_api_key: str | None = None
    the_odds_api_base_url: str = "https://api.the-odds-api.com/v4"
    http_timeout_seconds: float = 20.0

    # The first account registered becomes admin only when this is true, so a
    # fresh install is administrable without a manual database edit.
    first_user_is_admin: bool = True

    @property
    def origins(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
