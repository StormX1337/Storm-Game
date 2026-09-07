"""False-Positive-Schutz.

Ein Scanner, der jede Zuckung meldet, ist wertlos. Vor jedem Alarm laufen
deshalb drei Stufen:

1. **Quotenprüfung** (ohne I/O): Alter, Suspendierung, Quotenband, Sportart,
   Live/Pre-Match.
2. **Signalprüfung** (ohne I/O): Value, Abweichung, Buchmacheranzahl,
   Confidence, Error-Score.
3. **Zustandsprüfung** (Redis): Cooldown je Quotenzeile und Duplikaterkennung
   über einen Preis-Bucket.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Protocol

from backend.models.domain import Alert, EventSnapshot, OddsQuote, now_ts
from backend.models.enums import EventStatus, MarketType, Sport


@dataclass(slots=True)
class FilterThresholds:
    """Alle Schwellen an einem Ort - je Nutzer überschreibbar."""

    min_value_percent: float = 10.0
    min_outlier_percent: float = 15.0
    min_bookmakers: int = 3
    min_odds: float = 1.50
    max_odds: float = 51.0
    max_odds_age_seconds: float = 10.0
    alert_cooldown_seconds: int = 60
    min_confidence: int = 60
    min_error_score: int = 60
    scan_live: bool = True
    scan_prematch: bool = True
    sports: frozenset[Sport] = field(default_factory=lambda: frozenset(Sport))
    markets: frozenset[MarketType] | None = None
    #: Preisänderung in Prozent, ab der ein Duplikat erneut gemeldet werden darf.
    duplicate_price_tolerance: float = 2.0

    def with_overrides(self, **kwargs) -> FilterThresholds:
        data = {
            "min_value_percent": self.min_value_percent,
            "min_outlier_percent": self.min_outlier_percent,
            "min_bookmakers": self.min_bookmakers,
            "min_odds": self.min_odds,
            "max_odds": self.max_odds,
            "max_odds_age_seconds": self.max_odds_age_seconds,
            "alert_cooldown_seconds": self.alert_cooldown_seconds,
            "min_confidence": self.min_confidence,
            "min_error_score": self.min_error_score,
            "scan_live": self.scan_live,
            "scan_prematch": self.scan_prematch,
            "sports": self.sports,
            "markets": self.markets,
            "duplicate_price_tolerance": self.duplicate_price_tolerance,
        }
        data.update({k: v for k, v in kwargs.items() if v is not None})
        return FilterThresholds(**data)


@dataclass(slots=True)
class FilterDecision:
    """Ergebnis einer Filterstufe.

    ``code`` ist stabil und zum Zählen gedacht, ``reason`` enthält zusätzlich
    die konkreten Messwerte für Log und Anzeige. Die Trennung ist notwendig:
    ein Grund wie ``stale_45.0s`` als Metrik-Label würde für jede vorkommende
    Alterszahl eine eigene Zeitreihe anlegen.
    """

    passed: bool
    code: str = ""
    reason: str = ""

    def __bool__(self) -> bool:  # pragma: no cover - Komfort
        return self.passed


PASS = FilterDecision(True)

#: Alle Unterdrückungsgründe mit ihrer Bedeutung. Das Dashboard zeigt daraus
#: die Klartexte, damit "warum kommt nichts an?" beantwortbar wird.
SUPPRESSION_LABELS: dict[str, str] = {
    "suspended": "Quote ausgesetzt",
    "event_suspended": "Event ausgesetzt",
    "event_finished": "Event beendet",
    "sport_disabled": "Sportart abgeschaltet",
    "live_disabled": "Live abgeschaltet",
    "prematch_disabled": "Pre-Match abgeschaltet",
    "market_disabled": "Markt nicht ausgewählt",
    "odds_below_min": "Quote unter MIN_ODDS",
    "odds_above_max": "Quote über MAX_ODDS",
    "stale": "Quote älter als MAX_ODDS_AGE_SECONDS",
    "too_few_bookmakers": "weniger Buchmacher als MIN_BOOKMAKERS",
    "value_below_min": "Value unter MIN_VALUE_PERCENT",
    "deviation_below_min": "Abweichung unter MIN_OUTLIER_PERCENT",
    "confidence_below_min": "Confidence unter MIN_CONFIDENCE",
    "error_score_below_min": "Error-Score unter MIN_ERROR_SCORE",
    "duplicate": "Duplikat (gleicher Preis)",
    "cooldown": "Cooldown läuft noch",
    "no_fair_odds": "zu wenig Daten für eine faire Quote",
    "extreme_probability": "Markt praktisch entschieden",
    "market_drift": "ganzer Markt in Bewegung",
    "market_leader": "Buch führt die Bewegung an",
    "unknown_event": "Event nicht zuzuordnen",
    "queue_full": "Rückstau - Nachricht verworfen",
}

#: Schwellenvergleiche mit Fließkommazahlen: ein Wert exakt auf der Grenze
#: soll bestehen, nicht an Rundungsrauschen scheitern.
EPS = 1e-9


def _fail(code: str, reason: str = "") -> FilterDecision:
    return FilterDecision(False, code, reason or code)


# --------------------------------------------------------------- Stufe 1


def check_quote(
    quote: OddsQuote,
    event: EventSnapshot,
    thresholds: FilterThresholds,
    *,
    reference: float | None = None,
) -> FilterDecision:
    """Ist diese Quote überhaupt auswertbar?"""
    ref = reference if reference is not None else now_ts()

    if quote.suspended:
        return _fail("suspended")
    if event.status is EventStatus.SUSPENDED:
        return _fail("event_suspended")
    if event.status is EventStatus.FINISHED:
        return _fail("event_finished")
    if event.sport not in thresholds.sports:
        return _fail("sport_disabled")
    if event.status is EventStatus.LIVE and not thresholds.scan_live:
        return _fail("live_disabled")
    if event.status is not EventStatus.LIVE and not thresholds.scan_prematch:
        return _fail("prematch_disabled")
    if thresholds.markets is not None and quote.market.type not in thresholds.markets:
        return _fail("market_disabled")
    if quote.price < thresholds.min_odds - EPS:
        return _fail("odds_below_min")
    if quote.price > thresholds.max_odds + EPS:
        return _fail("odds_above_max")

    age = quote.age(ref)
    if age > thresholds.max_odds_age_seconds + EPS:
        return _fail("stale", f"Quote {age:.1f}s alt")
    return PASS


def is_stale(quote: OddsQuote, max_age: float, reference: float | None = None) -> bool:
    return quote.age(reference if reference is not None else now_ts()) > max_age


# --------------------------------------------------------------- Stufe 2


def check_signal(
    *,
    value_percent: float,
    deviation_percent: float,
    bookmaker_count: int,
    confidence: int,
    error_score: int,
    thresholds: FilterThresholds,
) -> FilterDecision:
    """Ist das Signal stark genug für einen Alarm?"""
    if bookmaker_count < thresholds.min_bookmakers:
        return _fail("too_few_bookmakers", f"nur {bookmaker_count} Buchmacher")
    if value_percent < thresholds.min_value_percent - EPS:
        return _fail("value_below_min", f"Value {value_percent:.1f}%")
    if deviation_percent < thresholds.min_outlier_percent - EPS:
        return _fail("deviation_below_min", f"Abweichung {deviation_percent:.1f}%")
    if confidence < thresholds.min_confidence:
        return _fail("confidence_below_min", f"Confidence {confidence}")
    if error_score < thresholds.min_error_score:
        return _fail("error_score_below_min", f"Error-Score {error_score}")
    return PASS


def check_value_signal(
    *,
    value_percent: float,
    bookmaker_count: int,
    confidence: int,
    thresholds: FilterThresholds,
) -> FilterDecision:
    """Value-Alarm: positiver Erwartungswert bei ausreichender Datenlage."""
    if bookmaker_count < thresholds.min_bookmakers:
        return _fail("too_few_bookmakers", f"nur {bookmaker_count} Buchmacher")
    if value_percent < thresholds.min_value_percent - EPS:
        return _fail("value_below_min", f"Value {value_percent:.1f}%")
    if confidence < thresholds.min_confidence:
        return _fail("confidence_below_min", f"Confidence {confidence}")
    return PASS


def check_error_signal(
    *,
    deviation_percent: float,
    bookmaker_count: int,
    error_score: int,
    confidence: int,
    thresholds: FilterThresholds,
) -> FilterDecision:
    """Fixed-Odds-Error: starke Abweichung mit hohem Error-Score.

    Die Confidence zählt hier genauso wie beim Value-Alarm: traut die Engine
    ihrer eigenen fairen Quote nicht, ist auch die daraus abgeleitete
    "Abweichung" keine belastbare Aussage.
    """
    if bookmaker_count < thresholds.min_bookmakers:
        return _fail("too_few_bookmakers", f"nur {bookmaker_count} Buchmacher")
    if deviation_percent < thresholds.min_outlier_percent - EPS:
        return _fail("deviation_below_min", f"Abweichung {deviation_percent:.1f}%")
    if confidence < thresholds.min_confidence:
        return _fail("confidence_below_min", f"Confidence {confidence}")
    if error_score < thresholds.min_error_score:
        return _fail("error_score_below_min", f"Error-Score {error_score}")
    return PASS


# --------------------------------------------------------------- Stufe 3


class CooldownStore(Protocol):
    """Minimale Schnittstelle - Redis in Produktion, Dict in Tests."""

    async def claim(self, key: str, ttl_seconds: int) -> bool:
        """``True``, wenn der Schlüssel neu belegt wurde (SET NX)."""
        ...


class InMemoryCooldownStore:
    """Nur für Tests und den Single-Process-Betrieb."""

    def __init__(self) -> None:
        self._entries: dict[str, float] = {}

    async def claim(self, key: str, ttl_seconds: int) -> bool:
        now = now_ts()
        expiry = self._entries.get(key)
        if expiry is not None and expiry > now:
            return False
        self._entries[key] = now + ttl_seconds
        return True

    def clear(self) -> None:
        self._entries.clear()


def cooldown_key(alert: Alert) -> str:
    """Ein Cooldown je Quotenzeile und Buchmacher."""
    return (
        f"cd:{alert.kind.value}:{alert.event.event_id}:{alert.market.key}:"
        f"{alert.selection.key}:{alert.bookmaker}"
    )


def duplicate_key(alert: Alert, tolerance_percent: float = 2.0) -> str:
    """Duplikat-Schlüssel inkl. Preis-Bucket.

    Derselbe Alarm mit praktisch gleichem Preis ist ein Duplikat. Bewegt sich
    der Preis um mehr als ``tolerance_percent``, ist es ein neues Signal.
    """
    bucket = 0
    if tolerance_percent > 0 and alert.odds > 0:
        import math

        bucket = int(math.log(alert.odds) / math.log(1.0 + tolerance_percent / 100.0))
    raw = (
        f"{alert.kind.value}|{alert.event.event_id}|{alert.market.key}|"
        f"{alert.selection.key}|{alert.bookmaker}|{bucket}"
    )
    digest = hashlib.sha1(raw.encode()).hexdigest()[:20]  # noqa: S324 - nur Dedup
    return f"dup:{digest}"


def fingerprint(alert: Alert) -> str:
    raw = (
        f"{alert.kind.value}|{alert.event.event_id}|{alert.market.key}|"
        f"{alert.selection.key}|{alert.bookmaker}|{alert.odds:.3f}"
    )
    return hashlib.sha1(raw.encode()).hexdigest()[:24]  # noqa: S324 - nur ID


class AlertGate:
    """Stufe 3: Cooldown + Duplikaterkennung."""

    def __init__(self, store: CooldownStore, thresholds: FilterThresholds) -> None:
        self.store = store
        self.thresholds = thresholds

    async def allow(self, alert: Alert) -> FilterDecision:
        dup = duplicate_key(alert, self.thresholds.duplicate_price_tolerance)
        if not await self.store.claim(dup, max(self.thresholds.alert_cooldown_seconds, 1)):
            return _fail("duplicate")
        if not await self.store.claim(cooldown_key(alert), self.thresholds.alert_cooldown_seconds):
            return _fail("cooldown")
        return PASS
