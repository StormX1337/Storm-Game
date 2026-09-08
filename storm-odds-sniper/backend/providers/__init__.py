"""Datenquellen-Adapter."""

from backend.providers.base import (
    OddsProvider,
    ProviderAuthError,
    ProviderError,
    ProviderHealth,
    ProviderRateLimited,
    ProviderSpec,
)
from backend.providers.betfair_exchange import BetfairExchangeProvider
from backend.providers.registry import (
    PROVIDER_SPECS,
    build_providers,
    describe_providers,
    missing_credentials,
)
from backend.providers.sportsgameodds import SportsGameOddsProvider
from backend.providers.the_odds_api import TheOddsApiProvider

__all__ = [
    "PROVIDER_SPECS",
    "BetfairExchangeProvider",
    "OddsProvider",
    "ProviderAuthError",
    "ProviderError",
    "ProviderHealth",
    "ProviderRateLimited",
    "ProviderSpec",
    "SportsGameOddsProvider",
    "TheOddsApiProvider",
    "build_providers",
    "describe_providers",
    "missing_credentials",
]
