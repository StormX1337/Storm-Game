"""Scanner-Engine: der Low-Latency-Pfad.

Ablauf einer Nachricht::

    Provider -> Supervisor -> Queue -> Worker
                                        ├─ Event normalisieren (kanonische ID)
                                        ├─ Quote in Redis (nur bei Änderung!)
                                        ├─ Marktbuch laden (1 Roundtrip/Markt)
                                        ├─ Value Engine + Error-Detector
                                        ├─ Filter (Stale/Cooldown/Duplikat)
                                        └─ Alarm -> Pub/Sub + DB-Queue

Drei Prinzipien:

1. **Nur Änderungen kosten Arbeit.** Ein unveränderter Preis endet nach dem
   Vergleich im Prozess-Cache - keine Analyse, kein Schreibvorgang.
2. **Die Datenbank blockiert nie.** Ein eigener Writer-Task schreibt gebündelt.
3. **Ein Markt wird pro Nachricht einmal geladen**, nicht einmal pro Quote.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import Counter
from dataclasses import dataclass

from backend.core.arbitrage import ArbitrageConfig, find_arbitrage
from backend.core.config import Settings, get_settings
from backend.core.filters import (
    AlertGate,
    FilterThresholds,
    check_error_signal,
    check_quote,
    check_value_signal,
    fingerprint,
)
from backend.core.logging import get_logger
from backend.core.metrics import (
    ALERTS_EMITTED,
    ALERTS_SUPPRESSED,
    ANALYSIS_LATENCY,
    FOLLOWUPS_PENDING,
    LIVE_EVENTS,
    PIPELINE_LATENCY,
    QUEUE_DEPTH,
    QUOTES_CHANGED,
    QUOTES_DROPPED,
    TRACKED_EVENTS,
    VERDICTS_RESOLVED,
)
from backend.core.normalization import EventMatcher, flip_market, flip_selection
from backend.core.outlier import OutlierConfig, score_outlier
from backend.core.recommendation import config_from_settings as recommendation_config
from backend.core.recommendation import evaluate as recommend
from backend.core.value_engine import (
    EngineConfig,
    MarketBook,
    ValueEngine,
    deviation_percent,
    value_percent,
)
from backend.core.verdict import Verdict, VerdictConfig
from backend.core.verdict import resolve as resolve_verdict
from backend.database.repository import Repository
from backend.models.domain import (
    Alert,
    EventSnapshot,
    MarketKey,
    OddsChange,
    OddsQuote,
    ProviderMessage,
    now_ts,
)
from backend.models.enums import AlertKind, EventStatus, Sport
from backend.providers.base import OddsProvider
from backend.scanner.supervisor import ProviderSupervisor
from backend.services.redis_state import RedisState

log = get_logger("scanner")


@dataclass(slots=True)
class EventBinding:
    """Zuordnung einer Provider-Event-ID zur kanonischen ID."""

    event_id: str
    swapped: bool


def thresholds_from_settings(settings: Settings) -> FilterThresholds:
    sports = frozenset(Sport(s) for s in settings.enabled_sports if s in {sp.value for sp in Sport})
    return FilterThresholds(
        min_value_percent=settings.min_value_percent,
        min_outlier_percent=settings.min_outlier_percent,
        min_bookmakers=settings.min_bookmakers,
        min_odds=settings.min_odds,
        max_odds=settings.max_odds,
        max_odds_age_seconds=settings.max_odds_age_seconds,
        alert_cooldown_seconds=settings.alert_cooldown_seconds,
        min_confidence=settings.min_confidence,
        min_error_score=settings.min_error_score,
        scan_live=settings.scan_live,
        scan_prematch=settings.scan_prematch,
        sports=sports or frozenset(Sport),
    )


def prematch_thresholds_from_settings(
    settings: Settings, live: FilterThresholds
) -> FilterThresholds:
    """Schwellen für Spiele vor dem Anpfiff.

    Abgeleitet von den Live-Schwellen, damit nichts doppelt gepflegt werden
    muss: gesetzt wird nur, was in der .env ausdrücklich anders steht. Wer
    nichts einträgt, bekommt exakt die Live-Werte - keine stillen Extras.
    """
    return live.with_overrides(
        min_value_percent=settings.prematch_min_value_percent,
        min_outlier_percent=settings.prematch_min_outlier_percent,
        min_bookmakers=settings.prematch_min_bookmakers,
        min_confidence=settings.prematch_min_confidence,
        min_error_score=settings.prematch_min_error_score,
    )


class ScannerEngine:
    """Verbindet Provider, Redis, Datenbank und Analyse."""

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        state: RedisState,
        repository: Repository | None = None,
        providers: list[OddsProvider] | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.state = state
        self.repository = repository
        self.providers = providers or []

        self.thresholds = thresholds_from_settings(self.settings)
        # Vor dem Anpfiff gelten andere Maßstäbe - siehe
        # prematch_thresholds_from_settings.
        self.prematch_thresholds = prematch_thresholds_from_settings(self.settings, self.thresholds)
        self.value_engine = ValueEngine(
            EngineConfig(
                max_quote_age=self.settings.max_odds_age_seconds,
                min_bookmakers=self.settings.min_bookmakers,
            )
        )
        self.outlier_config = OutlierConfig(
            min_deviation_percent=self.settings.min_outlier_percent,
            max_quote_age=self.settings.max_odds_age_seconds,
        )
        self.gate = AlertGate(state, self.thresholds)
        self.matcher = EventMatcher(threshold=self.settings.event_match_threshold)
        # Für die Nachkontrolle gilt ein großzügigeres Alter: hier wird nicht
        # gewettet, sondern gemessen. Die Redis-TTL begrenzt die Daten ohnehin.
        self.followup_engine = ValueEngine(
            EngineConfig(
                max_quote_age=float(self.settings.odds_state_ttl_seconds),
                min_bookmakers=self.settings.min_bookmakers,
            )
        )
        self.verdict_config = VerdictConfig(move_percent=self.settings.followup_move_percent)
        #: Aus einem Alarm wird eine Handlungsempfehlung. Sie wird hier
        #: berechnet und mitgeschrieben, damit Dashboard, Telegram und
        #: API dieselbe Zahl zeigen - statt drei eigene Rechnungen.
        self.recommendation_config = recommendation_config(self.settings)
        #: Sichere Wetten sind reine Arithmetik - keine Schätzung, kein
        #: Modell. Sie laufen im selben Durchgang mit, weil die Preise
        #: ohnehin schon beisammen sind.
        self.arbitrage_config = ArbitrageConfig(
            min_profit_percent=self.settings.arbitrage_min_profit_percent,
            max_profit_percent=self.settings.arbitrage_max_profit_percent,
            max_age=self.settings.arbitrage_max_age,
            exchange_commission=self.settings.arbitrage_exchange_commission,
            min_liquidity=self.settings.arbitrage_min_liquidity,
        )

        self._queue: asyncio.Queue[ProviderMessage] = asyncio.Queue(
            maxsize=self.settings.scanner_queue_size
        )
        self._db_queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue(maxsize=50_000)
        self._bindings: dict[tuple[str, str], EventBinding] = {}
        self._events: dict[str, EventSnapshot] = {}
        self._supervisors: list[ProviderSupervisor] = []
        self._tasks: list[asyncio.Task] = []
        self._stopped = asyncio.Event()
        self._snapshot_counter = 0
        #: Letzter beobachteter Markt-Median je Quotenzeile (Preis, Zeitpunkt).
        self._line_medians: dict[str, tuple[float, float]] = {}
        #: Unterdrückte Alarme je Grund. Wird gebündelt nach Redis geschrieben -
        #: ein Redis-Aufruf je verworfener Quote wäre im Hot-Path zu teuer.
        self._suppressed: Counter[str] = Counter()
        #: Urteile der Nachkontrolle, gebündelt wie die Unterdrückungen.
        self._verdicts: Counter[str] = Counter()
        #: Wie die Alarme empfohlen wurden - je Grad. Ohne diese Zählung
        #: sieht man nur die Alarme und nie, wie viele davon spielbar waren.
        self._grades: Counter[str] = Counter()
        #: Urteile, deren Alarm beim Schreiben noch nicht in der Datenbank
        #: stand. Der Writer arbeitet gebündelt und kann unter Last hinter der
        #: Nachkontrolle liegen - ohne diesen Puffer ginge das Urteil verloren.
        #: Wert: (Ergebnis, Anzahl Versuche).
        self._unwritten: dict[str, tuple[dict[str, object], int]] = {}
        self.stats = {
            "messages": 0,
            "quotes": 0,
            "changes": 0,
            "alerts": 0,
            "dropped": 0,
            "resolved": 0,
            "arbitrage": 0,
            "arbitrage_suspicious": 0,
        }

    # ------------------------------------------------------------- Lifecycle
    async def start(self) -> None:
        self._stopped.clear()
        for provider in self.providers:
            supervisor = ProviderSupervisor(provider, self._enqueue)
            self._supervisors.append(supervisor)
            self._tasks.append(supervisor.start())

        for index in range(max(1, self.settings.scanner_workers)):
            self._tasks.append(
                asyncio.create_task(self._worker(index), name=f"scan-worker-{index}")
            )
        self._tasks.append(asyncio.create_task(self._db_writer(), name="db-writer"))
        self._tasks.append(asyncio.create_task(self._health_loop(), name="health"))
        if self.settings.followup_enabled:
            self._tasks.append(asyncio.create_task(self._followup_loop(), name="followup"))
        if self.repository is not None:
            self._tasks.append(asyncio.create_task(self._maintenance_loop(), name="maintenance"))
        log.info(
            "scanner gestartet",
            providers=[p.name for p in self.providers],
            workers=self.settings.scanner_workers,
        )
        self._warn_about_self_defeating_config()

    def _warn_about_self_defeating_config(self) -> None:
        """Konfigurationen melden, die garantiert nie einen Alarm erzeugen.

        Der häufigste Fall beim Umstieg von der Simulation auf eine gepollte
        Quelle: der Poll-Takt liegt über dem erlaubten Quotenalter. Dann ist
        jede Quote schon beim Eintreffen "veraltet" und der Scanner schweigt -
        ohne erkennbaren Grund.
        """
        limit = self.settings.max_odds_age_seconds
        for provider in self.providers:
            if provider.supports_streaming:
                continue
            interval = provider.next_poll_delay()
            if interval > limit:
                log.warning(
                    "KONFIGURATION: es kann kein Alarm entstehen - Poll-Takt "
                    "über dem erlaubten Quotenalter",
                    provider=provider.name,
                    poll_interval_seconds=round(interval, 1),
                    max_odds_age_seconds=limit,
                    empfehlung=f"MAX_ODDS_AGE_SECONDS auf mindestens {int(interval * 2)} setzen",
                )

        # Die Nachkontrolle vergleicht gegen den Marktzustand in Redis. Läuft
        # sie erst nach dessen TTL, ist der Vergleichsmarkt weg und jedes
        # Urteil lautet "offen" - stumm und ohne erkennbaren Grund.
        ttl = float(self.settings.odds_state_ttl_seconds)
        if self.settings.followup_enabled and self.settings.followup_after_seconds >= ttl:
            log.warning(
                "KONFIGURATION: Nachkontrolle läuft nach Ablauf des Redis-Zustands - "
                "es kann kein Urteil entstehen",
                followup_after_seconds=self.settings.followup_after_seconds,
                odds_state_ttl_seconds=int(ttl),
                empfehlung=(
                    "FOLLOWUP_AFTER_SECONDS unter ODDS_STATE_TTL_SECONDS setzen "
                    f"(z. B. {int(ttl / 3)})"
                ),
            )

    async def stop(self) -> None:
        self._stopped.set()
        for supervisor in self._supervisors:
            await supervisor.stop()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._tasks.clear()
        self._supervisors.clear()
        await self._flush_db(final=True)
        with contextlib.suppress(Exception):
            if self._suppressed:
                await self.state.add_suppressions(dict(self._suppressed))
                self._suppressed.clear()
            if self._verdicts:
                await self.state.add_verdicts(dict(self._verdicts))
                self._verdicts.clear()
            if self._grades:
                await self.state.add_grades(dict(self._grades))
                self._grades.clear()
        log.info("scanner gestoppt", **{k: v for k, v in self.stats.items()})

    async def _enqueue(self, message: ProviderMessage) -> None:
        try:
            self._queue.put_nowait(message)
        except asyncio.QueueFull:
            # Rückstau: lieber die älteste Nachricht verwerfen als die
            # aktuellsten Preise zu verzögern.
            with contextlib.suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()
                self._queue.task_done()
            with contextlib.suppress(asyncio.QueueFull):
                self._queue.put_nowait(message)
            QUOTES_DROPPED.labels("queue_full").inc(len(message.quotes))
            self.stats["dropped"] += len(message.quotes)
        QUEUE_DEPTH.set(self._queue.qsize())

    # ---------------------------------------------------------------- Worker
    async def _worker(self, index: int) -> None:
        while not self._stopped.is_set():
            try:
                message = await self._queue.get()
            except asyncio.CancelledError:
                raise
            try:
                await self.handle_message(message)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - ein Worker darf nie sterben
                log.error("worker-fehler", worker=index, error=str(exc), exc_info=True)
            finally:
                self._queue.task_done()
                QUEUE_DEPTH.set(self._queue.qsize())

    # ------------------------------------------------------- Nachrichtenpfad
    async def handle_message(self, message: ProviderMessage) -> list[Alert]:
        """Eine Providernachricht vollständig verarbeiten."""
        started = now_ts()
        self.stats["messages"] += 1

        for snapshot in message.events:
            await self._ingest_event(snapshot)

        touched: dict[tuple[str, str], list[OddsChange]] = {}
        for raw_quote in message.quotes:
            self.stats["quotes"] += 1
            quote = self._normalize_quote(raw_quote, message.provider)
            if quote is None:
                QUOTES_DROPPED.labels("unknown_event").inc()
                self._suppress("unknown_event")
                continue
            change = await self.state.apply_quote(quote)
            if change is None:
                continue
            QUOTES_CHANGED.labels(message.provider).inc()
            self.stats["changes"] += 1
            touched.setdefault((quote.event_id, quote.market.key), []).append(change)
            await self._queue_db("change", change)

        alerts: list[Alert] = []
        for (event_id, market_key), changes in touched.items():
            alerts.extend(await self._analyze_market(event_id, market_key, changes))

        PIPELINE_LATENCY.observe(max(0.0, now_ts() - started))
        return alerts

    async def _ingest_event(self, snapshot: EventSnapshot) -> None:
        """Provider-Event auf die kanonische ID abbilden und Zustand pflegen."""
        cache_key = (snapshot.provider, snapshot.provider_event_id)
        binding = self._bindings.get(cache_key)
        if binding is None:
            try:
                result = self.matcher.match(
                    snapshot.sport,
                    snapshot.home,
                    snapshot.away,
                    snapshot.start_time,
                    provider=snapshot.provider,
                )
            except ValueError as exc:
                log.debug("event nicht normalisierbar", error=str(exc), home=snapshot.home)
                return
            binding = EventBinding(event_id=result.event_id, swapped=result.swapped)
            self._bindings[cache_key] = binding
            if result.created:
                log.debug(
                    "neues event",
                    event_ref=result.event_id,
                    sport=snapshot.sport.value,
                    title=snapshot.title,
                )

        if binding.swapped:
            snapshot = _swap_orientation(snapshot)
        snapshot.event_id = binding.event_id

        previous = self._events.get(binding.event_id)
        self._events[binding.event_id] = snapshot

        if previous is None or previous.status is not snapshot.status:
            if snapshot.status is EventStatus.LIVE:
                log.info(
                    "event ist LIVE",
                    event_ref=snapshot.event_id,
                    sport=snapshot.sport.value,
                    title=snapshot.title,
                )
        await self.state.set_event(snapshot)
        await self._queue_db("event", snapshot)

        if previous is None or _event_changed(previous, snapshot):
            await self.state.publish(self.settings.channel_events, snapshot.to_json())

    def _normalize_quote(self, quote: OddsQuote, provider: str) -> OddsQuote | None:
        binding = self._bindings.get((provider, quote.event_id))
        if binding is None:
            return None
        if binding.swapped:
            quote.selection = flip_selection(quote.selection)
            quote.market = flip_market(quote.market)
        quote.event_id = binding.event_id
        return quote

    # -------------------------------------------------------------- Analyse
    def _thresholds_for(self, event: EventSnapshot) -> FilterThresholds:
        """Live oder vor dem Anpfiff - dieselbe Frage, andere Maßstäbe."""
        if event.status is EventStatus.LIVE:
            return self.thresholds
        return self.prematch_thresholds

    def _suppress(self, code: str) -> None:
        """Eine Unterdrückung vermerken - lokal, Übertragung erfolgt gebündelt."""
        ALERTS_SUPPRESSED.labels(code).inc()
        self._suppressed[code] += 1

    async def _analyze_market(
        self, event_id: str, market_key: str, changes: list[OddsChange]
    ) -> list[Alert]:
        event = self._events.get(event_id)
        if event is None:
            event = await self.state.get_event(event_id)
        if event is None:
            return []

        started = now_ts()
        quotes = await self.state.get_market(event_id, market_key)
        if not quotes:
            return []
        book = MarketBook(event_id=event_id, market=MarketKey.parse(market_key))
        for quote in quotes:
            book.add(quote)

        alerts: list[Alert] = []
        reference = now_ts()
        if self.settings.arbitrage_enabled:
            await self._check_arbitrage(book, event, reference)
        by_selection: dict[str, list[OddsChange]] = {}
        for change in changes:
            by_selection.setdefault(change.quote.selection.key, []).append(change)

        for selection_key, selection_changes in by_selection.items():
            drift = self._market_drift(event_id, market_key, selection_key, book, reference)
            for change in self._candidates(book, selection_key, selection_changes, drift):
                alert = await self._evaluate(book, change, event, reference, drift)
                if alert is not None:
                    alerts.append(alert)
            for change in selection_changes:
                move_alert = await self._evaluate_movement(change, event)
                if move_alert is not None:
                    alerts.append(move_alert)

        ANALYSIS_LATENCY.observe(max(0.0, now_ts() - started))
        return alerts

    async def _check_arbitrage(
        self, book: MarketBook, event: EventSnapshot, reference: float
    ) -> None:
        """Widersprechen sich die Bücher in diesem Markt?

        Kostet keinen zusätzlichen Abruf: der Markt liegt ohnehin schon
        vollständig vor. Gefunden wird selten - deshalb ist der Normalfall
        ein einziger Vergleich und danach nichts.
        """
        try:
            arb = find_arbitrage(
                book,
                event_title=event.title,
                sport=event.sport.value,
                reference=reference,
                config=self.arbitrage_config,
            )
        except Exception as exc:  # noqa: BLE001 - darf die Analyse nie stoppen
            log.debug("arbitrage-prüfung fehlgeschlagen", error=str(exc))
            return
        if arb is None:
            return

        payload = arb.to_json()
        with contextlib.suppress(Exception):
            await self.state.set_arbitrage(
                arb.key, payload, ttl=self.settings.arbitrage_ttl_seconds
            )
        self.stats["arbitrage"] += 1
        if arb.suspicious:
            # Zu gut, um wahr zu sein. Die Lesepfade blenden solche Funde aus;
            # der Push wäre sonst der einzige Kanal, der sie doch anpreist -
            # und der einzige, dem man nicht ausweichen kann.
            self.stats["arbitrage_suspicious"] += 1
            log.info(
                "arbitrage verdächtig - nicht gemeldet",
                title=arb.event_title,
                gewinn=f"{arb.profit_percent:.2f}%",
            )
            return
        # Melden nur einmal je Markt und Abkühlzeit - ein Widerspruch, der
        # eine Minute steht, wäre sonst dreißig Nachrichten.
        neu = True
        with contextlib.suppress(Exception):
            neu = await self.state.claim_arbitrage(
                arb.key, cooldown=self.settings.arbitrage_cooldown_seconds
            )
        if not neu:
            return
        with contextlib.suppress(Exception):
            await self.state.publish(self.settings.channel_arbitrage, payload)
        log.info(
            "SICHERE WETTE",
            title=arb.event_title,
            market=arb.market.label,
            gewinn=f"{arb.profit_percent:.2f}%",
            buecher=",".join(arb.bookmakers),
            verdaechtig=arb.suspicious,
        )

    def _candidates(
        self,
        book: MarketBook,
        selection_key: str,
        changes: list[OddsChange],
        drift: float | None,
    ) -> list[OddsChange]:
        """Welche Quoten dieser Zeile werden geprüft?

        Normalerweise nur die geänderten. Bewegt sich aber der Markt, sind
        gerade die **nicht** geänderten Bücher interessant - eine vergessene
        Quote meldet sich nie von selbst. Sie bekommen einen synthetischen
        ``OddsChange`` ohne Vorpreis.
        """
        candidates = list(changes)
        if drift is None or abs(drift) < self.settings.market_drift_suppress_percent:
            return candidates
        changed = {c.quote.bookmaker for c in changes}
        for bookmaker, quote in book.quotes.get(selection_key, {}).items():
            if bookmaker not in changed:
                candidates.append(OddsChange(quote=quote, previous_price=None, previous_ts=None))
        return candidates

    def _market_drift(
        self,
        event_id: str,
        market_key: str,
        selection_key: str,
        book: MarketBook,
        reference: float,
    ) -> float | None:
        """Bewegung des Markt-Medians dieser Quotenzeile in Prozent.

        Positiv = der ganze Markt zieht nach oben. Genau dann ist eine hohe
        Einzelquote meist kein Fehlpreis, sondern nur ein schnelleres Buch.
        """
        quotes = book.usable(
            selection_key,
            exclude=None,
            reference=reference,
            max_age=self.settings.max_odds_age_seconds,
        )
        if len(quotes) < 2:
            return None
        prices = sorted(q.price for q in quotes)
        middle = len(prices) // 2
        median = prices[middle] if len(prices) % 2 else (prices[middle - 1] + prices[middle]) / 2.0
        line_key = f"{event_id}|{market_key}|{selection_key}"
        previous = self._line_medians.get(line_key)
        self._line_medians[line_key] = (median, reference)
        if previous is None:
            return None
        prev_median, prev_ts = previous
        if prev_median <= 0 or reference - prev_ts > self.settings.market_drift_window:
            return None
        return (median / prev_median - 1.0) * 100.0

    async def _evaluate(
        self,
        book: MarketBook,
        change: OddsChange,
        event: EventSnapshot,
        reference: float,
        market_drift: float | None = None,
    ) -> Alert | None:
        quote = change.quote
        schwellen = self._thresholds_for(event)
        decision = check_quote(quote, event, schwellen, reference=reference)
        if not decision.passed:
            self._suppress(decision.code)
            return None

        # Der ganze Markt zieht nach oben: dann ist die hohe Quote in aller
        # Regel die *aktuellere*, und die Referenz hinkt hinterher. Melden
        # würde hier systematisch Fehlalarme erzeugen.
        if market_drift is not None and market_drift >= self.settings.market_drift_suppress_percent:
            self._suppress("market_drift")
            return None

        # Dieses Buch springt kräftig, der Markt hat noch nicht bestätigt:
        # dann *führt* es die Bewegung an (Tor, Rote Karte, Verletzung) und ist
        # das aktuellste Buch - nicht das falsche. Der Fehlpreis ist immer der
        # Nachzügler, nie der Vorreiter.
        own_jump = abs(change.delta_percent) if change.delta_percent is not None else 0.0
        if own_jump >= self.settings.market_shock_percent and (
            market_drift is None or abs(market_drift) < own_jump / 2.0
        ):
            self._suppress("market_leader")
            return None

        is_live = event.status is EventStatus.LIVE
        fair = self.value_engine.fair_odds(
            book,
            quote.selection.key,
            exclude_bookmaker=quote.bookmaker,
            reference=reference,
            is_live=is_live,
        )
        if fair is None:
            self._suppress("no_fair_odds")
            return None
        if (
            fair.fair_probability > self.settings.max_fair_probability
            or fair.fair_odds > schwellen.max_odds
        ):
            # Praktisch entschiedener Markt bzw. extremer Außenseiter jenseits
            # des Quotenbands - dort ist jede Value-Angabe Modellrauschen.
            self._suppress("extreme_probability")
            return None

        value = value_percent(quote.price, fair.fair_probability)
        deviation = deviation_percent(quote.price, fair.fair_odds)
        exchange_refs = sum(
            1
            for bm, q in book.quotes.get(quote.selection.key, {}).items()
            if q.is_exchange and bm != quote.bookmaker
        )
        outlier = score_outlier(
            odds=quote.price,
            fair_odds=fair.fair_odds,
            bookmaker_count=fair.bookmaker_count,
            confidence=fair.confidence,
            quote_age=quote.age(reference),
            is_live=is_live,
            config=self.outlier_config,
            speed_percent_per_second=change.speed_percent_per_second,
            previous_price=change.previous_price,
            # Fällt der Markt, während dieses Buch oben steht, ist genau das
            # das Muster einer vergessenen Quote -> als Signal weiterreichen.
            market_drift_percent=market_drift if (market_drift or 0) < 0 else None,
            liquidity=quote.liquidity,
            exchange_references=exchange_refs,
        )

        error_ok = check_error_signal(
            deviation_percent=deviation,
            bookmaker_count=fair.bookmaker_count,
            error_score=outlier.error_score,
            confidence=fair.confidence,
            thresholds=schwellen,
        )
        value_ok = check_value_signal(
            value_percent=value,
            bookmaker_count=fair.bookmaker_count,
            confidence=fair.confidence,
            thresholds=schwellen,
        )
        if error_ok.passed:
            kind = AlertKind.FIXED_ERROR
        elif value_ok.passed:
            kind = AlertKind.VALUE
        else:
            self._suppress(error_ok.code or value_ok.code)
            return None

        alert = Alert(
            kind=kind,
            event=event,
            market=quote.market,
            selection=quote.selection,
            bookmaker=quote.bookmaker,
            odds=quote.price,
            fair_odds=fair.fair_odds,
            value_percent=value,
            deviation_percent=deviation,
            confidence=fair.confidence,
            error_score=outlier.error_score,
            bookmaker_count=fair.bookmaker_count,
            provider=quote.provider,
            odds_age=quote.age(reference),
            speed_percent_per_second=change.speed_percent_per_second,
            previous_odds=change.previous_price,
            notes=[*fair.notes, *outlier.reasons],
            fair_models={
                "median": fair.model_a_odds,
                "margin_removed": fair.model_b_odds,
                "weighted_consensus": fair.model_c_odds,
            },
            score_components=dict(outlier.components),
            references=self._reference_prices(book, quote),
        )
        alert.fingerprint = fingerprint(alert)
        return await self._emit(alert)

    @staticmethod
    def _reference_prices(book: MarketBook, quote: OddsQuote) -> dict[str, float]:
        """Die Preise, gegen die verglichen wurde - ohne den geprüften selbst.

        Ohne sie ist ein Alarm nicht nachprüfbar: man sieht nur das Ergebnis,
        nicht die Grundlage.
        """
        others = book.quotes.get(quote.selection.key, {})
        return {
            bookmaker: round(other.price, 3)
            for bookmaker, other in sorted(others.items())
            if bookmaker != quote.bookmaker and not other.suspended
        }

    async def _evaluate_movement(self, change: OddsChange, event: EventSnapshot) -> Alert | None:
        """Reine Bewegungsmeldung - unabhängig von Value."""
        if not self.settings.move_alerts_enabled:
            return None
        delta = change.delta_percent
        elapsed = change.elapsed
        if delta is None or elapsed is None:
            return None
        if (
            abs(delta) < self.settings.move_alert_percent
            or elapsed > self.settings.move_alert_window
        ):
            return None

        quote = change.quote
        # Dieselbe Quotenprüfung wie bei Value/Error: Quotenband, Alter,
        # Suspendierung, Sportart. Ohne sie melden praktisch entschiedene
        # Märkte absurde Sprünge (1.04 -> 200.00).
        schwellen = self._thresholds_for(event)
        if not check_quote(quote, event, schwellen).passed:
            return None
        if change.previous_price is not None and not (
            schwellen.min_odds <= change.previous_price <= schwellen.max_odds
        ):
            return None

        alert = Alert(
            kind=AlertKind.ODDS_MOVE,
            event=event,
            market=quote.market,
            selection=quote.selection,
            bookmaker=quote.bookmaker,
            odds=quote.price,
            fair_odds=change.previous_price or quote.price,
            value_percent=0.0,
            deviation_percent=delta,
            confidence=0,
            error_score=0,
            bookmaker_count=0,
            provider=quote.provider,
            odds_age=quote.age(),
            speed_percent_per_second=change.speed_percent_per_second,
            previous_odds=change.previous_price,
            notes=[f"Bewegung {delta:+.1f}% in {elapsed:.1f}s"],
        )
        alert.fingerprint = fingerprint(alert)
        gate = AlertGate(
            self.state,
            schwellen.with_overrides(alert_cooldown_seconds=self.settings.move_alert_cooldown),
        )
        allowed = await gate.allow(alert)
        if not allowed.passed:
            self._suppress(allowed.code)
            return None
        return await self._publish(alert)

    async def _emit(self, alert: Alert) -> Alert | None:
        allowed = await self.gate.allow(alert)
        if not allowed.passed:
            self._suppress(allowed.code)
            return None
        return await self._publish(alert)

    async def _publish(self, alert: Alert) -> Alert:
        self.stats["alerts"] += 1
        ALERTS_EMITTED.labels(alert.kind.value, alert.event.sport.value).inc()
        if self.settings.recommend_enabled:
            # Genau ein Ort, an dem die Empfehlung entsteht. Danach hängt sie
            # am Alarm und geht mit ihm nach Redis, in die Datenbank und in
            # jede Oberfläche - dieselbe Zahl überall.
            suggestion = recommend(alert, self.recommendation_config)
            alert.recommendation = suggestion.to_json()
            self._grades[suggestion.grade.value] += 1
        await self.state.publish_alert(alert)
        await self._queue_db("alert", alert)
        if self.settings.followup_enabled:
            # Ein Alarm ist eine Behauptung. Hier wird vorgemerkt, sie später
            # zu prüfen - mit Daten, die ohnehin einlaufen.
            with contextlib.suppress(Exception):
                await self.state.schedule_followup(
                    alert, due_at=now_ts() + self.settings.followup_after_seconds
                )
        log.info(
            "ALERT",
            kind=alert.kind.value,
            status=alert.event.status.value,
            title=alert.event.title,
            market=alert.market.label,
            selection=alert.selection.display,
            bookmaker=alert.bookmaker,
            odds=round(alert.odds, 2),
            fair=round(alert.fair_odds, 2),
            value=f"{alert.value_percent:+.1f}%",
            confidence=alert.confidence,
            error_score=alert.error_score,
            empfehlung=alert.recommendation.get("grade", "-"),
            einsatz=alert.recommendation.get("stake_percent", 0.0),
        )
        return alert

    # ------------------------------------------------------------ DB-Writer
    async def _queue_db(self, kind: str, payload: object) -> None:
        if self.repository is None:
            return
        with contextlib.suppress(asyncio.QueueFull):
            self._db_queue.put_nowait((kind, payload))

    async def _db_writer(self) -> None:
        if self.repository is None:
            return
        while not self._stopped.is_set():
            try:
                await asyncio.sleep(self.settings.db_writer_interval)
                await self._flush_db()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - Writer darf nie sterben
                log.error("db-writer fehlgeschlagen", error=str(exc))

    async def _flush_db(self, *, final: bool = False) -> None:
        if self.repository is None:
            return
        events: dict[str, EventSnapshot] = {}
        changes: list[OddsChange] = []
        alerts: list[Alert] = []
        limit = self.settings.db_writer_batch if not final else 100_000
        while len(changes) + len(alerts) + len(events) < limit:
            try:
                kind, payload = self._db_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if kind == "event":
                events[payload.event_id] = payload  # type: ignore[union-attr]
            elif kind == "change":
                changes.append(payload)  # type: ignore[arg-type]
            elif kind == "alert":
                alerts.append(payload)  # type: ignore[arg-type]
            self._db_queue.task_done()

        if not events and not changes and not alerts:
            return

        self._snapshot_counter += 1
        store_snapshots = (
            self.settings.snapshot_persist_every > 0
            and self._snapshot_counter % self.settings.snapshot_persist_every == 0
        )
        try:
            await self.repository.write_batch(
                events=list(events.values()),
                changes=changes,
                alerts=alerts,
                store_snapshots=store_snapshots,
            )
        except Exception as exc:  # noqa: BLE001 - DB-Ausfall darf den Scanner nicht stoppen
            log.error(
                "batch-schreiben fehlgeschlagen",
                error=str(exc),
                events=len(events),
                changes=len(changes),
                alerts=len(alerts),
            )

    # ------------------------------------------------ Nachkontrolle
    async def _followup_loop(self) -> None:
        """Fällige Alarme nachkontrollieren.

        Läuft im eigenen Task und ist bewusst vom Hot-Path getrennt: die
        Nachkontrolle darf niemals einen aktuellen Preis verzögern.
        """
        while not self._stopped.is_set():
            try:
                await asyncio.sleep(self.settings.followup_interval_seconds)
                await self.run_followups()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - Nachkontrolle darf nie sterben
                log.warning("nachkontrolle fehlgeschlagen", error=str(exc))

    async def run_followups(self, *, now: float | None = None) -> list[dict[str, object]]:
        """Alle fälligen Nachkontrollen abarbeiten und die Ergebnisse schreiben."""
        reference = now if now is not None else now_ts()
        pending = await self.state.claim_followups(
            now=reference, limit=self.settings.followup_batch
        )
        if not pending:
            # Auch ohne neue Fälligkeiten: die aufgehobenen Urteile brauchen
            # ihren nächsten Versuch, sonst warten sie ewig.
            if self.repository is not None and self._unwritten:
                await self._write_resolutions([])
            with contextlib.suppress(Exception):
                FOLLOWUPS_PENDING.set(await self.state.pending_followups())
            return []

        results: list[dict[str, object]] = []
        for entry in pending:
            try:
                results.append(await self._resolve_followup(entry, reference))
            except Exception as exc:  # noqa: BLE001 - ein Alarm darf den Rest nicht kippen
                log.debug("alarm nicht auswertbar", error=str(exc))

        for result in results:
            verdict = str(result.get("verdict", ""))
            VERDICTS_RESOLVED.labels(verdict).inc()
            self._verdicts[verdict] += 1
        self.stats["resolved"] += len(results)

        if self.repository is not None:
            await self._write_resolutions(results)
        with contextlib.suppress(Exception):
            FOLLOWUPS_PENDING.set(await self.state.pending_followups())
        return results

    #: So oft wird ein Urteil erneut zu schreiben versucht, bevor es aufgegeben
    #: wird. Bei einem Takt von 30 s deckt das mehrere Minuten Rückstand ab.
    WRITE_ATTEMPTS = 10
    #: Obergrenze des Puffers - er darf bei einem dauerhaften Ausfall nicht
    #: unbegrenzt wachsen.
    MAX_UNWRITTEN = 20_000

    async def _write_resolutions(self, results: list[dict[str, object]]) -> None:
        """Urteile schreiben und die noch nicht zuordenbaren aufheben."""
        assert self.repository is not None
        batch = [entry for entry, _ in self._unwritten.values()] + results
        if not batch:
            return
        try:
            missing = await self.repository.resolve_alerts(batch)
        except Exception as exc:  # noqa: BLE001 - DB-Ausfall darf nichts stoppen
            log.error("urteile nicht schreibbar", error=str(exc), count=len(batch))
            return

        unmatched = set(missing)
        retained: dict[str, tuple[dict[str, object], int]] = {}
        given_up = 0
        for entry in batch:
            fingerprint = str(entry.get("fingerprint", ""))
            if fingerprint not in unmatched:
                continue
            attempts = self._unwritten.get(fingerprint, (entry, 0))[1] + 1
            if attempts >= self.WRITE_ATTEMPTS:
                given_up += 1
                continue
            retained[fingerprint] = (entry, attempts)
        if len(retained) > self.MAX_UNWRITTEN:
            given_up += len(retained) - self.MAX_UNWRITTEN
            retained = dict(list(retained.items())[-self.MAX_UNWRITTEN :])
        self._unwritten = retained

        if given_up:
            # Sichtbar machen statt still verlieren: die Bilanz ist dann
            # unvollständig, und der Grund steht im Log.
            log.warning(
                "urteile ohne zugehörigen alarm verworfen - schreibt der db-writer hinterher?",
                verworfen=given_up,
                wartend=len(self._unwritten),
            )
        elif self._unwritten:
            log.debug("urteile warten auf ihren alarm", wartend=len(self._unwritten))

    async def _resolve_followup(self, entry: dict, reference: float) -> dict[str, object]:
        """Einen einzelnen Alarm gegen den aktuellen Marktzustand halten."""
        fingerprint_value = str(entry.get("fingerprint", ""))
        if entry.get("expired"):
            # Der Zwischenspeicher ist abgelaufen, bevor die Nachkontrolle
            # dran war. Kein Urteil ist besser als ein geratenes.
            return {"fingerprint": fingerprint_value, "verdict": Verdict.UNRESOLVED.value}

        event_id = str(entry["event_id"])
        market_key = str(entry["market_key"])
        selection_key = str(entry["selection_key"])
        bookmaker = str(entry["bookmaker"])

        quotes = await self.state.get_market(event_id, market_key)
        book = MarketBook(event_id=event_id, market=MarketKey.parse(market_key))
        for quote in quotes:
            book.add(quote)

        current = book.quotes.get(selection_key, {}).get(bookmaker)
        suspended = bool(current.suspended) if current is not None else False
        final_price = current.price if current is not None and not suspended else None

        event = self._events.get(event_id) or await self.state.get_event(event_id)
        is_live = event is not None and event.status is EventStatus.LIVE
        before = entry.get("state_key")
        state_changed = bool(before) and event is not None and event.state_key() != before
        fair = self.followup_engine.fair_odds(
            book,
            selection_key,
            exclude_bookmaker=bookmaker,
            reference=reference,
            is_live=is_live,
        )

        resolution = resolve_verdict(
            kind=str(entry.get("kind", "")),
            alert_odds=float(entry["odds"]),
            alert_fair=float(entry["fair_odds"]),
            final_price=final_price,
            final_fair=fair.fair_odds if fair is not None else None,
            previous_odds=entry.get("previous_odds"),
            suspended=suspended,
            state_changed=state_changed,
            config=self.verdict_config,
        )
        log.debug(
            "nachkontrolle",
            alert=fingerprint_value,
            verdict=resolution.verdict.value,
            clv=resolution.clv_percent,
        )
        return {
            "fingerprint": fingerprint_value,
            "verdict": resolution.verdict.value,
            "clv_percent": resolution.clv_percent,
            "closing_odds": final_price,
            "closing_fair_odds": fair.fair_odds if fair is not None else None,
        }

    # ----------------------------------------------------------- Health/Pflege
    async def _health_loop(self) -> None:
        while not self._stopped.is_set():
            try:
                await asyncio.sleep(self.settings.provider_health_interval)
                for provider in self.providers:
                    payload = provider.health.to_json()
                    await self.state.set_provider_health(provider.name, payload)
                    if self.repository is not None:
                        await self.repository.upsert_provider_health(provider.health)
                if self._suppressed:
                    pending = dict(self._suppressed)
                    self._suppressed.clear()
                    await self.state.add_suppressions(pending)
                if self._verdicts:
                    verdicts = dict(self._verdicts)
                    self._verdicts.clear()
                    await self.state.add_verdicts(verdicts)
                if self._grades:
                    grades = dict(self._grades)
                    self._grades.clear()
                    await self.state.add_grades(grades)
                # Beendete Spiele melden kein "beendet" - sie hören auf zu
                # erscheinen. Ohne diesen Schritt stünde ein fertiges Match
                # bis zum Ablauf seines Schlüssels weiter als LIVE da.
                stale = await self.state.prune_live_events(self.settings.event_stale_seconds)
                if stale:
                    for event_id in stale:
                        self._events.pop(event_id, None)
                    log.info(
                        "events ohne frische daten - nicht mehr live",
                        anzahl=len(stale),
                        nach_sekunden=self.settings.event_stale_seconds,
                    )
                counters = await self.state.counters()
                LIVE_EVENTS.set(counters["live_events"])
                TRACKED_EVENTS.set(counters["tracked_events"])
                self.state.prune_local_cache()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - Health darf nie stoppen
                log.warning("health-loop fehlgeschlagen", error=str(exc))

    async def _maintenance_loop(self) -> None:
        while not self._stopped.is_set():
            try:
                await asyncio.sleep(self.settings.maintenance_interval_seconds)
                assert self.repository is not None
                removed = await self.repository.prune(
                    snapshot_days=self.settings.retention_snapshot_days,
                    alert_days=self.settings.retention_alert_days,
                )
                log.info("aufräumen abgeschlossen", **removed)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("aufräumen fehlgeschlagen", error=str(exc))


# ------------------------------------------------------------------ Helfer


def _swap_orientation(snapshot: EventSnapshot) -> EventSnapshot:
    """Heim/Auswärts eines Providers an die kanonische Reihenfolge angleichen."""
    snapshot.home, snapshot.away = snapshot.away, snapshot.home
    if snapshot.score is not None:
        snapshot.score.home, snapshot.score.away = snapshot.score.away, snapshot.score.home
    if snapshot.football is not None:
        snapshot.football.home_red_cards, snapshot.football.away_red_cards = (
            snapshot.football.away_red_cards,
            snapshot.football.home_red_cards,
        )
    if snapshot.tennis is not None:
        t = snapshot.tennis
        t.sets_home, t.sets_away = t.sets_away, t.sets_home
        t.games_home, t.games_away = t.games_away, t.games_home
        t.points_home, t.points_away = t.points_away, t.points_home
        if t.server in ("home", "away"):
            t.server = "away" if t.server == "home" else "home"
    return snapshot


def _event_changed(previous: EventSnapshot, current: EventSnapshot) -> bool:
    """Nur relevante Änderungen ins Dashboard pushen."""
    if previous.status is not current.status:
        return True
    prev_score = previous.score.as_text() if previous.score else None
    curr_score = current.score.as_text() if current.score else None
    if prev_score != curr_score:
        return True
    if previous.football and current.football:
        return previous.football.minute != current.football.minute
    if previous.tennis and current.tennis:
        return (
            previous.tennis.games_text() != current.tennis.games_text()
            or previous.tennis.points_text() != current.tennis.points_text()
        )
    return False
