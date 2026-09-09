"""Pydantic-Schemata der HTTP-Schnittstelle.

Nur hier - im Hot-Path des Scanners kommen Dataclasses zum Einsatz.
Diese Modelle erzeugen gleichzeitig die OpenAPI-Dokumentation.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class HealthComponent(BaseModel):
    name: str
    healthy: bool
    detail: str = ""


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"] = "ok"
    version: str
    environment: str
    uptime_seconds: float
    components: list[HealthComponent]


class ProviderHealthResponse(BaseModel):
    key: str
    title: str
    kind: str
    status: str = "unknown"
    healthy: bool = False
    requires_credentials: bool = False
    missing_credentials: list[str] = Field(default_factory=list)
    docs_url: str = ""
    notes: str = ""
    connected_since: datetime | None = None
    last_message_at: datetime | None = None
    seconds_since_message: float | None = None
    messages: int = 0
    quotes: int = 0
    errors: int = 0
    reconnects: int = 0
    rate_limit_remaining: int | None = None
    latency_ms: float | None = None
    detail: str = ""


class ScoreModel(BaseModel):
    home: int | None = None
    away: int | None = None


class FootballStateModel(BaseModel):
    minute: int | None = None
    period: str | None = None
    home_red_cards: int | None = None
    away_red_cards: int | None = None
    stoppage_time: int | None = None


class TennisStateModel(BaseModel):
    set_number: int | None = None
    sets_home: int | None = None
    sets_away: int | None = None
    games_home: int | None = None
    games_away: int | None = None
    points_home: str | None = None
    points_away: str | None = None
    server: str | None = None


class EventResponse(BaseModel):
    event_id: str
    sport: str
    league: str | None = None
    home: str
    away: str
    start_time: datetime | None = None
    status: str
    score: ScoreModel | None = None
    football: FootballStateModel | None = None
    tennis: TennisStateModel | None = None
    provider: str = ""
    updated_at: float | None = None


class OddsResponse(BaseModel):
    event_id: str
    market: str
    market_label: str
    selection: str
    selection_label: str
    bookmaker: str
    price: float
    ts: float
    age_seconds: float
    suspended: bool = False
    liquidity: float | None = None
    is_exchange: bool = False


class RecommendationModel(BaseModel):
    """Die Handlungsempfehlung zu einem Alarm.

    ``credible_edge_percent`` ist die Zahl, auf die es ankommt - der Vorteil,
    der nach Abzug von Unsicherheit und Unplausibilität übrig bleibt. Sie ist
    absichtlich kleiner als ``value_percent`` und wächst nicht mit ihm: eine
    extrem hohe gemeldete Abweichung ist ein Hinweis auf einen Datenfehler,
    kein Grund für einen höheren Einsatz.
    """

    grade: str
    label: str
    reason_code: str = "ok"
    reason_label: str = ""
    credible_edge_percent: float = 0.0
    raw_edge_percent: float = 0.0
    #: Vorschlag in Prozent der Bankroll (fraktionaler Kelly, gedeckelt).
    stake_percent: float = 0.0
    #: Betrag - nur wenn eine Bankroll hinterlegt ist, sonst ``null``.
    stake_amount: float | None = None
    reliability: float = 0.0
    plausibility: float = 0.0
    rank_score: float = 0.0
    reasons: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    checklist: list[str] = Field(default_factory=list)
    play: str = ""


class AlertResponse(BaseModel):
    id: int | None = None
    kind: str
    sport: str
    event_id: str
    event_title: str
    league: str | None = None
    status: str
    score: str | None = None
    market: str
    market_label: str
    selection: str
    selection_label: str
    bookmaker: str
    odds: float
    fair_odds: float
    value_percent: float
    deviation_percent: float
    confidence: int
    error_score: int
    bookmaker_count: int
    detected_at: datetime
    provider: str = ""
    previous_odds: float | None = None
    notes: list[str] = Field(default_factory=list)
    #: Herleitung: Modelle, Signalpunkte und die verglichenen Preise.
    fair_models: dict[str, float | None] = Field(default_factory=dict)
    score_components: dict[str, float] = Field(default_factory=dict)
    references: dict[str, float] = Field(default_factory=dict)
    # ------------------------------------------------- Nachkontrolle
    #: ``None`` = noch nicht nachkontrolliert.
    verdict: str | None = None
    verdict_label: str | None = None
    clv_percent: float | None = None
    closing_odds: float | None = None
    closing_fair_odds: float | None = None
    resolved_at: datetime | None = None
    # -------------------------------------------------- Empfehlung
    #: ``None`` = vor Einführung der Empfehlung entstanden.
    recommendation: RecommendationModel | None = None


class VerdictCount(BaseModel):
    """Wie oft ein Urteil vorkam."""

    verdict: str
    label: str
    count: int


class BookmakerScore(BaseModel):
    bookmaker: str
    alerts: int
    avg_clv_percent: float | None = None


class ScorecardResponse(BaseModel):
    """Trefferbilanz: was aus den Alarmen geworden ist.

    ``avg_clv_percent`` ist kein Gewinn, sondern der Abstand des gemeldeten
    Preises zum später beobachteten Marktkonsens.
    """

    window_hours: int
    resolved: int
    pending: int
    scored: int
    avg_clv_percent: float | None = None
    beat_close: int = 0
    beat_close_share: float | None = None
    verdicts: list[VerdictCount] = Field(default_factory=list)
    by_kind: dict[str, dict[str, Any]] = Field(default_factory=dict)
    by_bookmaker: list[BookmakerScore] = Field(default_factory=list)


class SuppressionReason(BaseModel):
    """Ein Grund, aus dem Alarme verworfen wurden."""

    code: str
    label: str
    count: int


class RecommendationPick(BaseModel):
    """Ein Vorschlag der Bestenliste: der Alarm und was daraus folgt."""

    alert: AlertResponse
    recommendation: RecommendationModel


class RecommendationsResponse(BaseModel):
    """Die Bestenliste: was man jetzt spielen würde.

    ``dropped`` ist genauso wichtig wie ``picks``. Eine leere Liste ohne
    Begründung lässt den Nutzer ratlos zurück - hier steht deshalb immer,
    warum nichts übrig blieb.
    """

    window_minutes: int
    considered: int
    picks: list[RecommendationPick] = Field(default_factory=list)
    total_stake_percent: float = 0.0
    #: Hinterlegte Bankroll; ``null`` = keine, dann nur Prozentwerte.
    bankroll: float | None = None
    dropped: list[SuppressionReason] = Field(default_factory=list)
    #: Steht bewusst in jeder Antwort - siehe README.
    disclaimer: str = (
        "Schätzung aus öffentlich abrufbaren Quoten. Keine Wettberatung, "
        "keine Gewinngarantie. Es wird nichts automatisch gesetzt."
    )


class StatsResponse(BaseModel):
    events_total: int
    events_live: int
    alerts_total: int
    alerts_window: int
    alerts_by_kind: dict[str, int]
    avg_value_percent: float | None = None
    odds_snapshots: int
    bookmakers: int
    window_hours: int
    tracked_events_redis: int = 0
    live_events_redis: int = 0
    providers_connected: int = 0
    providers_total: int = 0
    #: Warum kein Alarm entstand - absteigend nach Häufigkeit.
    suppressed: list[SuppressionReason] = Field(default_factory=list)
    suppressed_total: int = 0
    #: Nachkontrolle: wie viele Alarme ausgewertet sind und wie sie ausgingen.
    verdicts: list[VerdictCount] = Field(default_factory=list)
    followups_pending: int = 0
    avg_clv_percent: float | None = None
    #: Wie die Alarme empfohlen wurden - je Grad.
    grades: list[SuppressionReason] = Field(default_factory=list)
    playable_alerts: int = 0


class WsMessage(BaseModel):
    """Nachrichtenformat des Dashboard-WebSockets."""

    type: Literal["alert", "event", "odds", "hello", "ping"]
    payload: dict[str, Any] = Field(default_factory=dict)
