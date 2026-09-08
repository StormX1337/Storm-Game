#!/usr/bin/env python
"""Echte Datenquelle einrichten und sofort prüfen.

Der Umstieg von der Simulation auf echte Quoten scheitert meist an zwei
Dingen: der Key ist falsch, oder das Kontingent ist nach ein paar Stunden
aufgebraucht. Dieses Skript prüft beides, bevor der Scanner startet.

    python scripts/setup_provider.py the_odds_api --key DEIN_KEY
    python scripts/setup_provider.py the_odds_api --key DEIN_KEY --write

    python scripts/setup_provider.py sportsgameodds --key DEIN_KEY --live
    python scripts/setup_provider.py sportsgameodds --key DEIN_KEY --write

Ohne ``--write`` wird nichts verändert; das Skript zeigt nur, was es findet,
und gibt den passenden ``.env``-Block aus.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.providers.base import ProviderAuthError, ProviderError  # noqa: E402
from backend.providers.sportsgameodds import (  # noqa: E402
    SportsGameOddsProvider,
    american_to_decimal,
)
from backend.providers.the_odds_api import TheOddsApiProvider, sport_from_key  # noqa: E402

OK, FAIL, INFO = "[ OK ]", "[FEHL]", "[    ]"


def explain_network_error(message: str) -> str:
    """Netzwerkprobleme in eine Handlungsanweisung übersetzen."""
    lowered = message.lower()
    if "proxy" in lowered or "403" in lowered:
        return (
            "       Der Zugriff wird von einem Proxy oder einer Firewall blockiert.\n"
            "       api.the-odds-api.com muss ausgehend erreichbar sein. Test:\n"
            "         curl -sS 'https://api.the-odds-api.com/v4/sports?apiKey=DEIN_KEY'"
        )
    if "timed out" in lowered or "timeout" in lowered:
        return "       Zeitüberschreitung - Netzwerkverbindung oder DNS prüfen."
    if "name or service not known" in lowered or "getaddrinfo" in lowered:
        return "       DNS-Auflösung fehlgeschlagen - Namensauflösung im Container prüfen."
    return (
        "       Erreichbarkeit prüfen:\n"
        "         curl -sS 'https://api.the-odds-api.com/v4/sports?apiKey=DEIN_KEY'"
    )


def human_interval(seconds: float) -> str:
    if seconds < 90:
        return f"{seconds:.0f} Sekunden"
    if seconds < 5400:
        return f"{seconds / 60:.0f} Minuten"
    if seconds < 172800:
        return f"{seconds / 3600:.1f} Stunden"
    return f"{seconds / 86400:.1f} Tage"


async def check_the_odds_api(args: argparse.Namespace) -> int:
    markets = [m.strip() for m in args.markets.split(",") if m.strip()]
    provider = TheOddsApiProvider(
        api_key=args.key,
        regions=args.regions,
        markets=markets,
        max_discovered_sports=args.max_sports,
        use_scores=False,
    )

    print("Prüfe The Odds API …\n")
    try:
        await provider.connect()
    except ProviderAuthError as exc:
        print(f"{FAIL} {exc}")
        print("       Key prüfen unter https://the-odds-api.com/account/")
        await provider.disconnect()
        return 1
    except ProviderError as exc:
        print(f"{FAIL} Verbindung fehlgeschlagen: {exc}")
        print(explain_network_error(str(exc)))
        await provider.disconnect()
        return 1
    except Exception as exc:  # noqa: BLE001 - der Anwender braucht keinen Stacktrace
        print(f"{FAIL} Unerwarteter Fehler: {type(exc).__name__}: {exc}")
        print(explain_network_error(str(exc)))
        await provider.disconnect()
        return 1

    remaining = provider.health.rate_limit_remaining
    print(f"{OK} Key gültig")
    print(f"{INFO} Restkontingent: {remaining if remaining is not None else 'unbekannt'}")

    if not provider.sport_keys:
        print(f"{FAIL} Keine laufenden Fußball-/Tennis-Wettbewerbe gefunden.")
        print("       Das kommt in Spielpausen vor - später erneut versuchen.")
        await provider.disconnect()
        return 1

    print(f"{OK} Laufende Wettbewerbe ({len(provider.sport_keys)}):")
    for key in provider.sport_keys:
        sport = sport_from_key(key)
        print(f"       - {key}  ({sport.value if sport else '?'})")

    # Ein echter Abruf: was kommt tatsächlich zurück?
    print(f"\n{INFO} Hole einmalig echte Quoten …")
    try:
        events = await provider.get_events()
        quotes = await provider.get_odds()
    except ProviderError as exc:
        print(f"{FAIL} Abruf fehlgeschlagen: {exc}")
        print(explain_network_error(str(exc)))
        await provider.disconnect()
        return 1

    if not events:
        print(f"{FAIL} Keine Events geliefert - eventuell gerade keine Spiele angesetzt.")
    else:
        books = {q.bookmaker for q in quotes}
        market_types = {q.market.type.value for q in quotes}
        print(f"{OK} {len(events)} Events, {len(quotes)} Quoten, {len(books)} Buchmacher")
        print(f"{INFO} Märkte: {', '.join(sorted(market_types)) or 'keine'}")

        by_event: dict[str, int] = {}
        for quote in quotes:
            by_event[quote.event_id] = by_event.get(quote.event_id, 0) + 1
        print("\n       Beispiele:")
        for event in events[:3]:
            print(
                f"       - {event.home} vs {event.away}"
                f"  [{event.status.value}, {by_event.get(event.provider_event_id, 0)} Quoten]"
            )

        deepest = max(by_event.values(), default=0)
        per_selection = deepest / max(1, len(market_types) * 2)
        if per_selection < 3:
            print(
                f"\n{INFO} Hinweis: nur ~{per_selection:.0f} Buchmacher je Selektion. "
                "Die Engine braucht mindestens MIN_BOOKMAKERS (Standard 3),"
                "\n       sonst entstehen keine Alarme. Mehr Regionen helfen: "
                "ODDS_API_REGIONS=eu,uk,us,au"
            )

    # Kontingentrechnung
    cost = provider.credits_per_cycle()
    safe = provider.next_poll_delay()
    print("\n--- Kontingent ---")
    print(
        f"{INFO} Kosten je Durchlauf: {cost} Credits "
        f"({len(provider.sport_keys)} Wettbewerbe x {len(markets)} Märkte "
        f"x {len(provider.regions.split(','))} Regionen)"
    )
    print(f"{INFO} Damit reicht das Restkontingent für einen Abruf alle {human_interval(safe)}.")
    print(f"{INFO} Der Scanner drosselt sich automatisch darauf (ODDS_API_PACE_TO_QUOTA).")

    if safe > 3600:
        print(
            f"\n{INFO} Das ist zu selten für sinnvolle Live-Erkennung. Ein Kontingent"
            "\n       dieser Größe reicht zum Ausprobieren, nicht für den Dauerbetrieb."
            "\n       Stellschrauben, jede senkt die Kosten direkt:"
            "\n         - weniger Regionen:     ODDS_API_REGIONS=eu"
            "\n         - weniger Märkte:       ODDS_API_MARKETS=h2h"
            "\n         - weniger Wettbewerbe:  ODDS_API_MAX_DISCOVERED_SPORTS=1"
            f"\n       Mit je einem davon kostet ein Durchlauf 1 Credit statt {cost}."
            "\n       Für echtes Live-Scanning: bezahlter Tarif oder Betfair-Konto."
        )

    env_block = "\n".join(
        [
            "PROVIDERS=the_odds_api",
            f"ODDS_API_KEY={args.key}",
            f"ODDS_API_REGIONS={args.regions}",
            f"ODDS_API_MARKETS={args.markets}",
            f"ODDS_API_MAX_DISCOVERED_SPORTS={args.max_sports}",
            "ODDS_API_POLL_INTERVAL=60",  # Untergrenze; die Drosselung rechnet live
            "ODDS_API_PACE_TO_QUOTA=true",
            "# Echte Quellen liefern weniger Buchmacher je Markt als die Simulation.",
            "MIN_BOOKMAKERS=3",
            "MAX_ODDS_AGE_SECONDS=600",
        ]
    )
    print("\n--- Für deine .env ---")
    print(env_block)

    if args.write:
        written = apply_to_env(Path(args.env), env_block)
        print(f"\n{OK} {written} Zeilen in {args.env} gesetzt.")
        print("       Jetzt: docker compose up -d --build")
    else:
        print("\n       Mit --write trägt das Skript das direkt in die .env ein.")

    await provider.disconnect()
    return 0


#: Voreinstellungen je Tarif. Die Zahlen stammen aus der Preisseite des
#: Anbieters; der Poll-Takt ist so gewählt, dass das Anfragelimit klar
#: eingehalten wird - der Adapter drosselt zusätzlich selbst.
PLANS: dict[str, dict[str, int | float]] = {
    # 10 Anfragen/min: ein Durchlauf alle 30 s, eine Seite.
    "free": {"rpm": 10, "poll": 30, "pages": 1, "page_limit": 50, "max_age": 300},
    # 60 Anfragen/min: alle 10 s zwei Seiten = 12/min.
    "allstar": {"rpm": 60, "poll": 10, "pages": 2, "page_limit": 100, "max_age": 180},
    # 300 Anfragen/min: alle 5 s drei Seiten = 36/min - viel Luft nach oben.
    "pro": {"rpm": 300, "poll": 5, "pages": 3, "page_limit": 100, "max_age": 60},
}


def _raw_pairs(provider: SportsGameOddsProvider) -> list[tuple[str, str, str, float | None]]:
    """Rohwerte der letzten Antwort neben ihrer Umrechnung.

    Ohne den Rohwert daneben ist die Anzeige wertlos: eine falsch verstandene
    Umrechnung sähe genauso plausibel aus wie eine richtige.
    """
    pairs: list[tuple[str, str, str, float | None]] = []
    for raw_event in provider.last_raw_events:
        for market in (raw_event.get("odds") or {}).values():
            if not isinstance(market, dict):
                continue
            side = str(market.get("sideID") or "?")
            for bookmaker, entry in (market.get("byBookmaker") or {}).items():
                if not isinstance(entry, dict):
                    continue
                raw = str(entry.get("odds") or "")
                pairs.append((str(bookmaker), side, raw, american_to_decimal(raw)))
    return pairs


async def check_sportsgameodds(args: argparse.Namespace) -> int:
    """Key prüfen und - genauso wichtig - das Quotenformat sichtbar machen.

    Die API liefert Quoten als Zeichenkette. Ob "-110" amerikanisch gemeint
    ist, entscheidet über jeden einzelnen Preis im System. Deshalb zeigt das
    Skript Rohwert und umgerechneten Wert nebeneinander: eine falsch
    verstandene Umrechnung fällt hier auf, nicht erst in den Alarmen.
    """
    provider = SportsGameOddsProvider(
        api_key=args.key,
        base_url=args.base_url,
        leagues=args.leagues,
        sport_ids=args.sports,
        live_only=args.live,
        page_limit=args.limit,
        max_pages=1,
        rate_limit_per_minute=int(PLANS[args.plan]["rpm"]),
    )
    print(f"{INFO} Prüfe SportsGameOdds ...")
    try:
        await provider.connect()
        events = await provider.get_events()
        quotes = await provider.get_odds()
    except ProviderAuthError as exc:
        print(f"{FAIL} {exc}")
        print("       Key prüfen: https://sportsgameodds.com/pricing")
        return 2
    except ProviderError as exc:
        print(f"{FAIL} {exc}")
        print(
            explain_network_error(str(exc)).replace(
                "api.the-odds-api.com", "api.sportsgameodds.com"
            )
        )
        return 2
    finally:
        await provider.disconnect()

    print(f"{OK} Key akzeptiert.")
    if provider.health.rate_limit_remaining is not None:
        print(f"{INFO} Restkontingent laut API: {provider.health.rate_limit_remaining}")

    live = [e for e in events if e.status.value == "LIVE"]
    print(f"{OK} {len(events)} Events gefunden, davon {len(live)} live.")
    if not events:
        print(
            f"{INFO} Keine Events. Mögliche Gründe: --live gesetzt und gerade läuft nichts,\n"
            "       oder die gewählten Ligen sind im Tarif nicht enthalten."
        )

    print(f"{OK} {len(quotes)} verwertbare Quoten.")
    if provider.skipped:
        print(f"{INFO} Übersprungen (bewusst, nichts wird geraten):")
        for reason, count in provider.skipped.most_common(8):
            sample = provider.skipped_samples.get(reason, {})
            detail = ""
            if sample.get("statID") or sample.get("marketName"):
                detail = (
                    f"   Beispiel: statID={sample.get('statID') or '?'}"
                    f" · {sample.get('marketName') or 'ohne Namen'}"
                )
            print(f"         {reason}: {count}{detail}")
        print(
            "       Ist darunter ein Markt, den du brauchst? Schick diese Zeilen -\n"
            "       aus statID und Name lässt sich die Zuordnung belegen statt raten."
        )

    if quotes:
        print()
        print("--- Quotenformat prüfen (Rohwert -> umgerechnet) ---")
        print("    Vergleiche die rechte Spalte mit der Anzeige des Buchmachers.")
        print("    Weichen sie ab, ist das Quotenformat anders als angenommen -")
        print("    dann bitte melden, JEDER Preis im System wäre sonst falsch.")
        for bookmaker, side, raw, decimal in _raw_pairs(provider)[:10]:
            marker = " " if decimal else "  <-- nicht lesbar"
            shown = f"{decimal:.3f}" if decimal else "?"
            print(f"      {bookmaker:<14} {side:<8} {raw:>8}  ->  {shown}{marker}")
    elif events:
        print(f"{FAIL} Events da, aber keine einzige verwertbare Quote.")
        print("       Das deutet auf ein abweichendes Antwortschema hin - bitte melden.")
        return 3

    env_block = "\n".join(
        [
            "PROVIDERS=sportsgameodds",
            f"SGO_API_KEY={args.key}",
            *(
                [f"SGO_BASE_URL={args.base_url}"]
                if args.base_url != "https://api.sportsgameodds.com/v2"
                else []
            ),
            f"SGO_SPORT_IDS={args.sports}",
            f"SGO_LEAGUES={args.leagues}",
            f"SGO_LIVE_ONLY={'true' if args.live else 'false'}",
            f"SGO_POLL_INTERVAL={PLANS[args.plan]['poll']}",
            f"SGO_MAX_PAGES={PLANS[args.plan]['pages']}",
            f"SGO_PAGE_LIMIT={PLANS[args.plan]['page_limit']}",
            f"SGO_RATE_LIMIT_PER_MINUTE={PLANS[args.plan]['rpm']}",
            "MIN_BOOKMAKERS=3",
            f"MAX_ODDS_AGE_SECONDS={PLANS[args.plan]['max_age']}",
        ]
    )
    print(f"\n--- Für deine .env (Tarif: {args.plan}) ---")
    print(env_block)
    plan = PLANS[args.plan]
    print(
        f"\n{INFO} Ergibt {60 / plan['poll'] * plan['pages']:.0f} Anfragen/Minute "
        f"von {plan['rpm']} erlaubten."
    )
    if args.write:
        written = apply_to_env(Path(args.env), env_block)
        print(f"\n{OK} {written} Zeilen in {args.env} gesetzt.")
        print("       Jetzt: docker compose up -d --build")
    else:
        print("\n       Mit --write trägt das Skript das direkt in die .env ein.")
    return 0


def apply_to_env(path: Path, block: str) -> int:
    """Schlüssel in der .env setzen oder ergänzen - Kommentare bleiben erhalten."""
    updates: dict[str, str] = {}
    for line in block.splitlines():
        if line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        updates[key] = value

    lines = path.read_text().splitlines() if path.exists() else []
    seen: set[str] = set()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0]
        if key in updates:
            lines[index] = f"{key}={updates[key]}"
            seen.add(key)
    for key, value in updates.items():
        if key not in seen:
            lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n")
    return len(updates)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Echte Datenquelle prüfen und konfigurieren.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "provider", choices=["the_odds_api", "sportsgameodds"], help="Zu prüfende Quelle"
    )
    parser.add_argument("--key", required=True, help="API-Key")
    parser.add_argument("--regions", default="eu,uk", help="Regionen (Standard: eu,uk)")
    parser.add_argument("--markets", default="h2h,totals", help="Märkte (Standard: h2h,totals)")
    parser.add_argument("--max-sports", type=int, default=4, help="Max. Wettbewerbe")
    parser.add_argument("--env", default=".env", help="Pfad zur .env")
    # nur sportsgameodds
    parser.add_argument("--leagues", default="", help="Ligen, z. B. EPL,BUNDESLIGA")
    parser.add_argument("--sports", default="SOCCER,TENNIS", help="sportIDs")
    parser.add_argument("--live", action="store_true", help="nur laufende Events")
    parser.add_argument(
        "--plan",
        choices=sorted(PLANS),
        default="free",
        help="Tarif - bestimmt Poll-Takt und Anfragelimit (Standard: free)",
    )
    parser.add_argument("--limit", type=int, default=25, help="Events je Seite")
    parser.add_argument(
        "--base-url",
        default="https://api.sportsgameodds.com/v2",
        help="Basis-URL (für Tests oder ein Gateway)",
    )
    parser.add_argument("--write", action="store_true", help="Ergebnis in die .env schreiben")
    return parser


CHECKS = {
    "the_odds_api": check_the_odds_api,
    "sportsgameodds": check_sportsgameodds,
}


def main() -> int:
    args = build_parser().parse_args()
    return asyncio.run(CHECKS[args.provider](args))


if __name__ == "__main__":
    raise SystemExit(main())
