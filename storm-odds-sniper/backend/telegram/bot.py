"""Telegram-Worker.

Zwei Aufgaben in einem Prozess:

1. **Befehle** über Long-Polling (python-telegram-bot).
2. **Alarmversand**: ein Redis-Subscriber verteilt jeden Alarm an alle
   Empfänger, deren persönliche Filter passen.

Der Worker ist bewusst vom Scanner getrennt: ein Telegram-Ausfall (Netz,
Rate-Limit) darf die Quotenanalyse nie ausbremsen.
"""

from __future__ import annotations

import asyncio
import contextlib

from telegram import Bot
from telegram.constants import ParseMode
from telegram.error import Forbidden, RetryAfter, TelegramError
from telegram.ext import Application, ApplicationBuilder

from backend.core.config import Settings, get_settings
from backend.core.logging import get_logger
from backend.core.recommendation import passes_grade
from backend.database.repository import Repository
from backend.models.domain import Alert
from backend.models.enums import AlertKind
from backend.services.redis_state import RedisState
from backend.telegram import formatting as fmt
from backend.telegram.handlers import register
from backend.telegram.keyboards import bet_button

log = get_logger("telegram.bot")


class AlertDispatcher:
    """Verteilt Alarme aus dem Redis-Kanal an die passenden Empfänger."""

    def __init__(
        self,
        bot: Bot,
        state: RedisState,
        settings: Settings,
        repository: Repository | None = None,
    ) -> None:
        self.bot = bot
        self.state = state
        self.settings = settings
        self.repository = repository
        self.sent = 0
        self.skipped = 0

    # ------------------------------------------------------------- Filter
    def matches(self, alert: Alert, user_settings) -> bool:
        """Persönliche Filter des Empfängers anwenden."""
        if user_settings is None:
            return True
        if user_settings.paused:
            return False
        sports = user_settings.sports or []
        if sports and alert.event.sport.value not in sports:
            return False
        markets = user_settings.markets or []
        if markets and alert.market.type.value not in markets:
            return False
        is_live = alert.event.status.value == "LIVE"
        if is_live and not user_settings.live_enabled:
            return False
        if not is_live and not user_settings.prematch_enabled:
            return False
        if alert.odds < user_settings.min_odds or alert.odds > user_settings.max_odds:
            return False

        # Der wirksamste Filter von allen: die meisten Alarme sind zwar echt
        # auffällig, aber nichts, was man spielen würde. Wer den Mindestgrad
        # hochsetzt, macht aus einem Feuerwehrschlauch ein Signal.
        if not passes_grade(alert.recommendation, getattr(user_settings, "min_grade", "any")):
            return False

        if alert.kind is AlertKind.ODDS_MOVE:
            # Bewegungsmeldungen sind fürs Dashboard gedacht; Telegram nur auf Wunsch.
            return self.settings.telegram_send_moves
        if alert.bookmaker_count < user_settings.min_bookmakers:
            return False
        if alert.confidence < user_settings.min_confidence:
            return False
        if alert.kind is AlertKind.FIXED_ERROR:
            return alert.deviation_percent >= user_settings.min_outlier_percent
        return alert.value_percent >= user_settings.min_value_percent

    async def recipients(self) -> list[tuple[int, object]]:
        """(chat_id, settings) aller Empfänger."""
        out: list[tuple[int, object]] = []
        if self.repository is not None:
            try:
                for user, user_settings in await self.repository.list_active_users():
                    out.append((user.telegram_id, user_settings))
            except Exception as exc:  # noqa: BLE001 - DB-Ausfall stoppt den Versand nicht
                log.warning("empfängerliste nicht ladbar", error=str(exc))
        known = {chat_id for chat_id, _ in out}
        if self.settings.telegram_chat_id:
            for raw in self.settings.telegram_chat_id.split(","):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    chat_id = int(raw)
                except ValueError:
                    continue
                if chat_id not in known:
                    # Der konfigurierte Standard-Chat bekommt alles, was der
                    # Scanner durchgelassen hat.
                    out.append((chat_id, None))
        return out

    # ------------------------------------------------------------ Versand
    async def dispatch(self, alert: Alert) -> int:
        text = fmt.format_alert(alert)
        # Der Knopf erscheint nur, wo es etwas zu spielen gibt. An einem
        # Alarm ohne Einsatzvorschlag wäre er eine Einladung zum Unfug.
        markup = None
        if (
            self.settings.betlog_enabled
            and alert.fingerprint
            and (alert.recommendation or {}).get("stake_percent", 0) > 0
        ):
            markup = bet_button(alert.fingerprint)
        sent = 0
        for chat_id, user_settings in await self.recipients():
            if not self.matches(alert, user_settings):
                self.skipped += 1
                continue
            if await self._send(chat_id, text, markup=markup):
                sent += 1
        if sent and self.repository is not None and alert.fingerprint:
            with contextlib.suppress(Exception):
                await self.repository.mark_alert_sent(alert.fingerprint)
        self.sent += sent
        return sent

    async def _send(self, chat_id: int, text: str, *, markup=None) -> bool:
        for attempt in range(3):
            try:
                await self.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    parse_mode=ParseMode.HTML,
                    disable_web_page_preview=True,
                    reply_markup=markup,
                )
                return True
            except RetryAfter as exc:
                # Telegram-Rate-Limit respektieren statt blind zu wiederholen.
                wait = float(getattr(exc, "retry_after", 1.0)) + 0.5
                log.warning("telegram rate-limit", wait_seconds=wait, attempt=attempt + 1)
                await asyncio.sleep(min(wait, 30.0))
            except Forbidden:
                log.info("chat hat den bot blockiert", chat_id=chat_id)
                if self.repository is not None:
                    with contextlib.suppress(Exception):
                        await self.repository.update_user_settings(chat_id, paused=True)
                return False
            except TelegramError as exc:
                log.warning("telegram-versand fehlgeschlagen", error=str(exc))
                await asyncio.sleep(1.0 + attempt)
        return False

    async def dispatch_arbitrage(self, item: dict) -> int:
        """Einen Widerspruch zwischen Büchern verteilen.

        Ohne die üblichen Filter: Value-Schwelle und Confidence sagen hier
        nichts, weil nichts geschätzt wird. Nur "pausiert" gilt weiterhin -
        wer Ruhe will, will Ruhe.
        """
        if not self.settings.arbitrage_telegram:
            return 0
        text = fmt.format_arbitrage(item, bankroll=self.settings.bankroll)
        sent = 0
        for chat_id, user_settings in await self.recipients():
            if user_settings is not None and user_settings.paused:
                continue
            if await self._send(chat_id, text):
                sent += 1
        self.sent += sent
        return sent

    async def run(self) -> None:
        """Dauerhaft auf Alarm- und Arbitrage-Kanal lauschen."""
        kanaele = [self.settings.channel_alerts]
        if self.settings.arbitrage_enabled and self.settings.arbitrage_telegram:
            kanaele.append(self.settings.channel_arbitrage)
        while True:
            try:
                async for channel, payload in self.state.subscribe(*kanaele):
                    if not payload:
                        continue
                    if channel == self.settings.channel_arbitrage:
                        try:
                            await self.dispatch_arbitrage(payload)
                        except Exception as exc:  # noqa: BLE001 - eine Meldung stoppt nichts
                            log.warning("arbitrage-versand fehlgeschlagen", error=str(exc))
                        continue
                    try:
                        alert = Alert.from_json(payload)
                    except Exception as exc:  # noqa: BLE001 - fehlerhafte Nachricht überspringen
                        log.warning("alarm nicht lesbar", error=str(exc))
                        continue
                    await self.dispatch(alert)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - Subscriber neu aufbauen
                log.warning("alarm-subscriber neu gestartet", error=str(exc))
                await asyncio.sleep(2.0)


