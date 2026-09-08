"""Domänenmodelle des Scanners.

Bewusst ``dataclass(slots=True)`` statt Pydantic: diese Objekte werden im
Hot-Path zehntausendfach pro Minute erzeugt. Pydantic-Modelle gibt es nur an
der API-Grenze (``backend/models/schemas.py``).

Wichtig: Felder, die ein Provider nicht liefert, bleiben ``None``. Es werden
niemals Werte geraten oder erfunden.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from backend.models.enums import (
    MARKET_LABELS,
    AlertKind,
    EventStatus,
    MarketType,
    Period,
    SelectionCode,
    Sport,
)


def now_ts() -> float:
    """Monoton genug für Altersberechnungen und trotzdem als Wanduhrzeit lesbar."""
    return time.time()


def to_utc(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, tz=UTC)


def format_line(line: float | None) -> str:
    if line is None:
        return ""
    if float(line).is_integer():
        return str(int(line))
    return f"{line:g}"


# --------------------------------------------------------------------- Markt


@dataclass(frozen=True, slots=True)
class MarketKey:
    """Eindeutiger Marktschlüssel: Art + Linie + Abschnitt."""

    type: MarketType
    line: float | None = None
    period: Period = Period.FULL_TIME

    @property
    def key(self) -> str:
        return f"{self.type.value}|{format_line(self.line)}|{self.period.value}"

    @property
    def label(self) -> str:
        base = MARKET_LABELS.get(self.type, self.type.value)
        if self.line is not None:
            base = f"{base} {format_line(self.line)}"
        if self.period not in (Period.FULL_TIME, Period.MATCH):
            base = f"{base} ({self.period.value.replace('_', ' ')})"
        return base

    @classmethod
    def parse(cls, key: str) -> MarketKey:
        raw_type, raw_line, raw_period = key.split("|", 2)
        return cls(
            type=MarketType(raw_type),
            line=float(raw_line) if raw_line else None,
            period=Period(raw_period),
        )

    def __str__(self) -> str:  # pragma: no cover - Komfort
        return self.label


@dataclass(frozen=True, slots=True)
class Selection:
    """Normalisierte Selektion inklusive Anzeige-Label."""

    code: SelectionCode
    label: str = ""
    raw: str = ""

    @property
    def key(self) -> str:
        if self.code is SelectionCode.OTHER:
            token = (self.raw or self.label or "unknown").strip().lower().replace(" ", "_")
            return f"other:{token}"
        return self.code.value

    @property
    def display(self) -> str:
        return self.label or self.raw or self.code.value

    @classmethod
    def parse(cls, key: str, label: str = "") -> Selection:
        if key.startswith("other:"):
            return cls(code=SelectionCode.OTHER, label=label, raw=key[6:])
        return cls(code=SelectionCode(key), label=label)


# ------------------------------------------------------------------- Zustand


@dataclass(slots=True)
class Score:
    home: int | None = None
    away: int | None = None

    def as_text(self) -> str | None:
        if self.home is None or self.away is None:
            return None
        return f"{self.home}:{self.away}"


@dataclass(slots=True)
class FootballState:
    """Live-Details Fußball. Nicht gelieferte Felder bleiben ``None``."""

    minute: int | None = None
    period: str | None = None
    home_red_cards: int | None = None
    away_red_cards: int | None = None
    stoppage_time: int | None = None


@dataclass(slots=True)
class TennisState:
    """Live-Details Tennis. Nicht gelieferte Felder bleiben ``None``."""

    set_number: int | None = None
    sets_home: int | None = None
    sets_away: int | None = None
    games_home: int | None = None
    games_away: int | None = None
    points_home: str | None = None
    points_away: str | None = None
    server: str | None = None  # "home" | "away"

    def games_text(self) -> str | None:
        if self.games_home is None or self.games_away is None:
            return None
        return f"{self.games_home}-{self.games_away}"

    def points_text(self) -> str | None:
        if self.points_home is None or self.points_away is None:
            return None
        return f"{self.points_home}-{self.points_away}"


# --------------------------------------------------------------------- Event


@dataclass(slots=True)
class EventSnapshot:
    """Ein Event zu einem Zeitpunkt, so wie ein Provider es geliefert hat."""

    event_id: str
    sport: Sport
    home: str
    away: str
    provider: str
    provider_event_id: str
    league: str | None = None
    start_time: datetime | None = None
    status: EventStatus = EventStatus.UNKNOWN
    score: Score | None = None
    football: FootballState | None = None
    tennis: TennisState | None = None
    updated_at: float = field(default_factory=now_ts)

    @property
    def is_live(self) -> bool:
        return self.status is EventStatus.LIVE

    @property
    def title(self) -> str:
        return f"{self.home} vs {self.away}"

    def state_key(self) -> str:
        """Kurzfassung der Spielsituation.

        Ändert sie sich, hat sich die *wahre* Wahrscheinlichkeit geändert -
        nach einem Tor ist die Quote von vorher keine gültige Vergleichsgröße
        mehr. Die Nachkontrolle erkennt daran, wann sie nichts messen darf.
        """
        parts: list[str] = [self.status.value]
        if self.score is not None:
            parts.append(f"{self.score.home}:{self.score.away}")
        if self.tennis is not None:
            parts.append(
                f"s{self.tennis.sets_home}-{self.tennis.sets_away}"
                f"g{self.tennis.games_home}-{self.tennis.games_away}"
            )
        return "|".join(parts)

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        data["sport"] = self.sport.value
        data["status"] = self.status.value
        data["start_time"] = self.start_time.isoformat() if self.start_time else None
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> EventSnapshot:
        start = data.get("start_time")
        return cls(
            event_id=data["event_id"],
            sport=Sport(data["sport"]),
            home=data["home"],
            away=data["away"],
            provider=data["provider"],
            provider_event_id=data["provider_event_id"],
            league=data.get("league"),
            start_time=datetime.fromisoformat(start) if start else None,
            status=EventStatus(data.get("status", "UNKNOWN")),
            score=Score(**data["score"]) if data.get("score") else None,
            football=FootballState(**data["football"]) if data.get("football") else None,
            tennis=TennisState(**data["tennis"]) if data.get("tennis") else None,
            updated_at=data.get("updated_at", now_ts()),
        )


# --------------------------------------------------------------------- Quote


@dataclass(slots=True)
class OddsQuote:
    """Eine einzelne Quote eines Buchmachers.

    Drei Zeitstempel mit verschiedener Bedeutung:

    * ``ts`` - seit wann *dieser Preis* gilt (Standzeit des Preises).
    * ``confirmed_at`` - wann wir den Preis zuletzt gesehen haben
      (Datenaktualität; darauf beziehen sich alle Stale-Filter).
    * ``received_at`` - Eingang dieser konkreten Nachricht.

    Die Trennung ist wesentlich: ein *vergessener* Fehlpreis ändert sich
    definitionsgemäß nicht. Würde man ihn über ``ts`` altern lassen, fiele
    genau der interessanteste Fall aus dem Stale-Filter heraus.
    """

    event_id: str
    market: MarketKey
    selection: Selection
    bookmaker: str
    price: float
    provider: str
    ts: float = field(default_factory=now_ts)
    received_at: float = field(default_factory=now_ts)
    confirmed_at: float = field(default_factory=now_ts)
    suspended: bool = False
    liquidity: float | None = None
    is_exchange: bool = False

    @property
    def key(self) -> str:
        return f"{self.event_id}|{self.market.key}|{self.selection.key}|{self.bookmaker}"

    @property
    def line_key(self) -> str:
        """Schlüssel der Quotenzeile (alle Buchmacher zu einer Selektion)."""
        return f"{self.event_id}|{self.market.key}|{self.selection.key}"

    def age(self, reference: float | None = None) -> float:
        """Alter der *Daten*: wie lange ist die letzte Bestätigung her?"""
        return max(0.0, (reference if reference is not None else now_ts()) - self.confirmed_at)

    def price_age(self, reference: float | None = None) -> float:
        """Standzeit des *Preises*: wie lange steht diese Quote schon?"""
        return max(0.0, (reference if reference is not None else now_ts()) - self.ts)

    @property
    def implied_probability(self) -> float:
        return 1.0 / self.price if self.price > 0 else 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "market": self.market.key,
            "market_label": self.market.label,
            "selection": self.selection.key,
            "selection_label": self.selection.display,
            "bookmaker": self.bookmaker,
            "price": self.price,
            "provider": self.provider,
            "ts": self.ts,
            "received_at": self.received_at,
            "confirmed_at": self.confirmed_at,
            "suspended": self.suspended,
            "liquidity": self.liquidity,
            "is_exchange": self.is_exchange,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> OddsQuote:
        return cls(
            event_id=data["event_id"],
            market=MarketKey.parse(data["market"]),
            selection=Selection.parse(data["selection"], data.get("selection_label", "")),
            bookmaker=data["bookmaker"],
            price=float(data["price"]),
            provider=data["provider"],
            ts=float(data["ts"]),
            received_at=float(data.get("received_at", data["ts"])),
            confirmed_at=float(data.get("confirmed_at", data.get("received_at", data["ts"]))),
            suspended=bool(data.get("suspended", False)),
            liquidity=data.get("liquidity"),
            is_exchange=bool(data.get("is_exchange", False)),
        )


@dataclass(slots=True)
class OddsChange:
    """Inkrementelle Preisänderung - Basis für Bewegungs-Metriken."""

    quote: OddsQuote
    previous_price: float | None
    previous_ts: float | None

    @property
    def delta(self) -> float | None:
        if self.previous_price is None:
            return None
        return self.quote.price - self.previous_price

    @property
    def delta_percent(self) -> float | None:
        if not self.previous_price:
            return None
        return (self.quote.price / self.previous_price - 1.0) * 100.0

    @property
    def elapsed(self) -> float | None:
        if self.previous_ts is None:
            return None
        return max(0.0, self.quote.ts - self.previous_ts)

    @property
    def speed_percent_per_second(self) -> float | None:
        """Bewegungsgeschwindigkeit in %/s - Eingangsgröße des Error-Scores."""
        d = self.delta_percent
        e = self.elapsed
        if d is None or e is None:
            return None
        return abs(d) / max(e, 0.05)


# ---------------------------------------------------------------- Nachrichten


@dataclass(slots=True)
class ProviderMessage:
    """Alles, was ein Provider in die Pipeline schiebt."""

    provider: str
    events: list[EventSnapshot] = field(default_factory=list)
    quotes: list[OddsQuote] = field(default_factory=list)
    heartbeat: bool = False
    received_at: float = field(default_factory=now_ts)

    @property
    def is_empty(self) -> bool:
        return not self.events and not self.quotes and not self.heartbeat


# ---------------------------------------------------------------------- Alert


@dataclass(slots=True)
class FairOddsResult:
    """Ergebnis der Value Engine für eine Selektion."""

    fair_probability: float
    fair_odds: float
    model_a_odds: float | None
    model_b_odds: float | None
    model_c_odds: float | None
    bookmaker_count: int
    overround: float | None
    dispersion: float
    confidence: int
    notes: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class Alert:
    """Ein fertiger, versandbereiter Alarm."""

    kind: AlertKind
    event: EventSnapshot
    market: MarketKey
    selection: Selection
    bookmaker: str
    odds: float
    fair_odds: float
    value_percent: float
    deviation_percent: float
    confidence: int
    error_score: int
    bookmaker_count: int
    detected_at: float = field(default_factory=now_ts)
    fingerprint: str = ""
    provider: str = ""
    odds_age: float = 0.0
    speed_percent_per_second: float | None = None
    previous_odds: float | None = None
    notes: list[str] = field(default_factory=list)
    #: Ergebnis der drei Fair-Odds-Modelle - macht die Referenz nachprüfbar.
    fair_models: dict[str, float | None] = field(default_factory=dict)
    #: Punkte je Signal des Error-Scores.
    score_components: dict[str, float] = field(default_factory=dict)
    #: Die verglichenen Quoten: Buchmacher -> Preis. Damit lässt sich der
    #: Alarm ohne Blick in die Datenbank überprüfen.
    references: dict[str, float] = field(default_factory=dict)

    @property
    def detected_at_text(self) -> str:
        return datetime.fromtimestamp(self.detected_at).strftime("%H:%M:%S.%f")[:-3]

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "event": self.event.to_json(),
            "market": self.market.key,
            "market_label": self.market.label,
            "selection": self.selection.key,
            "selection_label": self.selection.display,
            "bookmaker": self.bookmaker,
            "odds": self.odds,
            "fair_odds": self.fair_odds,
            "value_percent": self.value_percent,
            "deviation_percent": self.deviation_percent,
            "confidence": self.confidence,
            "error_score": self.error_score,
            "bookmaker_count": self.bookmaker_count,
            "detected_at": self.detected_at,
            "fingerprint": self.fingerprint,
            "provider": self.provider,
            "odds_age": self.odds_age,
            "speed_percent_per_second": self.speed_percent_per_second,
            "previous_odds": self.previous_odds,
            "notes": list(self.notes),
            "fair_models": dict(self.fair_models),
            "score_components": dict(self.score_components),
            "references": dict(self.references),
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Alert:
        return cls(
            kind=AlertKind(data["kind"]),
            event=EventSnapshot.from_json(data["event"]),
            market=MarketKey.parse(data["market"]),
            selection=Selection.parse(data["selection"], data.get("selection_label", "")),
            bookmaker=data["bookmaker"],
            odds=float(data["odds"]),
            fair_odds=float(data["fair_odds"]),
            value_percent=float(data["value_percent"]),
            deviation_percent=float(data["deviation_percent"]),
            confidence=int(data["confidence"]),
            error_score=int(data["error_score"]),
            bookmaker_count=int(data["bookmaker_count"]),
            detected_at=float(data["detected_at"]),
            fingerprint=data.get("fingerprint", ""),
            provider=data.get("provider", ""),
            odds_age=float(data.get("odds_age", 0.0)),
            speed_percent_per_second=data.get("speed_percent_per_second"),
            previous_odds=data.get("previous_odds"),
            notes=list(data.get("notes", [])),
            fair_models=dict(data.get("fair_models") or {}),
            score_components=dict(data.get("score_components") or {}),
            references=dict(data.get("references") or {}),
        )
