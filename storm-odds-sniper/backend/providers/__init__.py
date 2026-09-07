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
from backend.providers.mock_provider import MockProvider
from backend.providers.registry import (
    PROVIDER_SPECS,
    build_providers,
    describe_providers,
    missing_credentials,
)
from backend.providers.the_odds_api import TheOddsApiProvider

__all__ = [
    "PROVIDER_SPECS",
    "BetfairExchangeProvider",
    "MockProvider",
    "OddsProvider",
    "ProviderAuthError",
    "ProviderError",
    "ProviderHealth",
    "ProviderRateLimited",
    "ProviderSpec",
    "TheOddsApiProvider",
    "build_providers",
    "describe_providers",
    "missing_credentials",
]
