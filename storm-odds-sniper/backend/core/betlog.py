"""Wett-Tagebuch: was wurde tatsächlich gespielt - und was kam dabei heraus?

Die Trefferbilanz (``verdict.py``) misst, ob die *Alarme* etwas taugten. Das
ist eine andere Frage als die, um die es am Ende geht: **hat es Geld
gebracht?** Ein Alarm kann sauber gewesen sein, und trotzdem war der Preis
weg, als du geklickt hast. Umgekehrt sagt ein positiver Closing Line Value
nichts darüber, ob die Wette gewonnen hat.

Dieses Modul rechnet deshalb nur mit dem, was wirklich passiert ist:
Einsatz, genommene Quote, Ausgang. Es setzt nichts und weiß nichts über
Ergebnisse - der Mensch trägt ein, wie es ausgegangen ist.

Ehrlichkeitshinweis, der auch in der README steht: eine Rendite aus einer
Handvoll Wetten ist keine Rendite, sondern Zufall. Unterhalb von
``MIN_SETTLED`` abgerechneten Wetten weist die Bilanz das ausdrücklich aus,
statt eine Prozentzahl hinzustellen, die nach Können aussieht.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class BetStatus(StrEnum):
    """Ausgang einer Wette."""

    #: Läuft noch - zählt in keine Rendite hinein.
    OPEN = "open"
    WON = "won"
    LOST = "lost"
    #: Annulliert (Spiel abgesagt, Markt gestrichen): Einsatz zurück.
    VOID = "void"


STATUS_LABELS: dict[str, str] = {
    BetStatus.OPEN: "offen",
    BetStatus.WON: "gewonnen",
    BetStatus.LOST: "verloren",
    BetStatus.VOID: "annulliert - Einsatz zurück",
}

STATUS_ICONS: dict[str, str] = {
    BetStatus.OPEN: "⏳",
    BetStatus.WON: "✅",
    BetStatus.LOST: "❌",
    BetStatus.VOID: "➖",
}

#: Unterhalb so vieler abgerechneter Wetten ist jede Rendite Zufallsrauschen.
#: Dieselbe Haltung wie bei der Trefferbilanz - lieber der Zählerstand als
#: eine Prozentzahl, die nach Können aussieht.
MIN_SETTLED = 20


def stake_from_recommendation(recommendation: dict, *, bankroll: float) -> float:
    """Einsatz aus einer gespeicherten Empfehlung ableiten.

    Der Prozentsatz ist die dauerhafte Größe; der Betrag ist nur seine
    Darstellung gegen die *aktuelle* Bankroll. Eine Empfehlung, die vor dem
    Hinterlegen der Bankroll entstand, trägt gar keinen Betrag - ihn dann
    einfach wegzulassen, hieße einen Prozentwert als Euro-Betrag ins
    Tagebuch zu schreiben. Genau davor warnt die Bilanz sonst.
    """
    prozent = float(recommendation.get("stake_percent") or 0.0)
    if bankroll > 0:
        math = recommendation.get("math") or {}
        return float(math.get("stake_amount") or bankroll * prozent / 100.0)
    return prozent


def settle_profit(status: str, *, stake: float, odds: float) -> float | None:
    """Nettogewinn einer abgerechneten Wette.

    ``None`` heißt: läuft noch, es gibt nichts zu rechnen. Bei ``void`` ist
    das Ergebnis exakt null - der Einsatz kommt zurück, und die Wette darf
    weder als Treffer noch als Fehlschlag zählen.
    """
    if status == BetStatus.WON:
        return stake * (odds - 1.0)
    if status == BetStatus.LOST:
        return -stake
    if status == BetStatus.VOID:
        return 0.0
    return None


@dataclass(slots=True)
class Ledger:
    """Die Bilanz über eine Menge von Wetten."""

    total: int = 0
    open_count: int = 0
    settled: int = 0
    wins: int = 0
    losses: int = 0
    voids: int = 0
    #: Einsatz der abgerechneten Wetten (annullierte zählen nicht mit - dort
    #: war nie Geld im Risiko).
    staked: float = 0.0
    #: Einsatz, der gerade noch läuft.
    open_stake: float = 0.0
    profit: float = 0.0
    #: Was die Empfehlungen für dieselben Wetten versprochen hatten.
    expected_profit: float = 0.0
    #: Beträge oder Prozentpunkte der Bankroll - siehe ``unit``.
    unit: str = "Einheiten"
    notes: list[str] = field(default_factory=list)

    @property
    def roi_percent(self) -> float | None:
        if self.staked <= 0:
            return None
        return self.profit / self.staked * 100.0

    @property
    def hit_rate_percent(self) -> float | None:
        entschieden = self.wins + self.losses
        if entschieden <= 0:
            return None
        return self.wins / entschieden * 100.0

    @property
    def expected_roi_percent(self) -> float | None:
        if self.staked <= 0:
            return None
        return self.expected_profit / self.staked * 100.0

    @property
    def reliable(self) -> bool:
        """Reicht die Zahl der Wetten, um von einer Rendite zu sprechen?"""
        return self.settled >= MIN_SETTLED

    def to_json(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "open_count": self.open_count,
            "settled": self.settled,
            "wins": self.wins,
            "losses": self.losses,
            "voids": self.voids,
            "staked": round(self.staked, 2),
            "open_stake": round(self.open_stake, 2),
            "profit": round(self.profit, 2),
            "expected_profit": round(self.expected_profit, 2),
            "roi_percent": _round(self.roi_percent),
            "expected_roi_percent": _round(self.expected_roi_percent),
            "hit_rate_percent": _round(self.hit_rate_percent),
            "reliable": self.reliable,
            "min_settled": MIN_SETTLED,
            "unit": self.unit,
            "notes": list(self.notes),
        }


def _round(value: float | None) -> float | None:
    return round(value, 2) if value is not None else None


def summarise(rows: Iterable[Any], *, unit: str = "Einheiten") -> Ledger:
    """Bilanz aus Wett-Zeilen bilden.

    Erwartet Objekte mit ``status``, ``stake``, ``odds``, ``profit`` und
    ``expected_edge_percent`` - Datenbankzeilen ebenso wie Dataclasses. Die
    Funktion selbst kennt keine Datenbank; sie lässt sich damit gegen
    handgeschriebene Fälle prüfen.
    """
    ledger = Ledger(unit=unit)
    for row in rows:
        ledger.total += 1
        stake = float(getattr(row, "stake", 0.0) or 0.0)
        status = str(getattr(row, "status", BetStatus.OPEN))

        if status == BetStatus.OPEN:
            ledger.open_count += 1
            ledger.open_stake += stake
            continue

        ledger.settled += 1
        if status == BetStatus.VOID:
            # Annulliert: kein Treffer, kein Fehlschlag, kein Einsatz im
            # Risiko. Würde man ihn mitzählen, sähe jede Rendite besser aus,
            # als sie war.
            ledger.voids += 1
            continue

        ledger.staked += stake
        gewinn = getattr(row, "profit", None)
        if gewinn is None:
            gewinn = settle_profit(status, stake=stake, odds=float(getattr(row, "odds", 0.0)))
        ledger.profit += float(gewinn or 0.0)

        edge = getattr(row, "expected_edge_percent", None)
        if edge is not None:
            ledger.expected_profit += stake * float(edge) / 100.0

        if status == BetStatus.WON:
            ledger.wins += 1
        elif status == BetStatus.LOST:
            ledger.losses += 1

    if ledger.settled and not ledger.reliable:
        ledger.notes.append(
            f"Nur {ledger.settled} abgerechnete Wetten - eine Rendite daraus ist "
            f"Zufall, keine Aussage. Ab {MIN_SETTLED} wird sie hier als Kennzahl "
            "geführt."
        )
    if ledger.open_count:
        ledger.notes.append(
            f"{ledger.open_count} Wetten laufen noch und zählen in keine Rendite hinein."
        )
    return ledger
