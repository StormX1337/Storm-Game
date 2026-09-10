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
from backend.providers.sportsgameodds import SportsGameOddsProvider
from backend.providers.the_odds_api import TheOddsApiProvider

log = get_logger("provider.registry")

#: Statische Beschreibung für README, Dashboard und ``/health/providers``.
PROVIDER_SPECS: dict[str, ProviderSpec] = {
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
    "sportsgameodds": ProviderSpec(
        key="sportsgameodds",
        title="SportsGameOdds",
        kind="rest",
        requires_credentials=True,
        docs_url="https://sportsgameodds.com/docs/",
        notes=(
            "Echte REST-API mit Live-Filter (live=true) und allen Buchmacher-"
            "preisen je Markt in einem Aufruf. Kostenloser Einstiegstarif. "
            "Keine Spielminute, keine Tennis-Punktdetails."
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
    if key == "sportsgameodds":
        return [] if settings.sgo_api_key else ["SGO_API_KEY"]
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


def _make_sportsgameodds(settings: Settings) -> OddsProvider:
    return SportsGameOddsProvider(
        api_key=settings.sgo_api_key,
        base_url=settings.sgo_base_url,
        leagues=settings.sgo_leagues,
        sport_ids=settings.sgo_sport_ids,
        live_only=settings.sgo_live_only,
        poll_interval=settings.sgo_poll_interval,
        max_pages=settings.sgo_max_pages,
        page_limit=settings.sgo_page_limit,
        bookmakers=settings.sgo_bookmakers,
        rate_limit_per_minute=settings.sgo_rate_limit_per_minute,
    )


def _make_sportsgameodds_prematch(settings: Settings) -> OddsProvider:
    """Zweiter Abruf derselben Quelle - nur für Spiele vor dem Anpfiff.

    Warum getrennt und nicht einfach ``live_only=false``: beide Sorten kämen
    dann aus einem Abruf und teilten sich dasselbe Seitenbudget. Prematch-
    Events sind ein Vielfaches der laufenden, sie würden die Live-Spiele
    schlicht verdrängen - der Live-Teil des Dashboards liefe leer, ohne dass
    irgendwo ein Fehler stünde. Zwei Ströme mit eigenem Takt und eigenem
    Budget halten beides am Leben.
    """
    return SportsGameOddsProvider(
        api_key=settings.sgo_api_key,
        base_url=settings.sgo_base_url,
        leagues=settings.sgo_leagues,
        sport_ids=settings.sgo_sport_ids,
        live_only=False,
        exclude_live=True,
        name="sportsgameodds_prematch",
        poll_interval=settings.prematch_poll_interval,
        max_pages=settings.prematch_max_pages,
        page_limit=settings.sgo_page_limit,
        bookmakers=settings.sgo_bookmakers,
        rate_limit_per_minute=settings.sgo_rate_limit_per_minute,
    )


FACTORIES: dict[str, Callable[[Settings], OddsProvider]] = {
    "sportsgameodds": _make_sportsgameodds,
    "the_odds_api": _make_the_odds_api,
    "betfair": _make_betfair,
}


def build_providers(settings: Settings) -> list[OddsProvider]:
    """Konfigurierte Provider instanziieren.

    Fehlt einem Provider ein Zugangsdatum, wird er übersprungen und der Grund
    geloggt - die übrigen laufen weiter. Bleibt keiner übrig, liefert diese
    Funktion eine leere Liste: der Scanner läuft, findet nichts und sagt
    warum. Es gibt bewusst keine Ersatzquelle, die Daten erfinden könnte.
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

    # Prematch hängt an derselben Quelle und denselben Zugangsdaten - es ist
    # ein zweiter Abruf, kein zweiter Anbieter. Darum ein Schalter statt eines
    # weiteren Eintrags in PROVIDERS.
    if settings.prematch_enabled and any(p.name == "sportsgameodds" for p in providers):
        try:
            providers.append(_make_sportsgameodds_prematch(settings))
            log.info(
                "prematch-abruf aktiv",
                takt_s=settings.prematch_poll_interval,
                seiten=settings.prematch_max_pages,
            )
        except Exception as exc:  # noqa: BLE001 - der Live-Abruf muss weiterlaufen
            log.error("prematch-abruf nicht startbar", error=str(exc))
    elif settings.prematch_enabled:
        log.warning(
            "PREMATCH_ENABLED=true, aber sportsgameodds läuft nicht - "
            "ohne diese Quelle gibt es keinen Prematch-Abruf."
        )

    if not providers:
        log.error(
            "KEINE DATENQUELLE STARTBAR - der Scanner läuft, findet aber nichts.",
            angefordert=",".join(requested) or "(nichts konfiguriert)",
            naechster_schritt=(
                "./scripts/setup-provider.sh sportsgameodds --key <KEY> --live --write"
            ),
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
