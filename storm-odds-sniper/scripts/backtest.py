"""Das Empfehlungsmodell gegen die eigenen Alarme halten.

    ./scripts/backtest.sh                # letzte 7 Tage
    ./scripts/backtest.sh --days 30
    ./scripts/backtest.sh --json         # maschinenlesbar

Beantwortet zwei Fragen mit Daten, die längst in der Datenbank liegen:

1. Haben Alarme mit „spielen" hinterher besseren Closing Line Value als die
   mit „nicht spielen"? Wenn nicht, sortiert der Grad nichts.
2. Wäre eine reine Sortierung nach gemeldetem Value besser gewesen als die
   Schrumpfung? Das ist die Streitfrage hinter dem ganzen Modul.

Es wird nichts geschrieben und nichts abgerufen - nur gelesen und gerechnet.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from backend.core.backtest import (  # noqa: E402
    MAX_PLAUSIBLE_CLV,
    MIN_PER_GROUP,
    Sample,
    analyse,
)
from backend.core.config import Settings, get_settings  # noqa: E402
from backend.core.recommendation import (  # noqa: E402
    GRADE_LABELS,
    Recommendation,
    config_from_settings,
)
from backend.core.recommendation import evaluate as recommend  # noqa: E402
from backend.database.tables import AlertRow  # noqa: E402
from backend.models.domain import Alert  # noqa: E402

BALKEN = "─" * 72


def _prozent(wert: float | None) -> str:
    """CLV - das Vorzeichen gehört dazu."""
    return f"{wert:+.1f} %" if wert is not None else "–"


def _anteil(wert: float | None) -> str:
    """Ein Anteil ist nie negativ - hier wäre ein Vorzeichen irreführend."""
    return f"{wert:.0f} %" if wert is not None else "–"


async def sammeln(settings: Settings, days: int, limit: int) -> tuple[list[Sample], int, int]:
    """Alarme laden und je Alarm eine Probe bilden.

    Alarme aus der Zeit vor dem Empfehlungsmodul tragen keinen Grad. Sie
    werden mit den *heutigen* Einstellungen nachgerechnet - genau das ist
    hier der Sinn: wie hätte das Modell entschieden?

    Die Einstellungen kommen von außen: was beim *Lesen der .env* schiefgeht,
    ist kein Datenbankproblem und darf auch nicht als eines gemeldet werden.
    """
    config = config_from_settings(settings)
    engine = create_async_engine(settings.sqlalchemy_dsn)
    factory = async_sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)

    seit = datetime.now(UTC) - timedelta(days=days)
    stmt = (
        select(AlertRow)
        .where(AlertRow.detected_at >= seit)
        .order_by(AlertRow.detected_at.desc())
        .limit(limit)
    )
    async with factory() as session:
        rows = list((await session.execute(stmt)).scalars().all())
    await engine.dispose()

    proben: list[Sample] = []
    nachgerechnet = 0
    unlesbar = 0
    for row in rows:
        try:
            alert = Alert.from_json(row.payload or {})
        except Exception:  # noqa: BLE001 - eine kaputte Zeile kippt nichts
            unlesbar += 1
            continue
        gespeichert = alert.recommendation
        if gespeichert:
            empfehlung = Recommendation.from_json(gespeichert)
        else:
            empfehlung = recommend(alert, config)
            nachgerechnet += 1
        proben.append(
            Sample(
                grade=empfehlung.grade.value,
                credible_edge=empfehlung.credible_edge_percent,
                raw_edge=empfehlung.raw_edge_percent,
                clv_percent=row.clv_percent,
                verdict=row.verdict,
            )
        )
    return proben, nachgerechnet, unlesbar


def ausgeben(ergebnis, *, days: int, nachgerechnet: int, unlesbar: int) -> None:
    print(f"\nStorm Odds Sniper - Modellprüfung ({days} Tage)")
    print(BALKEN)
    print(f"Alarme geprüft         : {ergebnis.total}")
    print(f"davon nachkontrolliert : {ergebnis.scored}")
    if nachgerechnet:
        print(f"ohne gespeicherten Grad: {nachgerechnet} (mit heutigen Einstellungen gerechnet)")
    if unlesbar:
        print(f"nicht lesbar           : {unlesbar}")

    print(f"\n1) Trennt der Grad?\n{BALKEN}")
    if not ergebnis.groups:
        print("  Keine Alarme im Zeitraum.")
    else:
        print(
            f"  {'Grad':<18}{'Alarme':>8}{'davon':>7}{'Median':>9}"
            f"{'Mittel':>10}{'korrigiert':>12}{'kaputt':>8}"
        )
        for gruppe in ergebnis.groups:
            median = _prozent(gruppe.median_clv_percent)
            mittel = _prozent(gruppe.avg_clv_percent)
            korrigiert = _anteil(gruppe.corrected_share)
            marke = "" if gruppe.reliable else "  (zu wenig)"
            print(
                f"  {GRADE_LABELS.get(gruppe.grade, gruppe.grade):<18}"
                f"{gruppe.count:>8}{gruppe.scored:>7}{median:>9}"
                f"{mittel:>10}{korrigiert:>12}{gruppe.extreme:>8}{marke}"
            )
        print()
        print("  Median = belastbarer Wert · Mittel = vom Ausreißerschwanz verdorben")
        print("  korrigiert = Buchmacher zog den Preis selbst zurück (unabhängiger Beleg)")
        print(f"  kaputt = CLV über {MAX_PLAUSIBLE_CLV:.0f} %, also keine gültige Referenz")
    if ergebnis.separates is True:
        print("\n  ✅ Spielbare Alarme haben besseren CLV als verworfene.")
        print("     Der Grad sortiert also etwas Echtes.")
    elif ergebnis.separates is False:
        print("\n  ❌ Spielbare Alarme haben KEINEN besseren CLV als verworfene.")
        print("     Der Grad sortiert nichts - die Schwellen gehören überprüft.")
    else:
        print(f"\n  ⏳ Noch keine Aussage (nötig sind je {MIN_PER_GROUP} ausgewertete Alarme).")

    duell = ergebnis.head_to_head
    print(f"\n2) Hilft die Schrumpfung?\n{BALKEN}")
    print(f"  Die {duell.n} besten Alarme nach ...")
    if duell.credible_median_clv is not None:
        print(
            f"    glaubwürdigem Vorteil : Median-CLV {duell.credible_median_clv:+7.1f} %"
            f"   selbst korrigiert {_anteil(duell.credible_corrected_share)}"
            f"   kaputt {duell.credible_extreme}"
        )
        print(
            f"    gemeldetem Value      : Median-CLV {duell.raw_median_clv:+7.1f} %"
            f"   selbst korrigiert {_anteil(duell.raw_corrected_share)}"
            f"   kaputt {duell.raw_extreme}"
        )
        print(f"    Überschneidung        : {duell.overlap} von {duell.n}")
    print(f"\n  {duell.verdict}")

    for note in ergebnis.notes:
        print(f"\n  ℹ️  {note}")

    print(f"\n{BALKEN}")
    print("CLV ist KEIN Gewinn - er misst nur, ob ein Preis besser war als der")
    print("Marktkonsens kurz danach. Und gemeldet wurde nur, was die Filter")
    print("durchgelassen haben; über andere Preise sagt das hier nichts.")


async def main() -> int:
    parser = argparse.ArgumentParser(description="Empfehlungsmodell gegen echte Alarme prüfen")
    parser.add_argument("--days", type=int, default=7, help="Zeitraum in Tagen (Standard 7)")
    parser.add_argument("--limit", type=int, default=20000, help="Höchstzahl Alarme")
    parser.add_argument("--json", action="store_true", help="Maschinenlesbar ausgeben")
    args = parser.parse_args()

    # Zwei Schritte, zwei Meldungen. Ein Rechtefehler an der .env als
    # "Datenbank nicht erreichbar" auszugeben, schickt beim Suchen in die
    # völlig falsche Richtung - die Datenbank war dann nie im Spiel.
    try:
        settings = get_settings()
    except Exception as exc:  # noqa: BLE001 - ohne Einstellungen geht nichts
        print(f"Einstellungen nicht lesbar: {exc}", file=sys.stderr)
        if isinstance(exc, PermissionError):
            print(
                "Die .env gehört auf einem Server üblicherweise root. Der "
                "Container muss sie darum als root lesen - ./scripts/backtest.sh "
                "macht das selbst. Von Hand gestartet: mit sudo.",
                file=sys.stderr,
            )
        return 1

    try:
        proben, nachgerechnet, unlesbar = await sammeln(settings, args.days, args.limit)
    except Exception as exc:  # noqa: BLE001 - ohne Datenbank gibt es nichts zu prüfen
        print(f"Datenbank nicht erreichbar: {exc}", file=sys.stderr)
        return 1

    ergebnis = analyse(proben)
    if args.json:
        print(
            json.dumps(
                {
                    **ergebnis.to_json(),
                    "days": args.days,
                    "recomputed": nachgerechnet,
                    "unreadable": unlesbar,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        ausgeben(ergebnis, days=args.days, nachgerechnet=nachgerechnet, unlesbar=unlesbar)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
