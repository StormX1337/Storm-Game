"""Sichere Wetten: wenn die Buchmacher sich untereinander widersprechen.

Der Rest dieses Projekts *schätzt*. Die faire Quote ist ein Modell, der
Vorteil eine Annahme, die Empfehlung eine Rechnung auf beides. Hier nicht:

    Über 2.5 bei A zu 2.10   ->  1/2.10 = 47,6 %
    Unter 2.5 bei B zu 2.15  ->  1/2.15 = 46,5 %
                                 ------------
                                          94,1 %

Zusammen weniger als 100 % - also lässt sich jeder Ausgang so kaufen, dass
am Ende mehr zurückkommt als eingesetzt wurde, ganz gleich wie das Spiel
ausgeht. Das ist keine Prognose, sondern Arithmetik.

Der Haken liegt nicht in der Rechnung, sondern in der Wirklichkeit, und
dieses Modul sagt das an drei Stellen offen:

* **Ein einziger Buchmacher ist keine Arbitrage.** Widerspricht sich ein
  Buch in sich selbst, ist das fast immer eine falsche Linie oder ein
  veralteter Preis - kein Geschenk.
* **Zu schön ist verdächtig.** Reale Arbitragen liegen bei 0,5-3 %. Alles
  jenseits von ``max_profit_percent`` ist praktisch immer ein Datenfehler
  und wird ausgewiesen, nicht angepriesen.
* **Preise sind flüchtig.** Beide Seiten müssen frisch sein, und selbst dann
  kann eine davon weg sein, bevor die zweite Wette steht. Wer nur eine Seite
  bekommt, steht mit einer ungewollten Einzelwette da.

Gesetzt wird auch hier nichts. Das Modul rechnet und zeigt an.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.models.domain import MarketKey, OddsQuote, now_ts
from backend.models.enums import COMPLETE_BOOK_MARKETS, EXPECTED_SELECTIONS


@dataclass(slots=True)
class ArbitrageConfig:
    """Stellschrauben der Erkennung."""

    #: Darunter lohnt der Aufwand nicht - und Rundung erzeugt Scheinfunde.
    min_profit_percent: float = 0.3
    #: Darüber ist es praktisch immer ein Datenfehler (falsche Linie,
    #: veralteter Preis, ein Markt der nur so heißt wie unserer).
    max_profit_percent: float = 12.0
    #: Wie alt eine Quote höchstens sein darf. Beide Seiten müssen stehen.
    max_age: float = 15.0
    #: Weniger Bücher heißt: das Buch widerspricht sich selbst.
    min_bookmakers: int = 2


@dataclass(slots=True)
class Leg:
    """Ein Bein der Wette: ein Ausgang bei einem Buchmacher."""

    selection_key: str
    selection_label: str
    bookmaker: str
    odds: float
    #: Anteil des Gesamteinsatzes, damit jeder Ausgang gleich viel zurückgibt.
    stake_share: float
    #: Alter der Quote in Sekunden.
    age: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "selection": self.selection_key,
            "selection_label": self.selection_label,
            "bookmaker": self.bookmaker,
            "odds": round(self.odds, 3),
            "stake_share": round(self.stake_share, 4),
            "stake_percent": round(self.stake_share * 100.0, 2),
            "age": round(self.age, 1),
        }


@dataclass(slots=True)
class Arbitrage:
    """Ein Markt, in dem sich die Bücher widersprechen."""

    event_id: str
    event_title: str
    sport: str
    market: MarketKey
    legs: list[Leg]
    #: Summe der Gegenwahrscheinlichkeiten. Unter 1 heißt: es geht auf.
    total_probability: float
    profit_percent: float
    #: Wie alt die *älteste* beteiligte Quote ist - danach richtet sich, wie
    #: lange man diesem Fund noch trauen darf.
    max_age: float
    #: Unplausibel groß: mitgeliefert, aber ausdrücklich als Verdacht.
    suspicious: bool = False
    detected_at: float = field(default_factory=now_ts)

    @property
    def bookmakers(self) -> list[str]:
        return sorted({leg.bookmaker for leg in self.legs})

    @property
    def key(self) -> str:
        return f"{self.event_id}|{self.market.key}"

    def payout(self, total_stake: float) -> float:
        """Rückfluss bei diesem Gesamteinsatz - für jeden Ausgang gleich."""
        if not self.legs:
            return 0.0
        leg = self.legs[0]
        return total_stake * leg.stake_share * leg.odds

    def to_json(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "event_title": self.event_title,
            "sport": self.sport,
            "market": self.market.key,
            "market_label": self.market.label,
            "legs": [leg.to_json() for leg in self.legs],
            "total_probability": round(self.total_probability, 5),
            "profit_percent": round(self.profit_percent, 3),
            "bookmakers": self.bookmakers,
            "max_age": round(self.max_age, 1),
            "suspicious": self.suspicious,
            "detected_at": self.detected_at,
        }


def stake_split(odds: list[float]) -> list[float]:
    """Einsatzanteile, die jeden Ausgang gleich viel zurückgeben lassen.

    Anteil je Bein = (1/Quote) / Summe(1/Quote). Damit ist der Rückfluss
    unabhängig davon, wie das Spiel ausgeht - genau das macht die Sache
    sicher, solange beide Preise stehen.
    """
    inverse = [1.0 / o for o in odds if o > 0]
    total = sum(inverse)
    if total <= 0:
        return []
    return [value / total for value in inverse]


def find_arbitrage(
    book,
    *,
    event_title: str = "",
    sport: str = "",
    reference: float | None = None,
    config: ArbitrageConfig | None = None,
) -> Arbitrage | None:
    """Widersprechen sich die Bücher in diesem Markt?

    ``book`` ist ein ``MarketBook``. Gibt ``None`` zurück, wenn der Markt
    unvollständig ist, die Preise zu alt sind oder schlicht kein Widerspruch
    vorliegt - der Normalfall.
    """
    cfg = config or ArbitrageConfig()
    ref = reference if reference is not None else now_ts()

    if book.market.type not in COMPLETE_BOOK_MARKETS:
        return None
    erwartet = EXPECTED_SELECTIONS.get(book.market.type)
    if erwartet is None or len(book.quotes) != erwartet:
        # Ohne vollständiges Buch fehlt ein Ausgang - dann ist die Summe der
        # Wahrscheinlichkeiten zwangsläufig unter 1, ohne dass das etwas
        # bedeutet. Genau hier entstünden sonst massenhaft Scheinfunde.
        return None

    best: list[Leg] = []
    for selection_key in book.selection_keys:
        kandidaten = [
            quote
            for quote in book.quotes.get(selection_key, {}).values()
            if _usable(quote, ref, cfg.max_age)
        ]
        if not kandidaten:
            return None
        gewinner = max(kandidaten, key=lambda q: q.price)
        best.append(
            Leg(
                selection_key=selection_key,
                selection_label=gewinner.selection.display,
                bookmaker=gewinner.bookmaker,
                odds=gewinner.price,
                stake_share=0.0,
                age=gewinner.age(ref),
            )
        )

    if len({leg.bookmaker for leg in best}) < cfg.min_bookmakers:
        # Ein Buch, das sich selbst widerspricht, hat einen Fehler - keinen
        # Fehlpreis, den man mitnehmen könnte.
        return None

    total = sum(1.0 / leg.odds for leg in best)
    if total <= 0 or total >= 1.0:
        return None

    profit = (1.0 / total - 1.0) * 100.0
    if profit < cfg.min_profit_percent:
        return None

    for leg, share in zip(best, stake_split([leg.odds for leg in best]), strict=True):
        leg.stake_share = share

    return Arbitrage(
        event_id=book.event_id,
        event_title=event_title,
        sport=sport,
        market=book.market,
        legs=best,
        total_probability=total,
        profit_percent=profit,
        max_age=max(leg.age for leg in best),
        suspicious=profit > cfg.max_profit_percent,
    )


def _usable(quote: OddsQuote, reference: float, max_age: float) -> bool:
    return not quote.suspended and quote.price > 1.0 and quote.age(reference) <= max_age
