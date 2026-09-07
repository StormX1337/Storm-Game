"""Value Engine: faire Quoten, Value und Confidence.

Grundidee: eine einzelne Quote sagt wenig. Erst der Vergleich vieler
Buchmacher über *alle* Selektionen eines Marktes ergibt eine belastbare
Wahrscheinlichkeit.

Drei Modelle laufen parallel:

* **Modell A - Markt-Median.** Median der implizierten Wahrscheinlichkeiten
  über alle Buchmacher. Bei vollständigem Buch wird über die Selektionen
  normalisiert, wodurch die Marge implizit verschwindet.
* **Modell B - Margin-Bereinigung.** Je Buchmacher wird der Overround aus dem
  vollständigen Buch entfernt (proportional oder equal-margin), danach
  gemittelt.
* **Modell C - Buchmacher-Konsens.** Wie B, aber gewichtet: scharfe Bücher und
  Börsen zählen mehr, alte und illiquide Quoten weniger.

Der gewichtete Mix der verfügbaren Modelle ergibt die faire Wahrscheinlichkeit.
Die Quote des geprüften Buchmachers fließt **nie** in ihre eigene faire Quote
ein - sonst zieht ein Fehlpreis seine eigene Referenz mit.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field

from backend.models.domain import FairOddsResult, MarketKey, OddsQuote, now_ts
from backend.models.enums import COMPLETE_BOOK_MARKETS, EXPECTED_SELECTIONS

# Gewichte je Buchmacher/Börse. Börsen und Low-Margin-Bücher bilden den Markt
# am besten ab. Unbekannte Namen bekommen das Standardgewicht.
BOOKMAKER_WEIGHTS: dict[str, float] = {
    "pinnacle": 2.5,
    "betfair": 2.4,
    "betfair_ex": 2.4,
    "betfair_ex_eu": 2.4,
    "betfair_ex_uk": 2.4,
    "smarkets": 2.2,
    "matchbook": 2.0,
    "betdaq": 1.8,
    "marathonbet": 1.6,
    "sbobet": 1.5,
    "bet365": 1.3,
    "williamhill": 1.1,
    "unibet": 1.0,
    "bwin": 1.0,
    "betway": 0.9,
}
DEFAULT_BOOKMAKER_WEIGHT = 1.0


@dataclass(slots=True)
class EngineConfig:
    """Stellschrauben der Engine (bewusst ohne globalen Zustand)."""

    max_quote_age: float = 10.0
    margin_method: str = "proportional"  # "proportional" | "equal_margin"
    weight_model_a: float = 0.25
    weight_model_b: float = 0.35
    weight_model_c: float = 0.40
    min_bookmakers: int = 3
    #: Overround außerhalb dieses Bandes gilt als unplausibel (Datenfehler).
    max_overround: float = 1.60
    min_overround: float = 0.90
    live_confidence_penalty: int = 6


# ------------------------------------------------------------------ MarketBook


@dataclass(slots=True)
class MarketBook:
    """Alle bekannten Quoten zu einem Markt eines Events.

    Struktur: ``quotes[selection_key][bookmaker] = OddsQuote``.
    """

    event_id: str
    market: MarketKey
    quotes: dict[str, dict[str, OddsQuote]] = field(default_factory=dict)

    # ------------------------------------------------------------- Aufbau
    def add(self, quote: OddsQuote) -> None:
        self.quotes.setdefault(quote.selection.key, {})[quote.bookmaker] = quote

    @classmethod
    def from_quotes(cls, event_id: str, market: MarketKey, quotes) -> MarketBook:
        book = cls(event_id=event_id, market=market)
        for quote in quotes:
            book.add(quote)
        return book

    # ------------------------------------------------------------- Zugriff
    @property
    def selection_keys(self) -> list[str]:
        return list(self.quotes.keys())

    def bookmakers(self) -> set[str]:
        out: set[str] = set()
        for per_selection in self.quotes.values():
            out.update(per_selection.keys())
        return out

    def usable(
        self, selection_key: str, *, exclude: str | None, reference: float, max_age: float
    ) -> list[OddsQuote]:
        """Frische, nicht suspendierte Quoten einer Selektion."""
        return [
            q
            for bm, q in self.quotes.get(selection_key, {}).items()
            if bm != exclude and not q.suspended and q.price > 1.0 and q.age(reference) <= max_age
        ]

    def bookmaker_book(
        self, bookmaker: str, *, reference: float, max_age: float
    ) -> dict[str, OddsQuote] | None:
        """Alle Selektionen *eines* Buchmachers, falls vollständig und frisch."""
        out: dict[str, OddsQuote] = {}
        for selection_key, per_bm in self.quotes.items():
            quote = per_bm.get(bookmaker)
            if quote is None or quote.suspended or quote.price <= 1.0:
                return None
            if quote.age(reference) > max_age:
                return None
            out[selection_key] = quote
        return out or None

    def is_complete_book(self) -> bool:
        """Ergänzen sich die vorhandenen Selektionen zu 100 %?"""
        if self.market.type not in COMPLETE_BOOK_MARKETS:
            return False
        expected = EXPECTED_SELECTIONS.get(self.market.type)
        if expected is None:
            return False
        return len(self.quotes) == expected


# ---------------------------------------------------------------- Margin-Modelle


def remove_margin(
    probabilities: dict[str, float], method: str = "proportional"
) -> dict[str, float]:
    """Overround aus einem vollständigen Buch entfernen.

    ``proportional``: alle Wahrscheinlichkeiten werden durch den Overround
    geteilt (multiplikativ). Einfach, stabil, leichter Favourite-Longshot-Bias.

    ``equal_margin``: die Marge wird gleichmäßig subtrahiert (additiv). Für
    Außenseiter oft realistischer, kann bei sehr hohen Quoten aber negativ
    werden - dann wird auf ``proportional`` zurückgefallen.
    """
    total = sum(probabilities.values())
    if total <= 0:
        return dict(probabilities)
    if method == "equal_margin":
        n = len(probabilities)
        excess = (total - 1.0) / n
        adjusted = {k: v - excess for k, v in probabilities.items()}
        if all(v > 0.0005 for v in adjusted.values()):
            return adjusted
    return {k: v / total for k, v in probabilities.items()}


def overround(probabilities) -> float:
    return float(sum(probabilities))


# ------------------------------------------------------------------- Engine


class ValueEngine:
    """Berechnet faire Quoten, Value und Confidence für eine Selektion."""

    def __init__(self, config: EngineConfig | None = None) -> None:
        self.config = config or EngineConfig()

    # ------------------------------------------------------------ Modelle
    def _model_a(
        self, book: MarketBook, selection_key: str, exclude: str | None, reference: float
    ) -> tuple[float | None, int, float]:
        """Median-Modell. Rückgabe: (Wahrscheinlichkeit, n, Streuung)."""
        cfg = self.config
        quotes = book.usable(
            selection_key, exclude=exclude, reference=reference, max_age=cfg.max_quote_age
        )
        if not quotes:
            return None, 0, 0.0
        probs = [q.implied_probability for q in quotes]
        median_prob = statistics.median(probs)
        dispersion = statistics.pstdev(probs) if len(probs) > 1 else 0.0

        if book.is_complete_book():
            # Bei vollständigem Buch über alle Selektionen normalisieren -
            # damit fällt die Marge heraus.
            medians: dict[str, float] = {}
            for key in book.selection_keys:
                other = book.usable(
                    key, exclude=exclude, reference=reference, max_age=cfg.max_quote_age
                )
                if not other:
                    return median_prob, len(probs), dispersion
                medians[key] = statistics.median(q.implied_probability for q in other)
            total = sum(medians.values())
            if cfg.min_overround <= total <= cfg.max_overround:
                return medians[selection_key] / total, len(probs), dispersion
        return median_prob, len(probs), dispersion

    def _demargined_by_bookmaker(
        self, book: MarketBook, selection_key: str, exclude: str | None, reference: float
    ) -> tuple[dict[str, float], list[float]]:
        """Je Buchmacher margenbereinigte Wahrscheinlichkeit der Selektion."""
        cfg = self.config
        result: dict[str, float] = {}
        overrounds: list[float] = []
        if not book.is_complete_book():
            return result, overrounds
        for bookmaker in book.bookmakers():
            if bookmaker == exclude:
                continue
            full = book.bookmaker_book(bookmaker, reference=reference, max_age=cfg.max_quote_age)
            if not full or selection_key not in full:
                continue
            probs = {k: q.implied_probability for k, q in full.items()}
            book_overround = overround(probs.values())
            if not (cfg.min_overround <= book_overround <= cfg.max_overround):
                continue
            overrounds.append(book_overround)
            fair = remove_margin(probs, cfg.margin_method)
            result[bookmaker] = fair[selection_key]
        return result, overrounds

    def _model_b(self, demargined: dict[str, float]) -> float | None:
        if not demargined:
            return None
        return statistics.fmean(demargined.values())

    def _model_c(
        self,
        book: MarketBook,
        selection_key: str,
        demargined: dict[str, float],
        reference: float,
    ) -> float | None:
        """Gewichteter Konsens: Schärfe des Buchs, Aktualität, Liquidität."""
        if not demargined:
            return None
        cfg = self.config
        weighted_sum = 0.0
        weight_total = 0.0
        for bookmaker, prob in demargined.items():
            weight = BOOKMAKER_WEIGHTS.get(bookmaker, DEFAULT_BOOKMAKER_WEIGHT)
            quote = book.quotes.get(selection_key, {}).get(bookmaker)
            if quote is not None:
                # Aktualität: linear bis zum Alterslimit auf 50 % abfallend.
                age_factor = 1.0 - 0.5 * min(
                    1.0, quote.age(reference) / max(cfg.max_quote_age, 0.1)
                )
                weight *= max(0.25, age_factor)
                if quote.is_exchange:
                    weight *= 1.15
                if quote.liquidity is not None and quote.liquidity > 0:
                    # Liquidität dämpft über den Logarithmus (500 EUR -> ~1.2).
                    weight *= 1.0 + min(0.5, math.log10(1.0 + quote.liquidity) / 10.0)
            weighted_sum += weight * prob
            weight_total += weight
        if weight_total <= 0:
            return None
        return weighted_sum / weight_total

    # ---------------------------------------------------------- Confidence
    def _confidence(
        self,
        *,
        n_bookmakers: int,
        dispersion: float,
        fair_probability: float,
        model_spread: float,
        max_age: float,
        is_live: bool,
        complete_book: bool,
        overround_value: float | None,
    ) -> int:
        cfg = self.config
        score = 0.0

        # 1) Marktbreite (max. 32)
        score += min(32.0, 8.0 * math.log2(1.0 + n_bookmakers))

        # 2) Einigkeit der Bücher (max. 24) - relative Streuung
        if fair_probability > 0:
            rel_dispersion = dispersion / fair_probability
            score += max(0.0, 24.0 * (1.0 - min(1.0, rel_dispersion / 0.25)))

        # 3) Modell-Übereinstimmung (max. 18)
        score += max(0.0, 18.0 * (1.0 - min(1.0, model_spread / 0.20)))

        # 4) Aktualität (max. 16)
        score += max(0.0, 16.0 * (1.0 - min(1.0, max_age / max(cfg.max_quote_age, 0.1))))

        # 5) Datenqualität: vollständiges Buch + plausibler Overround (max. 10)
        if complete_book:
            score += 6.0
        if overround_value is not None and 1.0 <= overround_value <= 1.20:
            score += 4.0
        elif overround_value is not None and overround_value <= cfg.max_overround:
            score += 2.0

        if is_live:
            score -= cfg.live_confidence_penalty

        return int(max(0.0, min(100.0, round(score))))

    # ---------------------------------------------------------------- API
    def fair_odds(
        self,
        book: MarketBook,
        selection_key: str,
        *,
        exclude_bookmaker: str | None = None,
        reference: float | None = None,
        is_live: bool = False,
    ) -> FairOddsResult | None:
        """Faire Quote einer Selektion aus Sicht des restlichen Marktes.

        Gibt ``None`` zurück, wenn zu wenig verwertbare Daten vorliegen -
        die Engine rät nicht.
        """
        cfg = self.config
        ref = reference if reference is not None else now_ts()

        prob_a, n_a, dispersion = self._model_a(book, selection_key, exclude_bookmaker, ref)
        if prob_a is None or n_a == 0:
            return None

        demargined, overrounds = self._demargined_by_bookmaker(
            book, selection_key, exclude_bookmaker, ref
        )
        prob_b = self._model_b(demargined)
        prob_c = self._model_c(book, selection_key, demargined, ref)

        parts: list[tuple[float, float]] = [(prob_a, cfg.weight_model_a)]
        if prob_b is not None:
            parts.append((prob_b, cfg.weight_model_b))
        if prob_c is not None:
            parts.append((prob_c, cfg.weight_model_c))

        weight_total = sum(w for _, w in parts)
        fair_probability = sum(p * w for p, w in parts) / weight_total
        if fair_probability <= 0.0 or fair_probability >= 1.0:
            return None

        contributing = book.usable(
            selection_key, exclude=exclude_bookmaker, reference=ref, max_age=cfg.max_quote_age
        )
        max_age = max((q.age(ref) for q in contributing), default=0.0)
        n_bookmakers = len({q.bookmaker for q in contributing})

        model_probs = [p for p, _ in parts]
        model_spread = (max(model_probs) - min(model_probs)) if len(model_probs) > 1 else 0.0
        median_overround = statistics.median(overrounds) if overrounds else None

        notes: list[str] = []
        if prob_b is None:
            notes.append("Kein vollständiges Buch - Margin-Modell übersprungen")
        if n_bookmakers < cfg.min_bookmakers:
            notes.append(f"Nur {n_bookmakers} Referenz-Buchmacher")

        confidence = self._confidence(
            n_bookmakers=n_bookmakers,
            dispersion=dispersion,
            fair_probability=fair_probability,
            model_spread=model_spread,
            max_age=max_age,
            is_live=is_live,
            complete_book=book.is_complete_book(),
            overround_value=median_overround,
        )

        return FairOddsResult(
            fair_probability=fair_probability,
            fair_odds=1.0 / fair_probability,
            model_a_odds=(1.0 / prob_a) if prob_a else None,
            model_b_odds=(1.0 / prob_b) if prob_b else None,
            model_c_odds=(1.0 / prob_c) if prob_c else None,
            bookmaker_count=n_bookmakers,
            overround=median_overround,
            dispersion=dispersion,
            confidence=confidence,
            notes=notes,
        )


# ------------------------------------------------------------------ Formeln


def implied_probability(odds: float) -> float:
    return 1.0 / odds if odds > 0 else 0.0


def value_percent(odds: float, fair_probability: float) -> float:
    """Erwartungswert in Prozent: ``(odds * p_fair - 1) * 100``."""
    return (odds * fair_probability - 1.0) * 100.0


def deviation_percent(odds: float, fair_odds: float) -> float:
    """Abweichung der Buchmacherquote von der fairen Quote in Prozent."""
    if fair_odds <= 0:
        return 0.0
    return (odds / fair_odds - 1.0) * 100.0
