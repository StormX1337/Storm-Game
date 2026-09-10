"""Alarm-Endpunkte (Historie aus PostgreSQL)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Query, Request

from backend.api.deps import app_settings, get_optional_repository
from backend.core.recommendation import (
    REASON_LABELS,
    Recommendation,
    build_slip,
    config_from_settings,
)
from backend.core.recommendation import evaluate as recommend
from backend.core.verdict import VERDICT_LABELS
from backend.models.domain import Alert, to_utc
from backend.models.schemas import (
    AlertResponse,
    BookmakerScore,
    RecommendationPick,
    RecommendationsResponse,
    ScorecardResponse,
    SuppressionReason,
    VerdictCount,
)

router = APIRouter(prefix="/alerts", tags=["alerts"])

#: ``pending`` ist kein Urteil, sondern dessen Abwesenheit - es taucht in der
#: Bilanz trotzdem auf, damit die Summen aufgehen.
LABELS: dict[str, str] = {**VERDICT_LABELS, "pending": "noch offen - Nachkontrolle steht aus"}


def _row_to_response(row) -> AlertResponse:
    payload = row.payload or {}
    event = payload.get("event", {}) or {}
    score = event.get("score") or {}
    score_text = None
    if score.get("home") is not None and score.get("away") is not None:
        score_text = f"{score['home']}:{score['away']}"
    return AlertResponse(
        id=row.id,
        phase=getattr(row, "phase", None) or "unknown",
        fingerprint=row.fingerprint,
        kind=row.kind,
        sport=row.sport,
        event_id=row.event_id,
        event_title=f"{event.get('home', '?')} vs {event.get('away', '?')}",
        league=event.get("league"),
        status=event.get("status", "UNKNOWN"),
        score=score_text,
        market=row.market_key,
        market_label=row.market_label,
        selection=row.selection_key,
        selection_label=row.selection_label,
        bookmaker=row.bookmaker,
        odds=row.odds,
        fair_odds=row.fair_odds,
        value_percent=row.value_percent,
        deviation_percent=row.deviation_percent,
        confidence=row.confidence,
        error_score=row.error_score,
        bookmaker_count=row.bookmaker_count,
        detected_at=row.detected_at,
        provider=row.provider,
        previous_odds=payload.get("previous_odds"),
        notes=list(payload.get("notes", [])),
        fair_models=payload.get("fair_models") or {},
        score_components=payload.get("score_components") or {},
        references=payload.get("references") or {},
        verdict=row.verdict,
        verdict_label=VERDICT_LABELS.get(row.verdict) if row.verdict else None,
        clv_percent=row.clv_percent,
        closing_odds=row.closing_odds,
        closing_fair_odds=row.closing_fair_odds,
        resolved_at=row.resolved_at,
        recommendation=payload.get("recommendation") or None,
    )


def _alert_to_response(alert: Alert) -> AlertResponse:
    """Ein Alarm aus dem Speicher als API-Antwort.

    Getrennt von ``_row_to_response``: dort kommen Urteil und CLV aus
    eigenen Spalten, hier gibt es nur den Alarm selbst.
    """
    score = alert.event.score
    return AlertResponse(
        # Der Alarm weiß selbst, aus welcher Welt er stammt. Ohne diese Zeile
        # stand an jedem Pick "unknown" - die Empfehlungen kamen zwar korrekt
        # gefiltert an, behaupteten aber, ihre Herkunft nicht zu kennen.
        phase=alert.phase,
        fingerprint=alert.fingerprint,
        kind=alert.kind.value,
        sport=alert.event.sport.value,
        event_id=alert.event.event_id,
        event_title=alert.event.title,
        league=alert.event.league,
        status=alert.event.status.value,
        score=score.as_text() if score else None,
        market=alert.market.key,
        market_label=alert.market.label,
        selection=alert.selection.key,
        selection_label=alert.selection.display,
        bookmaker=alert.bookmaker,
        odds=alert.odds,
        fair_odds=alert.fair_odds,
        value_percent=alert.value_percent,
        deviation_percent=alert.deviation_percent,
        confidence=alert.confidence,
        error_score=alert.error_score,
        bookmaker_count=alert.bookmaker_count,
        detected_at=to_utc(alert.detected_at),
        provider=alert.provider,
        previous_odds=alert.previous_odds,
        notes=list(alert.notes),
        fair_models=dict(alert.fair_models),
        score_components=dict(alert.score_components),
        references=dict(alert.references),
        recommendation=alert.recommendation or None,
    )


@router.get("", response_model=list[AlertResponse], summary="Alarm-Historie")
async def list_alerts(
    request: Request,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    sport: str | None = Query(default=None, pattern="^(football|tennis)$"),
    kind: str | None = Query(default=None, pattern="^(value|fixed_error|odds_move)$"),
    min_value: float | None = Query(default=None, ge=-100, le=1000),
    since_minutes: int | None = Query(default=None, ge=1, le=10080),
    grade: str | None = Query(
        default=None,
        pattern="^(strong|moderate|weak|skip)$",
        description="Nur Alarme mit diesem Empfehlungsgrad.",
    ),
    phase: str | None = Query(
        default=None,
        pattern="^(live|prematch)$",
        description=(
            "Nur laufende Spiele oder nur solche vor dem Anpfiff. Ohne Angabe "
            "kommt beides. Alarme aus der Zeit vor dieser Spalte tragen "
            "'unknown' und erscheinen deshalb in keiner der beiden Auswahlen."
        ),
    ),
) -> list[AlertResponse]:
    repo = get_optional_repository(request)
    if repo is None:
        return []
    since = datetime.now(UTC) - timedelta(minutes=since_minutes) if since_minutes else None
    rows = await repo.list_alerts(
        limit=limit,
        offset=offset,
        sport=sport,
        kind=kind,
        min_value=min_value,
        since=since,
        grade=grade,
        phase=phase,
    )
    return [_row_to_response(row) for row in rows]


@router.get(
    "/scorecard",
    response_model=ScorecardResponse,
    summary="Trefferbilanz der Alarme",
    description=(
        "Was aus den Alarmen geworden ist. Jeder Alarm wird nach einer "
        "Wartezeit erneut gegen den Markt gehalten - ohne zusätzlichen "
        "API-Aufruf. `avg_clv_percent` ist **kein Gewinn**, sondern der "
        "Abstand des gemeldeten Preises zum später beobachteten Marktkonsens."
    ),
)
async def scorecard(
    request: Request, window_hours: int = Query(default=168, ge=1, le=8760)
) -> ScorecardResponse:
    repo = get_optional_repository(request)
    if repo is None:
        return ScorecardResponse(window_hours=window_hours, resolved=0, pending=0, scored=0)
    data = await repo.scorecard(window_hours=window_hours)
    return ScorecardResponse(
        window_hours=data["window_hours"],
        resolved=data["resolved"],
        pending=data["pending"],
        scored=data["scored"],
        avg_clv_percent=data["avg_clv_percent"],
        beat_close=data["beat_close"],
        beat_close_share=data["beat_close_share"],
        verdicts=[
            VerdictCount(verdict=code, label=LABELS.get(code, code), count=count)
            for code, count in sorted(data["verdicts"].items(), key=lambda kv: kv[1], reverse=True)
        ],
        by_kind=data["by_kind"],
        by_bookmaker=[BookmakerScore(**entry) for entry in data["by_bookmaker"]],
    )


@router.get(
    "/recommendations",
    response_model=RecommendationsResponse,
    summary="Was soll man jetzt spielen?",
    description=(
        "Die Bestenliste aus den letzten Alarmen: Wette, Buchmacher, Quote "
        "und ein Einsatzvorschlag in Prozent der Bankroll.\n\n"
        "Sortiert wird **nicht** nach der gemeldeten Value-Zahl. Eine Quote "
        "weit jenseits des Marktes ist fast immer ein Datenfehler und kein "
        "Vorteil; solche Alarme werden abgewertet statt nach oben sortiert. "
        "Maßgeblich ist `credible_edge_percent`.\n\n"
        "Das Fenster ist bewusst kurz: ein Preis von vor zwei Stunden ist "
        "keine Empfehlung mehr, sondern Geschichte."
    ),
)
async def recommendations(
    request: Request,
    window_minutes: int = Query(default=15, ge=1, le=1440),
    limit: int | None = Query(default=None, ge=1, le=50),
    sport: str | None = Query(default=None, pattern="^(football|tennis)$"),
    scan_limit: int = Query(
        default=300, ge=1, le=500, description="Wie viele Alarme höchstens geprüft werden."
    ),
    phase: str | None = Query(
        default=None,
        pattern="^(live|prematch)$",
        description=(
            "Nur laufende Spiele oder nur solche vor dem Anpfiff. Ohne Angabe "
            "kommt beides. Alarme aus der Zeit vor dieser Spalte tragen "
            "'unknown' und erscheinen deshalb in keiner der beiden Auswahlen."
        ),
    ),
) -> RecommendationsResponse:
    settings = app_settings(request)
    config = config_from_settings(settings)
    response = RecommendationsResponse(
        window_minutes=window_minutes,
        considered=0,
        bankroll=settings.bankroll or None,
    )
    repo = get_optional_repository(request)
    if repo is None:
        return response

    since = datetime.now(UTC) - timedelta(minutes=window_minutes)
    rows = await repo.list_alerts(limit=scan_limit, sport=sport, since=since, phase=phase)

    pairs: list[tuple[Alert, Recommendation]] = []
    unreadable = 0
    for row in rows:
        try:
            alert = Alert.from_json(row.payload or {})
        except Exception:  # noqa: BLE001 - eine kaputte Zeile kippt nicht die Liste
            unreadable += 1
            continue
        stored = alert.recommendation
        # Gespeichert wird bevorzugt: dieselbe Zahl, die im Dashboard und in
        # Telegram steht. Ältere Alarme haben noch keine - die werden hier
        # nachgerechnet, statt sie stillschweigend wegzulassen.
        suggestion = Recommendation.from_json(stored) if stored else recommend(alert, config)
        pairs.append((alert, suggestion))

    slip = build_slip(pairs, config=config, limit=limit or settings.recommend_limit)
    if unreadable:
        slip.dropped["alarm_unlesbar"] += unreadable
        slip.considered += unreadable

    response.considered = slip.considered
    response.total_stake_percent = slip.total_stake_percent
    response.picks = [
        RecommendationPick(
            alert=_alert_to_response(pick.alert),
            recommendation=pick.recommendation.to_json(),
        )
        for pick in slip.picks
    ]
    response.dropped = [
        SuppressionReason(code=code, label=REASON_LABELS.get(code, code), count=count)
        for code, count in slip.dropped.most_common()
    ]
    return response
