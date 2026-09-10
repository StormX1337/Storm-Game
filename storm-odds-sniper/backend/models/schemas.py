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
    #: Sekunden seit der letzten Bestätigung durch eine Quelle.
    seconds_since_update: float | None = None
    #: Seit ``EVENT_STALE_SECONDS`` keine Daten mehr. Der Status bleibt
    #: stehen - behauptet wird nicht "beendet", sondern nur "wir wissen es
    #: nicht mehr". Beendete Spiele verschwinden bei den üblichen Quellen
    #: kommentarlos aus der Antwort.
    stale: bool = False


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


class CalculationModel(BaseModel):
    """Die ausgeschriebene Rechnung zu einer Empfehlung.

    Alles folgt exakt aus Quote, Einsatz und dem glaubwürdigen Vorteil.
    Die Beträge sind ``null``, solange keine Bankroll hinterlegt ist - einen
    Einsatz in Euro zu nennen, den niemand festgelegt hat, wäre erfunden.
    """

    #: Was die Quote des Buchmachers behauptet: 1 / Quote.
    implied_probability: float = 0.0
    #: Was nach Abzug aller Unsicherheit angenommen wird.
    credible_probability: float = 0.0
    #: Trefferquote, ab der die Wette bei dieser Quote aufgeht.
    break_even_percent: float = 0.0
    expected_value_percent: float = 0.0
    #: Nettogewinn je eingesetzter Einheit.
    profit_per_unit: float = 0.0
    stake_amount: float | None = None
    payout_amount: float | None = None
    profit_amount: float | None = None
    expected_value_amount: float | None = None


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
    #: ``null`` bei allem, was nicht gespielt wird - dort gibt es nichts
    #: auszurechnen.
    math: CalculationModel | None = None


class OddsHistoryPoint(BaseModel):
    ts: datetime
    price: float
    suspended: bool = False


class OddsHistoryResponse(BaseModel):
    """Preisverlauf einer Quotenzeile.

    Beantwortet, was eine einzelne Zahl nicht beantwortet: fällt die Quote
    gerade, steht sie, oder ist sie eben gesprungen?
    """

    event_id: str
    market: str
    selection: str
    bookmaker: str | None = None
    points: list[OddsHistoryPoint] = Field(default_factory=list)
    #: Erste und letzte Beobachtung im Fenster.
    first_price: float | None = None
    last_price: float | None = None
    change_percent: float | None = None
    minutes: int = 30


class AlertResponse(BaseModel):
    id: int | None = None
    #: Eindeutige Kennung des Alarms - damit lässt sich eine Wette später
    #: genau diesem Alarm zuordnen.
    fingerprint: str = ""
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
    #: Darf das Dashboard Wetten eintragen? Ohne das zeigt es den Knopf gar
    #: nicht erst an, statt ihn ins Leere laufen zu lassen.
    betlog_writes: bool = False


class BetResponse(BaseModel):
    """Eine festgehaltene Wette."""

    id: int
    #: Über Telegram eingetragen? Die Telegram-ID selbst bleibt drin - eine
    #: offene Schnittstelle muss keine Nutzerkennungen ausliefern.
    via_telegram: bool = False
    alert_fingerprint: str | None = None
    event_id: str
    event_title: str = ""
    sport: str = ""
    market_label: str = ""
    selection_label: str = ""
    bookmaker: str = ""
    #: Der Preis, zu dem tatsächlich gespielt wurde.
    odds: float
    stake: float
    #: percent = Anteil der Bankroll, currency = Betrag.
    stake_unit: str = "percent"
    status: str
    status_label: str = ""
    profit: float | None = None
    expected_edge_percent: float | None = None
    note: str = ""
    placed_at: datetime
    settled_at: datetime | None = None


