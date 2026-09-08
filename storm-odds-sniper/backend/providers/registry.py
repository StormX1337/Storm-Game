"""Provider-Registry.

Legt fest, welche Adapter es gibt, welche Zugangsdaten sie brauchen und welche
davon mit der aktuellen Konfiguration tatsächlich startbar sind.
"""

from __future__ import annotations

from collections.abc import Callable

from backend.core.config import Settings
from backend.core.logging import get_logger
from backend.providers.base import OddsProvider, ProviderAuthError, ProviderSpec
from backend.providers.betfair_exchange import BetfairExchangeProvider
from backend.providers.mock_provider import MockProvider
from backend.providers.the_odds_api import TheOddsApiProvider

log = get_logger("provider.registry")

#: Statische Beschreibung für README, Dashboard und ``/health/providers``.
PROVIDER_SPECS: dict[str, ProviderSpec] = {
    "mock": ProviderSpec(
        key="mock",
        title="MockProvider (Simulation)",
        kind="mock",
        requires_credentials=False,
        notes=(
            "Vollständige Simulation mit Push-Stream, Live-Verlauf und "
            "künstlichen Fehlpreisen. Keine echten Quoten."
        ),
    ),
    "the_odds_api": ProviderSpec(
        key="the_odds_api",
        title="The Odds API",
        kind="rest",
        requires_credentials=True,
        docs_url="https://the-odds-api.com/liveapi/guides/v4/",
        notes=(
            "Echte REST-API mit kostenlosem Einstiegskontingent. Kein Streaming, "
            "keine Spielminute/Karten. Kontingent wird pro Abfrage verbraucht."
        ),
    ),
    "betfair": ProviderSpec(
        key="betfair",
        title="Betfair Exchange (JSON-RPC)",
        kind="rest",
        requires_credentials=True,
        docs_url="https://developer.betfair.com/en/get-started/",
        notes=(
            "Börsenpreise mit echter Liquidität. Benötigt Konto, App-Key und "
            "Login. Keine Spielminute über die Betting-API."
        ),
    ),
}


def missing_credentials(key: str, settings: Settings) -> list[str]:
    """Welche Umgebungsvariablen fehlen, damit dieser Provider starten kann?"""
    if key == "the_odds_api":
        return [] if settings.odds_api_key else ["ODDS_API_KEY"]
    if key == "betfair":
        missing = []
        if not settings.betfair_app_key:
            missing.append("BETFAIR_APP_KEY")
        if not settings.betfair_username:
            missing.append("BETFAIR_USERNAME")
        if not settings.betfair_password:
            missing.append("BETFAIR_PASSWORD")
        return missing
    return []


def _make_mock(settings: Settings) -> OddsProvider:
    return MockProvider(
        tick_interval=settings.mock_tick_interval,
        events=settings.mock_events,
        bookmakers=settings.mock_bookmakers,
        error_probability=settings.mock_error_probability,
        seed=settings.mock_seed,
    )


def _make_the_odds_api(settings: Settings) -> OddsProvider:
    return TheOddsApiProvider(
        api_key=settings.odds_api_key,
        base_url=settings.odds_api_base_url,
        sport_keys=settings.odds_api_sport_keys,
        regions=settings.odds_api_regions,
        markets=settings.odds_api_market_keys,
        odds_format=settings.odds_api_odds_format,
        poll_interval=settings.odds_api_poll_interval,
        use_scores=settings.odds_api_use_scores,
        scores_interval=settings.odds_api_scores_interval,
        min_remaining=settings.odds_api_min_remaining,
        pace_to_quota=settings.odds_api_pace_to_quota,
        quota_reserve=settings.odds_api_quota_reserve,
        max_discovered_sports=settings.odds_api_max_discovered_sports,
    )


