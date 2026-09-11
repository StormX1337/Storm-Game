"""Welche Buchmacher liefert die Quelle tatsächlich?

    ./scripts/bookmakers.sh              # letzte 7 Tage
    ./scripts/bookmakers.sh --days 30
    ./scripts/bookmakers.sh --grep bet   # nur passende Namen

Die Frage "sind meine Buchmacher dabei?" lässt sich nicht aus einer Liste
beantworten, die jemand aufgeschrieben hat - sondern nur aus den Daten, die
bei dir ankommen. Genau die zeigt dieses Skript: jeden Namen so, wie die
Quelle ihn liefert, mit der Zahl der beobachteten Preise und der ausgelösten
Alarme.

Was hier NICHT steht, gibt es für dieses System auch nicht. Buchmacher, die
die Quelle nicht führt, lassen sich nicht ergänzen - ihre Webseiten
abzugreifen ist ausgeschlossen (siehe README, Abschnitt Recht und Grenzen).

Die Namen aus der linken Spalte gehören nach ALERT_BOOKMAKERS, wenn nur noch
bei den eigenen Büchern gemeldet werden soll.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from backend.core.config import get_settings  # noqa: E402
from backend.database.tables import AlertRow, Bookmaker, OddsSnapshot  # noqa: E402

BALKEN = "─" * 72


def _her(zeitpunkt) -> str:
    """Wie lange ist der letzte Preis dieses Buchs her?

    Die entscheidende Spalte. Ohne sie steht eine Altlast aus der Datenbank
    neben einer laufenden Quelle und sieht genauso lebendig aus - und wer
    danach filtert, filtert auf etwas, das nie wieder etwas liefert.
    """
    if zeitpunkt is None:
        return "nie"
    sekunden = (datetime.now(UTC) - zeitpunkt).total_seconds()
    if sekunden < 120:
        return "gerade"
    if sekunden < 7200:
        return f"vor {int(sekunden // 60)} Min"
    if sekunden < 172800:
        return f"vor {int(sekunden // 3600)} Std"
    return f"vor {int(sekunden // 86400)} Tagen"


def _her(zeitpunkt) -> str:
    """Wie lange ist der letzte Preis dieses Buchs her?

    Die entscheidende Spalte. Ohne sie steht eine Altlast aus der Datenbank
    neben einer laufenden Quelle und sieht genauso lebendig aus.
    """
    if zeitpunkt is None:
        return "nie"
    sekunden = (datetime.now(UTC) - zeitpunkt).total_seconds()
    if sekunden < 120:
        return "gerade"
    if sekunden < 7200:
        return f"vor {int(sekunden // 60)} Min"
    if sekunden < 172800:
        return f"vor {int(sekunden // 3600)} Std"
    return f"vor {int(sekunden // 86400)} Tagen"


async def sammeln(days: int) -> tuple[list[dict], int]:
    settings = get_settings()
    engine = create_async_engine(settings.sqlalchemy_dsn)
    factory = async_sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    seit = datetime.now(UTC) - timedelta(days=days)

    async with factory() as session:
        roh = (
            await session.execute(
                select(
                    OddsSnapshot.bookmaker_id,
                    func.count(),
                    func.max(OddsSnapshot.received_at),
                )
                .where(OddsSnapshot.received_at >= seit)
                .group_by(OddsSnapshot.bookmaker_id)
            )
        ).all()
        preise = {zeile[0]: zeile[1] for zeile in roh}
        zuletzt = {zeile[0]: zeile[2] for zeile in roh}
        buecher = list((await session.execute(select(Bookmaker))).scalars().all())
        alarme = dict(
            (
                await session.execute(
                    select(AlertRow.bookmaker, func.count())
                    .where(AlertRow.detected_at >= seit)
                    .group_by(AlertRow.bookmaker)
                )
            ).all()
        )
    await engine.dispose()

    zeilen = [
        {
            "key": buch.key,
            "title": buch.title or "",
            "exchange": buch.is_exchange,
            "quotes": preise.get(buch.id, 0),
            "alerts": alarme.get(buch.key, 0),
            "last": zuletzt.get(buch.id),
            "id": buch.id,
        }
        for buch in buecher
    ]
    zeilen.sort(key=lambda z: (-z["quotes"], z["key"]))
    return zeilen, sum(preise.values())


def ausgeben(zeilen: list[dict], gesamt: int, *, days: int, muster: str | None) -> None:
    settings = get_settings()
    eigene = settings.alert_bookmaker_set

    print(f"\nBuchmacher in deinen Daten ({days} Tage)")
    print(BALKEN)
    if not zeilen:
        print("  Noch keine Buchmacher gesehen. Läuft der Scanner?")
        return

    gezeigt = [z for z in zeilen if not muster or muster.lower() in (z["key"] + z["title"]).lower()]
    if not gezeigt:
        print(f"  Kein Buchmacher enthält „{muster}“.")
        print(f"  Insgesamt bekannt: {len(zeilen)} - ohne --grep stehen sie alle da.")
        return

    print(
        f"  {'Name (für ALERT_BOOKMAKERS)':<26}{'Preise':>10}{'Anteil':>8}"
        f"{'Alarme':>8}{'zuletzt':>13}  "
    )
    for z in gezeigt:
        anteil = f"{z['quotes'] / gesamt * 100:.1f} %" if gesamt else "–"
        marke = " ←" if z["key"].lower() in eigene else ""
        art = " (Börse)" if z["exchange"] else ""
        print(
            f"  {z['key'][:24]:<26}{z['quotes']:>10}{anteil:>8}"
            f"{z['alerts']:>8}{_her(z['last']):>13}{marke}{art}"
        )

    print(f"\n  {len(gezeigt)} von {len(zeilen)} Buchmachern · {gesamt} Preise insgesamt")
    if eigene:
        fehlend = sorted(eigene - {z["key"].lower() for z in zeilen})
        print(f"\n  ALERT_BOOKMAKERS ist gesetzt: {', '.join(sorted(eigene))}")
        print("  Mit ← markiert stehen die, die auch wirklich Daten liefern.")
        if fehlend:
            print(f"  NICHT in den Daten gefunden: {', '.join(fehlend)}")
            print("  Schreibfehler oder die Quelle führt sie nicht - so oder so")
            print("  kommt von dort nie ein Alarm.")
    else:
        print("\n  ALERT_BOOKMAKERS ist leer - es wird bei allen gemeldet.")
        print("  Nur bei den eigenen melden: die Namen oben in die .env eintragen.")

    print(f"\n{BALKEN}")
    print("Diese Liste kommt aus deinen eigenen Daten, nicht aus einer Aufstellung.")
    print("Was hier fehlt, führt die Quelle nicht - und lässt sich nicht ergänzen:")
    print("Buchmacher-Webseiten abzugreifen ist in diesem Projekt ausgeschlossen.")


async def main() -> int:
    parser = argparse.ArgumentParser(description="Gelieferte Buchmacher auflisten")
    parser.add_argument("--days", type=int, default=7, help="Zeitraum (Standard 7)")
    parser.add_argument("--grep", help="Nur Namen, die diesen Text enthalten")
    args = parser.parse_args()

    try:
        settings = get_settings()
    except Exception as exc:  # noqa: BLE001 - ohne Einstellungen geht nichts
        print(f"Einstellungen nicht lesbar: {exc}", file=sys.stderr)
        if isinstance(exc, PermissionError):
            print(
                "Die .env gehört meist root - ./scripts/bookmakers.sh regelt das.", file=sys.stderr
            )
        return 1
    _ = settings

    try:
        zeilen, gesamt = await sammeln(args.days)
    except Exception as exc:  # noqa: BLE001
        print(f"Datenbank nicht erreichbar: {exc}", file=sys.stderr)
        return 1

    ausgeben(zeilen, gesamt, days=args.days, muster=args.grep)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
