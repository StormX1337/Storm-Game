"""Daten eines Buchmachers aus der Datenbank entfernen.

    ./scripts/purge-bookmaker.sh 'Mock%'              # Trockenlauf
    ./scripts/purge-bookmaker.sh 'Mock%' --wirklich   # löschen

Gedacht für Altlasten: die Simulation ist längst aus dem Code entfernt, ihre
Zeilen liegen aber weiter in der Datenbank und verfälschen jede Auswertung -
Trefferbilanz, Buchmacherliste und vor allem die Modellprüfung, die dann auf
erfundenen Preisen rechnet.

Drei Sicherungen sind eingebaut, weil Löschen nicht rückgängig zu machen ist:

* **Trockenlauf ist die Vorgabe.** Ohne ``--wirklich`` wird nur gezählt.
* **Das Wett-Tagebuch wird nie angefasst.** Alles andere kann der Scanner neu
  sammeln; was ein Mensch gespielt hat, kann niemand rekonstruieren. Betrifft
  ein Muster auch Wetten, sagt das Skript es und lässt die Zeilen stehen.
* **Muster, die alles treffen, werden abgelehnt.** ``%`` allein löscht die
  komplette Datenbank - das ist kein Aufräumen mehr.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import delete, func, select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from backend.core.config import get_settings  # noqa: E402
from backend.database.tables import (  # noqa: E402
    AlertRow,
    Bet,
    Bookmaker,
    OddsChangeRow,
    OddsSnapshot,
)

BALKEN = "─" * 68

#: Muster, die praktisch alles treffen. Wer das will, macht es von Hand.
ZU_BREIT = {"%", "%%", "_%", "%_"}


async def zaehlen(session, muster: str) -> dict:
    treffer = list(
        (await session.execute(select(Bookmaker).where(Bookmaker.key.like(muster)))).scalars()
    )
    ids = [b.id for b in treffer]
    schluessel = [b.key for b in treffer]

    async def anzahl(stmt) -> int:
        return int((await session.execute(stmt)).scalar() or 0)

    return {
        "buecher": treffer,
        "alerts": await anzahl(
            select(func.count()).select_from(AlertRow).where(AlertRow.bookmaker.in_(schluessel))
        )
        if schluessel
        else 0,
        "snapshots": await anzahl(
            select(func.count()).select_from(OddsSnapshot).where(OddsSnapshot.bookmaker_id.in_(ids))
        )
        if ids
        else 0,
        "changes": await anzahl(
            select(func.count()).select_from(OddsChangeRow).where(OddsChangeRow.bookmaker_id.in_(ids))
        )
        if ids
        else 0,
        "bets": await anzahl(
            select(func.count()).select_from(Bet).where(Bet.bookmaker.in_(schluessel))
        )
        if schluessel
        else 0,
    }


async def loeschen(session, muster: str, stand: dict) -> None:
    ids = [b.id for b in stand["buecher"]]
    schluessel = [b.key for b in stand["buecher"]]
    # Reihenfolge wegen der Fremdschlüssel: erst was auf Buchmacher zeigt,
    # dann der Buchmacher selbst. Das Wett-Tagebuch fehlt hier absichtlich.
    await session.execute(delete(AlertRow).where(AlertRow.bookmaker.in_(schluessel)))
    await session.execute(delete(OddsSnapshot).where(OddsSnapshot.bookmaker_id.in_(ids)))
    await session.execute(delete(OddsChangeRow).where(OddsChangeRow.bookmaker_id.in_(ids)))
    await session.execute(delete(Bookmaker).where(Bookmaker.id.in_(ids)))
    await session.commit()


def bericht(muster: str, stand: dict, *, wirklich: bool) -> None:
    print(f"\nAufräumen: Buchmacher nach Muster „{muster}“")
    print(BALKEN)
    if not stand["buecher"]:
        print("  Kein Buchmacher passt auf dieses Muster - nichts zu tun.")
        print("  Welche es gibt, zeigt ./scripts/bookmakers.sh")
        return

    print(f"  {'Buchmacher':<24}")
    for buch in stand["buecher"]:
        print(f"    {buch.key}")
    print()
    print(f"  Alarme          : {stand['alerts']:>10}")
    print(f"  Quoten-Snapshots: {stand['snapshots']:>10}")
    print(f"  Quotenänderungen: {stand['changes']:>10}")
    print(f"  Buchmacher      : {len(stand['buecher']):>10}")

    if stand["bets"]:
        print()
        print(f"  ⚠️  {stand['bets']} Wette(n) im Tagebuch nennen diese Buchmacher.")
        print("     Die bleiben stehen - was ein Mensch gespielt hat, kann")
        print("     niemand rekonstruieren. Bei Bedarf von Hand entfernen.")

    print()
    if wirklich:
        print("  ✓ gelöscht.")
        print("  Die Modellprüfung rechnet ab jetzt auf bereinigten Daten:")
        print("    ./scripts/backtest.sh --days 30")
    else:
        print("  TROCKENLAUF - es wurde nichts verändert.")
        print("  Zum Löschen (legt vorher automatisch eine Sicherung an):")
        print(f"    ./scripts/purge-bookmaker.sh '{muster}' --wirklich")


async def main() -> int:
    parser = argparse.ArgumentParser(description="Buchmacherdaten entfernen")
    parser.add_argument("muster", help="SQL-Muster, z. B. 'Mock%%'")
    parser.add_argument(
        "--wirklich", action="store_true", help="Wirklich löschen (sonst Trockenlauf)"
    )
    args = parser.parse_args()

    if args.muster.strip() in ZU_BREIT:
        print(
            f"Das Muster „{args.muster}“ trifft alles - das wäre kein Aufräumen,\n"
            "sondern das Leeren der Datenbank. Abgelehnt.",
            file=sys.stderr,
        )
        return 2

    try:
        settings = get_settings()
    except Exception as exc:  # noqa: BLE001
        print(f"Einstellungen nicht lesbar: {exc}", file=sys.stderr)
        return 1

    engine = create_async_engine(settings.sqlalchemy_dsn)
    factory = async_sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    try:
        async with factory() as session:
            stand = await zaehlen(session, args.muster)
            if args.wirklich and stand["buecher"]:
                await loeschen(session, args.muster, stand)
    except Exception as exc:  # noqa: BLE001
        print(f"Datenbank nicht erreichbar: {exc}", file=sys.stderr)
        return 1
    finally:
        await engine.dispose()

    bericht(args.muster, stand, wirklich=args.wirklich)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