def _make_betfair(settings: Settings) -> OddsProvider:
    return BetfairExchangeProvider(
        app_key=settings.betfair_app_key,
        username=settings.betfair_username,
        password=settings.betfair_password,
        cert_file=settings.betfair_cert_file,
        key_file=settings.betfair_key_file,
        identity_url=settings.betfair_identity_url,
        keepalive_url=settings.betfair_keepalive_url,
        api_url=settings.betfair_api_url,
        event_type_ids=settings.betfair_event_types,
        market_types=settings.betfair_market_type_codes,
        poll_interval=settings.betfair_poll_interval,
        catalogue_interval=settings.betfair_catalogue_interval,
        keepalive_interval=settings.betfair_keepalive_interval,
        max_markets_per_request=settings.betfair_max_markets_per_request,
        max_catalogue_results=settings.betfair_max_catalogue_results,
        inplay_only=settings.betfair_inplay_only,
    )


FACTORIES: dict[str, Callable[[Settings], OddsProvider]] = {
    "mock": _make_mock,
    "the_odds_api": _make_the_odds_api,
    "betfair": _make_betfair,
}


def build_providers(settings: Settings) -> list[OddsProvider]:
    """Konfigurierte Provider instanziieren.

    Fehlen Zugangsdaten, wird der Provider übersprungen und der Grund geloggt -
    der Scanner startet trotzdem.

    Die Simulation springt **nur** ein, wenn gar keine Quelle verlangt wurde.
    Wer ``PROVIDERS=the_odds_api`` schreibt und dessen Schlüssel vergisst,
    bekommt keine erfundenen Quoten untergeschoben, sondern ein stummes System
    mit klarer Begründung. Erfundene Daten in einem Werkzeug, das echte
    Fehlpreise finden soll, sind schlimmer als gar keine.
    """
    requested = settings.provider_names
    providers: list[OddsProvider] = []
    for key in requested:
        factory = FACTORIES.get(key)
        if factory is None:
            log.warning("unbekannter provider in PROVIDERS", provider=key)
            continue
        missing = missing_credentials(key, settings)
        if missing:
            log.warning(
                "provider übersprungen - Zugangsdaten fehlen",
                provider=key,
                missing=",".join(missing),
            )
            continue
        try:
            providers.append(factory(settings))
        except ProviderAuthError as exc:
            log.warning("provider nicht startbar", provider=key, error=str(exc))
        except Exception as exc:  # noqa: BLE001 - ein defekter Adapter darf nicht alles stoppen
            log.error("provider-initialisierung fehlgeschlagen", provider=key, error=str(exc))

    real = [p for p in providers if p.name != "mock"]
    if real and len(real) != len(providers):
        # Der Fall aus der Praxis: die Simulation erzeugt am laufenden Band
        # künstliche Fehlpreise, die echte Quelle alle paar Minuten einen
        # echten Preis. In der Alarmliste steht dann fast nur Erfundenes.
        log.warning(
            "SIMULATION LÄUFT NEBEN ECHTEN DATEN - die Alarmliste wird von "
            "erfundenen Fehlpreisen dominiert",
            echt=[p.name for p in real],
            empfehlung="'mock' aus PROVIDERS entfernen: "
            f"PROVIDERS={','.join(p.name for p in real)}",
        )

    if not providers and not requested:
        log.warning("kein Provider konfiguriert - starte die Simulation")
        providers.append(_make_mock(settings))
    elif not providers:
        log.error(
            "KEINE DATENQUELLE STARTBAR - der Scanner läuft, findet aber nichts. "
            "Es wird bewusst NICHT auf die Simulation ausgewichen: angefordert "
            "waren echte Daten.",
            angefordert=",".join(requested),
            naechster_schritt="./scripts/setup-provider.sh the_odds_api --key <KEY> --write",
        )
    return providers


def describe_providers(settings: Settings) -> list[ProviderSpec]:
    """Beschreibung aller Provider inkl. fehlender Zugangsdaten."""
    out: list[ProviderSpec] = []
    for key, spec in PROVIDER_SPECS.items():
        out.append(
            ProviderSpec(
                key=spec.key,
                title=spec.title,
                kind=spec.kind,
                requires_credentials=spec.requires_credentials,
                docs_url=spec.docs_url,
                notes=spec.notes,
                missing=missing_credentials(key, settings),
            )
        )
    return out