def build_application(settings: Settings | None = None) -> Application:
    settings = settings or get_settings()
    if not settings.telegram_bot_token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN fehlt")
    return ApplicationBuilder().token(settings.telegram_bot_token).concurrent_updates(True).build()


async def run_bot(
    settings: Settings,
    state: RedisState,
    repository: Repository | None,
) -> None:
    """Bot und Alarmversand parallel betreiben."""
    application = build_application(settings)
    application.bot_data["state"] = state
    application.bot_data["repository"] = repository
    application.bot_data["settings"] = settings
    application.bot_data["admin_ids"] = settings.admin_ids
    register(application)

    dispatcher = AlertDispatcher(application.bot, state, settings, repository)
    application.bot_data["dispatcher"] = dispatcher

    await application.initialize()
    await application.start()
    await application.updater.start_polling(drop_pending_updates=True)
    log.info("telegram-bot läuft")

    dispatch_task = asyncio.create_task(dispatcher.run(), name="alert-dispatcher")
    try:
        await asyncio.Event().wait()
    finally:
        dispatch_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await dispatch_task
        with contextlib.suppress(Exception):
            await application.updater.stop()
        with contextlib.suppress(Exception):
            await application.stop()
        with contextlib.suppress(Exception):
            await application.shutdown()
        log.info("telegram-bot beendet", sent=dispatcher.sent, skipped=dispatcher.skipped)
