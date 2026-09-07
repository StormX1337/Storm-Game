#!/usr/bin/env python
"""Echte Datenquelle einrichten und sofort prüfen.

Der Umstieg von der Simulation auf echte Quoten scheitert meist an zwei
Dingen: der Key ist falsch, oder das Kontingent ist nach ein paar Stunden
aufgebraucht. Dieses Skript prüft beides, bevor der Scanner startet.

    python scripts/setup_provider.py the_odds_api --key DEIN_KEY
    python scripts/setup_provider.py the_odds_api --key DEIN_KEY --write

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
from backend.providers.the_odds_api import TheOddsApiProvider, sport_from_key  # noqa: E402

OK, FAIL, INFO = "[ OK ]", "[FEHL]", "[    ]"


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
        print("       Jetzt: docker compose up -d")
    else:
        print("\n       Mit --write trägt das Skript das direkt in die .env ein.")

    await provider.disconnect()
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
    parser.add_argument("provider", choices=["the_odds_api"], help="Zu prüfende Quelle")
    parser.add_argument("--key", required=True, help="API-Key")
    parser.add_argument("--regions", default="eu,uk", help="Regionen (Standard: eu,uk)")
    parser.add_argument("--markets", default="h2h,totals", help="Märkte (Standard: h2h,totals)")
    parser.add_argument("--max-sports", type=int, default=4, help="Max. Wettbewerbe")
    parser.add_argument("--env", default=".env", help="Pfad zur .env")
    parser.add_argument("--write", action="store_true", help="Ergebnis in die .env schreiben")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return asyncio.run(check_the_odds_api(args))


if __name__ == "__main__":
    raise SystemExit(main())
