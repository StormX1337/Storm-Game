"""Fixed-Odds-Error-Detector.

Beispiel aus der Praxis::

    Markt:  2.40  2.45  2.50  2.42  2.48
    Bookie: 3.80

    Market Fair Odds: 2.45
    Bookie:           3.80
    Deviation:        +55.1 %

Ein hoher Ausreißer allein ist noch kein Fehlpreis. Der ``error_score``
(0-100) gewichtet deshalb acht Signale gegeneinander. Nur eine **positive**
Abweichung (Buchmacherquote höher als der Markt) ist spielbar - eine zu
niedrige Quote bekommt Score 0.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass(slots=True)
class OutlierConfig:
    min_deviation_percent: float = 15.0
    #: Ab dieser Abweichung ist die Größen-Komponente ausgereizt.
    saturation_deviation_percent: float = 60.0
    max_quote_age: float = 10.0
    #: Bewegung des Marktes, ab der die Geschwindigkeits-Komponente voll zählt.
    fast_move_percent_per_second: float = 4.0
    reference_bookmakers: int = 8


@dataclass(slots=True)
class OutlierResult:
    error_score: int
    deviation_percent: float
    components: dict[str, float] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)

    @property
    def is_outlier(self) -> bool:
        return self.error_score > 0


#: Maximalpunkte je Signal - die Summe ergibt 100.
WEIGHTS: dict[str, float] = {
    "deviation": 34.0,
    "breadth": 16.0,
    "speed": 12.0,
    "history": 8.0,
    "live": 8.0,
    "liquidity": 8.0,
    "quality": 10.0,
    "freshness": 4.0,
}


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def score_outlier(
    *,
    odds: float,
    fair_odds: float,
    bookmaker_count: int,
    confidence: int,
    quote_age: float,
    is_live: bool,
    config: OutlierConfig | None = None,
    speed_percent_per_second: float | None = None,
    previous_price: float | None = None,
    market_drift_percent: float | None = None,
    liquidity: float | None = None,
    exchange_references: int = 0,
) -> OutlierResult:
    """Bewertet, wie wahrscheinlich eine Quote ein echter Fehlpreis ist.

    :param market_drift_percent: Bewegung des restlichen Marktes seit der
        letzten Änderung dieses Buchmachers. Bewegt sich der Markt und das Buch
        bleibt stehen, ist das das klassische Muster einer vergessenen Quote.
    :param exchange_references: Anzahl Börsen-Quoten in der Referenz - Börsen
        sind der beste verfügbare Liquiditätsindikator.
    """
    cfg = config or OutlierConfig()
    components: dict[str, float] = {}
    reasons: list[str] = []

    if odds <= 1.0 or fair_odds <= 1.0:
        return OutlierResult(error_score=0, deviation_percent=0.0, reasons=["Ungültige Quote"])

    deviation = (odds / fair_odds - 1.0) * 100.0
    # Epsilon: eine Quote *genau* auf der Schwelle darf nicht an
    # Fließkomma-Rauschen scheitern (2.45 * 1.15 / 2.45 - 1 = 0.14999999...).
    if deviation < cfg.min_deviation_percent - 1e-9:
        return OutlierResult(
            error_score=0,
            deviation_percent=deviation,
            reasons=[
                f"Abweichung {deviation:.1f}% unter Schwelle {cfg.min_deviation_percent:.1f}%"
            ],
        )

    # 1) Größe der Abweichung ------------------------------------------------
    span = max(1e-6, cfg.saturation_deviation_percent - cfg.min_deviation_percent)
    dev_ratio = _clamp((deviation - cfg.min_deviation_percent) / span)
    # Wurzel: die ersten Prozentpunkte über der Schwelle zählen am meisten.
    components["deviation"] = (
        WEIGHTS["deviation"] * math.sqrt(dev_ratio) * 0.75 + WEIGHTS["deviation"] * 0.25 * dev_ratio
    )

    # 2) Marktbreite ---------------------------------------------------------
    breadth = _clamp(math.log2(1 + bookmaker_count) / math.log2(1 + cfg.reference_bookmakers))
    components["breadth"] = WEIGHTS["breadth"] * breadth
    if bookmaker_count < 3:
        reasons.append("Dünne Referenz (< 3 Buchmacher)")

    # 3) Geschwindigkeit -----------------------------------------------------
    speed_signal = 0.0
    if market_drift_percent is not None and abs(market_drift_percent) >= 1.0:
        # Markt bewegt sich, dieser Buchmacher hängt hinterher -> starkes Signal.
        speed_signal = _clamp(abs(market_drift_percent) / 10.0)
        reasons.append(f"Markt bewegte sich {market_drift_percent:+.1f}%, Buch blieb stehen")
    elif speed_percent_per_second is not None:
        speed_signal = _clamp(speed_percent_per_second / cfg.fast_move_percent_per_second)
    else:
        speed_signal = 0.35  # neutral, wenn keine Bewegungsdaten vorliegen
    components["speed"] = WEIGHTS["speed"] * speed_signal

    # 4) Historie ------------------------------------------------------------
    if previous_price is None:
        components["history"] = WEIGHTS["history"] * 0.4
    else:
        jump = abs(odds / previous_price - 1.0) * 100.0 if previous_price > 0 else 0.0
        if jump >= 10.0:
            # Plötzlicher Sprung des Buchs selbst - typisch für Tippfehler.
            components["history"] = WEIGHTS["history"]
            reasons.append(f"Sprung gegenüber eigener Vorquote {previous_price:.2f} ({jump:+.1f}%)")
        else:
            components["history"] = WEIGHTS["history"] * _clamp(jump / 10.0, 0.3, 1.0)

    # 5) Live / Pre-Match ----------------------------------------------------
    if is_live:
        # Live sind Fehlpreise häufiger echt, verschwinden aber schneller:
        # nur frische Live-Quoten bekommen die volle Punktzahl.
        freshness = _clamp(1.0 - quote_age / max(cfg.max_quote_age, 0.1))
        components["live"] = WEIGHTS["live"] * (0.5 + 0.5 * freshness)
    else:
        components["live"] = WEIGHTS["live"] * 0.55

    # 6) Liquidität / Marktbreite -------------------------------------------
    if liquidity is not None and liquidity > 0:
        components["liquidity"] = WEIGHTS["liquidity"] * _clamp(math.log10(1 + liquidity) / 4.0)
    elif exchange_references > 0:
        components["liquidity"] = WEIGHTS["liquidity"] * _clamp(0.5 + 0.25 * exchange_references)
    else:
        # Keine Liquiditätsdaten: neutral bewerten statt zu raten.
        components["liquidity"] = WEIGHTS["liquidity"] * 0.5
        reasons.append("Keine Liquiditätsdaten verfügbar")

    # 7) Datenqualität -------------------------------------------------------
    components["quality"] = WEIGHTS["quality"] * _clamp(confidence / 100.0)

    # 8) Alter der Quote -----------------------------------------------------
    components["freshness"] = WEIGHTS["freshness"] * _clamp(
        1.0 - quote_age / max(cfg.max_quote_age, 0.1)
    )
    if quote_age > cfg.max_quote_age:
        reasons.append(f"Quote {quote_age:.1f}s alt")

    total = sum(components.values())
    return OutlierResult(
        error_score=int(max(0.0, min(100.0, round(total)))),
        deviation_percent=deviation,
        components={k: round(v, 2) for k, v in components.items()},
        reasons=reasons,
    )