class LedgerResponse(BaseModel):
    """Die Bilanz des Wett-Tagebuchs.

    ``roi_percent`` ist erst ab ``min_settled`` abgerechneten Wetten eine
    Kennzahl - darunter ist sie Zufall. ``reliable`` sagt, welcher Fall
    vorliegt, damit die Oberfläche keine Prozentzahl hinstellt, die nach
    Können aussieht.
    """

    total: int = 0
    open_count: int = 0
    settled: int = 0
    wins: int = 0
    losses: int = 0
    voids: int = 0
    staked: float = 0.0
    open_stake: float = 0.0
    profit: float = 0.0
    #: Was die Empfehlungen für dieselben Wetten versprochen hatten.
    expected_profit: float = 0.0
    roi_percent: float | None = None
    expected_roi_percent: float | None = None
    hit_rate_percent: float | None = None
    reliable: bool = False
    min_settled: int = 20
    #: "Einheiten" ohne hinterlegte Bankroll - dann sind Einsätze
    #: Prozentpunkte der Bankroll, keine Beträge.
    unit: str = "Einheiten"
    #: Kamen Anteile *und* Beträge vor? Dann ist die Summe zweierlei Maß.
    mixed_units: bool = False
    notes: list[str] = Field(default_factory=list)
    #: Ist der Schreibzugriff über die API offen?
    writes_enabled: bool = False


class BetCreateRequest(BaseModel):
    """Eine Wette eintragen - entweder aus einem Alarm oder von Hand."""

    #: Aus diesem Alarm werden Event, Markt, Quote und Einsatz übernommen.
    alert_fingerprint: str | None = None
    #: Überschreibt die Quote des Alarms - der Preis beim Klicken ist meist
    #: ein anderer als der gemeldete, und genau das will man später sehen.
    odds: float | None = Field(default=None, gt=1.0, le=1000.0)
    stake: float | None = Field(default=None, gt=0.0, le=1_000_000.0)
    note: str = Field(default="", max_length=200)
    # ---------------------------------------------- nur ohne Alarm nötig
    event_id: str | None = Field(default=None, max_length=64)
    event_title: str = Field(default="", max_length=160)
    sport: str | None = Field(default=None, pattern="^(football|tennis)$")
    market_label: str = Field(default="", max_length=128)
    selection_label: str = Field(default="", max_length=128)
    bookmaker: str = Field(default="", max_length=64)


class BetSettleRequest(BaseModel):
    status: Literal["open", "won", "lost", "void"]


class ArbitrageLeg(BaseModel):
    """Ein Bein der Wette: ein Ausgang bei einem Buchmacher."""

    selection: str
    selection_label: str = ""
    bookmaker: str
    #: Die angezeigte Quote - die, zu der man spielt.
    odds: float
    #: Nach Abzug der Börsenkommission. Danach wird gerechnet.
    effective_odds: float = 0.0
    is_exchange: bool = False
    liquidity: float | None = None
    #: Anteil des Gesamteinsatzes, damit jeder Ausgang gleich viel zurückgibt.
    stake_share: float = 0.0
    stake_percent: float = 0.0
    age: float = 0.0


class ArbitrageItem(BaseModel):
    event_id: str
    event_title: str = ""
    sport: str = ""
    market: str = ""
    market_label: str = ""
    legs: list[ArbitrageLeg] = Field(default_factory=list)
    #: Summe der Gegenwahrscheinlichkeiten. Unter 1 heißt: es geht auf.
    total_probability: float = 1.0
    profit_percent: float = 0.0
    bookmakers: list[str] = Field(default_factory=list)
    max_age: float = 0.0
    #: Zu gut, um wahr zu sein - praktisch immer ein Datenfehler.
    suspicious: bool = False
    #: Börse beteiligt? Dann steckt eine angenommene Kommission in der
    #: Rechnung, die je nach Konto anders ausfällt.
    has_exchange: bool = False
    #: Zu wenig Geld hinter einer Quote, um den Einsatz aufzunehmen.
    thin_liquidity: bool = False
    detected_at: float = 0.0


class ArbitrageResponse(BaseModel):
    """Aktuelle sichere Wetten.

    Die Liste ist absichtlich kurzlebig: Funde laufen in Redis nach
    ``ARBITRAGE_TTL_SECONDS`` ab. Eine sichere Wette, die es nicht mehr
    gibt, ist wertloser als gar keine.
    """

    enabled: bool = True
    found: int = 0
    #: Wie viele Funde als Datenfehlerverdacht ausgeblendet wurden.
    suspicious_hidden: int = 0
    items: list[ArbitrageItem] = Field(default_factory=list)
    disclaimer: str = (
        "Arithmetik, kein Selbstläufer: beide Preise müssen stehen bleiben, "
        "bis beide Wetten platziert sind. Es wird nichts automatisch gesetzt."
    )


class WsMessage(BaseModel):
    """Nachrichtenformat des Dashboard-WebSockets."""

    type: Literal["alert", "event", "odds", "hello", "ping"]
    payload: dict[str, Any] = Field(default_factory=dict)
