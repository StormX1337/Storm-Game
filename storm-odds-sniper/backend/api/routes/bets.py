"""Wett-Tagebuch: was tatsächlich gespielt wurde.

Lesen ist immer offen, Schreiben nicht. Die API ist genau so geschützt wie
das Dashboard davor - und das steht bei vielen offen im Netz. Ein offener
Schreibpfad hieße, dass jeder Fremde Wetten in ein Tagebuch einträgt, das
später eine Bilanz ergeben soll. Deshalb ist ``BETLOG_API_WRITES``
standardmäßig aus; über Telegram geht es immer, dort ist der Absender
bekannt.

**Wem gehört welche Zeile?** Über Telegram ist der Absender bekannt, über
HTTP nicht - dort gibt es keine Anmeldung. Daraus folgen zwei Regeln, die
zusammengehören:

* **Ändern und Löschen über HTTP betrifft nur Zeilen ohne Nutzer**, also
  genau das, was auch über HTTP entstanden ist. Sonst könnte ein Aufruf ohne
  jede Identität die Wetten eines Telegram-Nutzers abrechnen oder löschen -
  im Bot verhindert das eine Besitzprüfung, und die darf über HTTP nicht
  einfach fehlen.
* **Gelesen wird das ganze Buch**, damit im Dashboard auch auftaucht, was
  über Telegram eingetragen wurde. Die Telegram-ID steht deshalb *nicht* in
  der Antwort: eine offene Schnittstelle muss keine Nutzerkennungen
  ausliefern, damit eine Bilanz stimmt.

Der Bot setzt weiterhin nichts. Er hält fest, was ein Mensch gespielt hat.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, Request

from backend.api.deps import app_settings, get_optional_repository, get_repository
from backend.core.betlog import (
    STATUS_LABELS,
    BetStatus,
    StakeUnit,
    stake_from_recommendation,
    stake_unit_label,
)
from backend.core.logging import get_logger
from backend.models.domain import Alert
from backend.models.schemas import (
    BetCreateRequest,
    BetResponse,
    BetSettleRequest,
    LedgerResponse,
)

log = get_logger("api.bets")
router = APIRouter(prefix="/bets", tags=["bets"])


def _to_response(row) -> BetResponse:
    return BetResponse(
        id=row.id,
        # Die Telegram-ID bleibt drin: eine offene Schnittstelle muss keine
        # Nutzerkennungen ausliefern, damit eine Bilanz stimmt.
        via_telegram=row.user_id is not None,
        alert_fingerprint=row.alert_fingerprint,
        event_id=row.event_id,
        event_title=row.event_title,
        sport=row.sport,
        market_label=row.market_label,
        selection_label=row.selection_label,
        bookmaker=row.bookmaker,
        odds=row.odds,
        stake=row.stake,
        stake_unit=row.stake_unit,
        status=row.status,
        status_label=STATUS_LABELS.get(row.status, row.status),
        profit=row.profit,
        expected_edge_percent=row.expected_edge_percent,
        note=row.note,
        placed_at=row.placed_at,
        settled_at=row.settled_at,
    )


def _require_writes(settings) -> None:
    if not settings.betlog_enabled:
        raise HTTPException(status_code=404, detail="Wett-Tagebuch ist abgeschaltet")
    if not settings.betlog_api_writes:
        raise HTTPException(
            status_code=403,
            detail=(
                "Schreibzugriff über die API ist aus. Er ist genau so geschützt wie "
                "das Dashboard - erst ./scripts/set-dashboard-password.sh laufen "
                "lassen, dann BETLOG_API_WRITES=true setzen. Über Telegram geht es "
                "auch ohne."
            ),
        )


@router.get("", response_model=list[BetResponse], summary="Gespielte Wetten")
async def list_bets(
    request: Request,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    status: str | None = Query(default=None, pattern="^(open|won|lost|void)$"),
    since_hours: int | None = Query(default=None, ge=1, le=8760),
) -> list[BetResponse]:
    repo = get_optional_repository(request)
    if repo is None:
        return []
    since = datetime.now(UTC) - timedelta(hours=since_hours) if since_hours else None
    rows = await repo.list_bets(limit=limit, offset=offset, status=status, since=since)
    return [_to_response(row) for row in rows]


@router.get(
    "/ledger",
    response_model=LedgerResponse,
    summary="Bilanz des Wett-Tagebuchs",
    description=(
        "Was die gespielten Wetten gebracht haben — und wie das zu dem passt, "
        "was die Empfehlungen versprochen hatten.\n\n"
        "`roi_percent` ist erst ab `min_settled` abgerechneten Wetten eine "
        "Kennzahl. Darunter ist sie Zufall, und `reliable` sagt das."
    ),
)
async def ledger(
    request: Request, since_hours: int | None = Query(default=None, ge=1, le=8760)
) -> LedgerResponse:
    settings = app_settings(request)
    repo = get_optional_repository(request)
    if repo is None:
        return LedgerResponse(
            unit=stake_unit_label(settings.bankroll), writes_enabled=settings.betlog_api_writes
        )
    since = datetime.now(UTC) - timedelta(hours=since_hours) if since_hours else None
    result = await repo.bet_ledger(since=since, unit=stake_unit_label(settings.bankroll))
    return LedgerResponse(
        **result.to_json(),
        writes_enabled=settings.betlog_enabled and settings.betlog_api_writes,
    )


@router.post("", response_model=BetResponse, status_code=201, summary="Wette eintragen")
async def create_bet(request: Request, payload: BetCreateRequest) -> BetResponse:
    settings = app_settings(request)
    _require_writes(settings)
    repo = get_repository(request)

    values: dict = {
        "note": payload.note,
        "status": BetStatus.OPEN.value,
        # Ohne Bankroll ist der Einsatz ein Anteil, kein Betrag. Das muss an
        # der Zeile stehen, sonst summiert die Bilanz später zweierlei Maß.
        "stake_unit": (
            StakeUnit.CURRENCY.value if settings.bankroll > 0 else StakeUnit.PERCENT.value
        ),
    }

    if payload.alert_fingerprint:
        row = await repo.get_alert_by_fingerprint(payload.alert_fingerprint)
        if row is None:
            raise HTTPException(status_code=404, detail="Alarm unbekannt")
        try:
            alert = Alert.from_json(row.payload or {})
        except Exception as exc:  # noqa: BLE001 - defensiv gegen alte Payload-Formate
            log.warning("alarm nicht lesbar", error=str(exc))
            raise HTTPException(status_code=422, detail="Alarm nicht lesbar") from exc
        # Zweimal tippen darf keine zweite Zeile erzeugen - sonst zählt die
        # Bilanz Einsatz und Gewinn doppelt.
        vorhanden = await repo.find_bet_for_alert(alert.fingerprint, user_id=None)
        if vorhanden is not None:
            return _to_response(vorhanden)
        recommendation = alert.recommendation or {}
        # Ohne Bankroll ist der Einsatz ein Anteil, kein Betrag - und das
        # bleibt so bis in die Bilanz hinein.
        vorschlag = stake_from_recommendation(recommendation, bankroll=settings.bankroll)
        values.update(
            alert_fingerprint=alert.fingerprint,
            event_id=alert.event.event_id,
            event_title=alert.event.title[:160],
            sport=alert.event.sport.value,
            market_key=alert.market.key,
            market_label=alert.market.label[:128],
            selection_key=alert.selection.key,
            selection_label=alert.selection.display[:128],
            bookmaker=alert.bookmaker,
            odds=payload.odds or alert.odds,
            stake=payload.stake or float(vorschlag),
            expected_edge_percent=recommendation.get("credible_edge_percent"),
        )
    else:
        if not payload.event_id or payload.odds is None or payload.stake is None:
            raise HTTPException(
                status_code=422,
                detail="Ohne Alarm werden event_id, odds und stake gebraucht",
            )
        values.update(
            event_id=payload.event_id,
            event_title=payload.event_title,
            sport=payload.sport or "",
            market_label=payload.market_label,
            selection_label=payload.selection_label,
            bookmaker=payload.bookmaker,
            odds=payload.odds,
            stake=payload.stake,
        )

    if not values.get("stake"):
        raise HTTPException(
            status_code=422,
            detail=(
                "Kein Einsatz. Der Alarm schlägt keinen vor - entweder stake "
                "mitgeben oder BANKROLL setzen."
            ),
        )
    if settings.bankroll <= 0 and payload.stake is None:
        log.info("einsatz als anteil der bankroll gespeichert", stake=values["stake"])

    return _to_response(await repo.create_bet(**values))


@router.post("/{bet_id}/settle", response_model=BetResponse, summary="Wette abrechnen")
async def settle_bet(request: Request, bet_id: int, payload: BetSettleRequest) -> BetResponse:
    _require_writes(app_settings(request))
    repo = get_repository(request)
    # Nur Zeilen ohne Nutzer - siehe Modulkopf. Über HTTP gibt es keine
    # Identität, also darf über HTTP auch nichts Fremdes angefasst werden.
    row = await repo.settle_bet(bet_id, payload.status, only_unowned=True)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=(
                "Wette unbekannt - oder über Telegram eingetragen. Solche "
                "Wetten lassen sich nur dort abrechnen, wo klar ist, wem sie "
                "gehören."
            ),
        )
    return _to_response(row)


@router.delete("/{bet_id}", status_code=204, summary="Wette löschen")
async def delete_bet(request: Request, bet_id: int) -> None:
    _require_writes(app_settings(request))
    repo = get_repository(request)
    if not await repo.delete_bet(bet_id, only_unowned=True):
        raise HTTPException(
            status_code=404,
            detail="Wette unbekannt - oder über Telegram eingetragen.",
        )
