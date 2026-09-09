"""Befehle und Callback-Buttons des Telegram-Bots."""

from __future__ import annotations

import contextlib
from datetime import UTC, datetime, timedelta

from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
)

from backend.core.betlog import BetStatus, stake_from_recommendation
from backend.core.config import get_settings
from backend.core.logging import get_logger
from backend.core.recommendation import Recommendation, build_slip, config_from_settings
from backend.core.recommendation import evaluate as recommend
from backend.database.repository import Repository
from backend.models.domain import Alert
from backend.services.redis_state import RedisState
from backend.telegram import formatting as fmt
from backend.telegram.keyboards import (
    back_to_menu,
    bet_settle_buttons,
    main_menu,
    markets_menu,
    settings_menu,
    sports_menu,
)

log = get_logger("telegram")

ALL_SPORTS = ["football", "tennis"]

#: Zeitfenster von /tipps. Kurz gehalten: ein alter Preis ist keine
#: Empfehlung mehr, sondern eine Erinnerung.
TIPS_WINDOW_MINUTES = 20

#: Grenzen, damit Nutzer sich nicht selbst aussperren oder fluten.
BOUNDS = {
    "min_value_percent": (0.0, 200.0),
    "min_outlier_percent": (0.0, 200.0),
    "min_odds": (1.01, 50.0),
    "max_odds": (1.10, 1000.0),
    "min_bookmakers": (1, 30),
    "min_confidence": (0, 100),
    "cooldown_seconds": (10, 3600),
}


def _repo(context: ContextTypes.DEFAULT_TYPE) -> Repository | None:
    return context.application.bot_data.get("repository")


def _state(context: ContextTypes.DEFAULT_TYPE) -> RedisState | None:
    return context.application.bot_data.get("state")


async def _user_settings(update: Update, context: ContextTypes.DEFAULT_TYPE):
    repo = _repo(context)
    user = update.effective_user
    if repo is None or user is None:
        return None, None
    admins = context.application.bot_data.get("admin_ids", set())
    return await repo.get_or_create_user(
        user.id,
        username=user.username,
        first_name=user.first_name,
        is_admin=user.id in admins,
    )


async def _reply(update: Update, text: str, markup=None) -> None:
    if update.callback_query is not None:
        await update.callback_query.answer()
        try:
            await update.callback_query.edit_message_text(
                text, parse_mode=ParseMode.HTML, reply_markup=markup
            )
            return
        except Exception as exc:  # noqa: BLE001 - z. B. "message is not modified"
            log.debug("nachricht nicht editierbar - sende neu", error=str(exc))
        await update.callback_query.message.reply_text(
            text, parse_mode=ParseMode.HTML, reply_markup=markup
        )
        return
    if update.effective_message is not None:
        await update.effective_message.reply_text(
            text, parse_mode=ParseMode.HTML, reply_markup=markup
        )


async def _reply_new(update: Update, text: str, markup=None) -> None:
    """Eine *neue* Nachricht schicken, statt die bestehende zu ersetzen.

    Beim Abrechnen braucht jede Wette ihre eigene Nachricht mit eigenen
    Knöpfen - würde man die alte überschreiben, bliebe genau eine übrig.
    """
    message = update.effective_message or (
        update.callback_query.message if update.callback_query else None
    )
    if message is not None:
        await message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)


# ------------------------------------------------------------------ Befehle


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _user_settings(update, context)
    await _reply(update, fmt.START_TEXT, main_menu())


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _reply(update, fmt.HELP_TEXT, main_menu())


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    state = _state(context)
    repo = _repo(context)
    providers: list[dict] = []
    counters = {"tracked_events": 0, "live_events": 0}
    stats: dict = {}
    if state is not None:
        try:
            providers = await state.get_provider_health()
            counters = await state.counters()
        except Exception as exc:  # noqa: BLE001
            log.warning("status: redis nicht erreichbar", error=str(exc))
    if repo is not None:
        try:
            stats = await repo.stats()
        except Exception as exc:  # noqa: BLE001
            log.warning("status: datenbank nicht erreichbar", error=str(exc))

    _, settings_row = await _user_settings(update, context)
    paused = bool(settings_row.paused) if settings_row is not None else False
    await _reply(
        update,
        fmt.format_status(providers=providers, counters=counters, stats=stats, paused=paused),
        back_to_menu(),
    )


async def cmd_settings(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    _, settings_row = await _user_settings(update, context)
    if settings_row is None:
        await _reply(update, "⚠️ Datenbank nicht verfügbar - Einstellungen gerade nicht änderbar.")
        return
    await _reply(update, fmt.format_settings(settings_row), settings_menu(settings_row))


async def cmd_sports(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    _, settings_row = await _user_settings(update, context)
    if settings_row is None:
        await _reply(update, "⚠️ Datenbank nicht verfügbar.")
        return
    active = settings_row.sports or []
    await _reply(
        update,
        "🏟 <b>Sportarten</b>\n\nWähle, wofür du Alarme bekommst:",
        sports_menu(active),
    )


async def cmd_live(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    state = _state(context)
    if state is None:
        await _reply(update, "⚠️ Redis nicht verfügbar.")
        return
    events = await state.get_events(await state.live_event_ids())
    if not events:
        await _reply(update, "🔴 <b>Live</b>\n\nAktuell keine laufenden Events.", back_to_menu())
        return
    events.sort(key=lambda e: e.sport.value)
    lines = ["🔴 <b>Live-Events</b>", ""]
    for event in events[:20]:
        lines.append(fmt.format_event_line(event))
    if len(events) > 20:
        lines.append(f"\n… und {len(events) - 20} weitere")
    await _reply(update, "\n".join(lines), back_to_menu())


async def _send_alert_list(
    update: Update, context: ContextTypes.DEFAULT_TYPE, *, kind: str | None, title: str
) -> None:
    repo = _repo(context)
    if repo is None:
        await _reply(update, "⚠️ Datenbank nicht verfügbar.")
        return
    since = datetime.now(UTC) - timedelta(hours=6)
    rows = await repo.list_alerts(limit=10, kind=kind, since=since)
    if not rows:
        await _reply(
            update, f"{title}\n\nIn den letzten 6 Stunden nichts gefunden.", back_to_menu()
        )
        return
    lines = [title, ""]
    for row in rows:
        payload = row.payload or {}
        try:
            lines.append(fmt.format_alert_short(Alert.from_json(payload)))
        except Exception:  # noqa: BLE001 - defensiv gegen alte Payload-Formate
            lines.append(
                f"• {fmt.esc(row.market_label)} · {fmt.esc(row.bookmaker)} · "
                f"{row.odds:.2f} ({row.value_percent:+.1f}%)"
            )
        lines.append("")
    await _reply(update, "\n".join(lines), back_to_menu())


async def cmd_value(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _send_alert_list(update, context, kind="value", title="💎 <b>Value-Alarme</b>")


async def cmd_alerts(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _send_alert_list(update, context, kind=None, title="🚨 <b>Letzte Alarme</b>")


async def cmd_tips(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Was man jetzt spielen würde - mit Einsatzvorschlag.

    Das Fenster ist bewusst kurz. Ein Alarm von vor zwei Stunden ist keine
    Empfehlung mehr, sondern ein Stück Geschichte.
    """
    repo = _repo(context)
    if repo is None:
        await _reply(update, "⚠️ Datenbank nicht verfügbar - keine Empfehlung möglich.")
        return
    settings = context.application.bot_data.get("settings") or get_settings()
    config = config_from_settings(settings)
    window = TIPS_WINDOW_MINUTES
    since = datetime.now(UTC) - timedelta(minutes=window)
    try:
        rows = await repo.list_alerts(limit=300, since=since)
    except Exception as exc:  # noqa: BLE001 - eine Abfrage darf den Bot nie stoppen
        log.warning("empfehlungen nicht lesbar", error=str(exc))
        await _reply(update, "⚠️ Empfehlungen gerade nicht abrufbar.")
        return

    pairs = []
    for row in rows:
        try:
            alert = Alert.from_json(row.payload or {})
        except Exception as exc:  # noqa: BLE001 - defensiv gegen alte Payload-Formate
            log.debug("alarm nicht lesbar - übersprungen", error=str(exc))
            continue
        stored = alert.recommendation
        pairs.append(
            (alert, Recommendation.from_json(stored) if stored else recommend(alert, config))
        )
    slip = build_slip(pairs, config=config, limit=settings.recommend_limit)
    await _reply(
        update,
        fmt.format_slip(slip, window_minutes=window, bankroll=settings.bankroll),
        back_to_menu(),
    )


async def cmd_scorecard(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Was aus den bisherigen Alarmen geworden ist."""
    repo = _repo(context)
    if repo is None:
        await _reply(update, "⚠️ Datenbank nicht verfügbar - keine Bilanz möglich.")
        return
    try:
        data = await repo.scorecard()
    except Exception as exc:  # noqa: BLE001 - eine Kennzahl darf den Bot nie stoppen
        log.warning("bilanz nicht lesbar", error=str(exc))
        await _reply(update, "⚠️ Bilanz gerade nicht abrufbar.")
        return
    data["verdicts"] = [
        {"verdict": code, "label": fmt.VERDICT_TEXT.get(code, code), "count": count}
        for code, count in sorted(data["verdicts"].items(), key=lambda kv: kv[1], reverse=True)
    ]
    await _reply(update, fmt.format_scorecard(data), back_to_menu())


# ------------------------------------------------------------ Wett-Tagebuch


def _bet_unit(settings) -> str:
    return "Kontowährung" if settings.bankroll > 0 else "% der Bankroll"


async def cmd_bets(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Gespielte Wetten - offene zuerst, mit Knöpfen zum Abrechnen."""
    repo = _repo(context)
    user = update.effective_user
    if repo is None or user is None:
        await _reply(update, "⚠️ Datenbank nicht verfügbar.")
        return
    offen = await repo.list_bets(limit=10, status=BetStatus.OPEN.value, user_id=user.id)
    if not offen:
        letzte = await repo.list_bets(limit=5, user_id=user.id)
        if not letzte:
            await _reply(
                update,
                "📓 <b>Wetten</b>\n\nNoch nichts eingetragen. Am Alarm steht "
                "der Knopf ✅ Gespielt - damit landet er hier.",
                back_to_menu(),
            )
            return
        lines = ["📓 <b>Wetten</b>", "", "<i>Nichts offen. Zuletzt abgerechnet:</i>", ""]
        lines += [fmt.format_bet_line(bet) for bet in letzte]
        await _reply(update, "\n\n".join(lines), back_to_menu())
        return

    await _reply(
        update,
        "📓 <b>Offene Wetten</b>\n\n<i>Wie ist es ausgegangen? Ein Knopf je Wette.</i>",
    )
    for bet in offen:
        await _reply_new(update, fmt.format_bet_line(bet), bet_settle_buttons(bet.id))


async def cmd_ledger(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Die Kasse: was dabei herausgekommen ist."""
    repo = _repo(context)
    user = update.effective_user
    if repo is None or user is None:
        await _reply(update, "⚠️ Datenbank nicht verfügbar.")
        return
    settings = context.application.bot_data.get("settings") or get_settings()
    try:
        ledger = await repo.bet_ledger(user_id=user.id, unit=_bet_unit(settings))
    except Exception as exc:  # noqa: BLE001 - eine Kennzahl darf den Bot nie stoppen
        log.warning("kasse nicht lesbar", error=str(exc))
        await _reply(update, "⚠️ Kasse gerade nicht abrufbar.")
        return
    await _reply(update, fmt.format_ledger(ledger, bankroll=settings.bankroll), back_to_menu())


async def _bet_from_alert(update, context, fingerprint: str) -> None:
    """Den Alarm hinter dem Knopf in eine Wette überführen."""
    query = update.callback_query
    repo = _repo(context)
    user = update.effective_user
    settings = context.application.bot_data.get("settings") or get_settings()
    if repo is None or user is None:
        await query.answer("Datenbank nicht verfügbar", show_alert=True)
        return
    if not settings.betlog_enabled:
        await query.answer("Wett-Tagebuch ist abgeschaltet", show_alert=True)
        return

    row = await repo.get_alert_by_fingerprint(fingerprint)
    if row is None:
        await query.answer("Alarm nicht mehr da", show_alert=True)
        return
    try:
        alert = Alert.from_json(row.payload or {})
    except Exception as exc:  # noqa: BLE001 - defensiv gegen alte Payload-Formate
        log.debug("alarm nicht lesbar", error=str(exc))
        await query.answer("Alarm nicht lesbar", show_alert=True)
        return

    empfehlung = alert.recommendation or {}
    # Ohne Bankroll ist der Einsatz ein Anteil, kein Betrag.
    einsatz = stake_from_recommendation(empfehlung, bankroll=settings.bankroll)
    if not einsatz:
        await query.answer("Zu diesem Alarm gibt es keinen Einsatzvorschlag", show_alert=True)
        return

    bet = await repo.create_bet(
        user_id=user.id,
        alert_fingerprint=alert.fingerprint,
        event_id=alert.event.event_id,
        event_title=alert.event.title[:160],
        sport=alert.event.sport.value,
        market_key=alert.market.key,
        market_label=alert.market.label[:128],
        selection_key=alert.selection.key,
        selection_label=alert.selection.display[:128],
        bookmaker=alert.bookmaker,
        odds=alert.odds,
        stake=float(einsatz),
        status=BetStatus.OPEN.value,
        expected_edge_percent=empfehlung.get("credible_edge_percent"),
    )
    await query.answer("Eingetragen")
    await _reply_new(
        update,
        "📓 <b>Eingetragen</b>\n\n"
        + fmt.format_bet_line(bet)
        + "\n\n<i>Die Quote ist die gemeldete. War deine anders, trag sie über "
        "das Dashboard nach.</i>",
        bet_settle_buttons(bet.id),
    )


async def _settle_bet(update, context, action: str, bet_id: int) -> None:
    query = update.callback_query
    repo = _repo(context)
    user = update.effective_user
    if repo is None or user is None:
        await query.answer("Datenbank nicht verfügbar", show_alert=True)
        return
    if action == "del":
        # Nur die eigenen - sonst räumt ein Nutzer im Tagebuch eines anderen auf.
        if await repo.delete_bet(bet_id, user_id=user.id):
            await query.answer("Gelöscht")
            with contextlib.suppress(Exception):
                await query.edit_message_text("🗑 <i>Gelöscht.</i>", parse_mode=ParseMode.HTML)
        else:
            await query.answer("Wette nicht gefunden", show_alert=True)
        return

    bet = await repo.settle_bet(bet_id, action, user_id=user.id)
    if bet is None:
        await query.answer("Wette nicht gefunden", show_alert=True)
        return
    await query.answer("Abgerechnet")
    with contextlib.suppress(Exception):
        await query.edit_message_text(fmt.format_bet_line(bet), parse_mode=ParseMode.HTML)


async def cmd_arbitrage(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Aktuelle Widersprüche zwischen Büchern."""
    state = _state(context)
    settings = context.application.bot_data.get("settings") or get_settings()
    if state is None:
        await _reply(update, "⚠️ Redis nicht verfügbar.")
        return
    if not settings.arbitrage_enabled:
        await _reply(update, "🔒 Sichere Wetten sind abgeschaltet (ARBITRAGE_ENABLED).")
        return
    try:
        funde = await state.get_arbitrages()
    except Exception as exc:  # noqa: BLE001 - eine Abfrage stoppt den Bot nicht
        log.warning("arbitrage nicht lesbar", error=str(exc))
        await _reply(update, "⚠️ Gerade nicht abrufbar.")
        return

    echte = [f for f in funde if not f.get("suspicious")]
    if not echte:
        verdaechtig = len(funde) - len(echte)
        text = (
            "🔒 <b>Sichere Wetten</b>\n\nGerade keine. Das ist der Normalfall - "
            "Buchmacher widersprechen sich selten und nur für Sekunden."
        )
        if verdaechtig:
            text += (
                f"\n\n⚠️ {verdaechtig} Fund(e) waren zu gut, um wahr zu sein, "
                "und damit fast sicher ein Datenfehler. Die stehen hier nicht."
            )
        await _reply(update, text, back_to_menu())
        return

    await _reply(update, f"🔒 <b>Sichere Wetten</b> — {len(echte)} gefunden")
    for item in echte[:5]:
        await _reply_new(update, fmt.format_arbitrage(item, bankroll=settings.bankroll))


async def cmd_pause(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    repo = _repo(context)
    user = update.effective_user
    if repo is None or user is None:
        await _reply(update, "⚠️ Datenbank nicht verfügbar.")
        return
    await _user_settings(update, context)
    await repo.update_user_settings(user.id, paused=True)
    await _reply(update, "⏸ Benachrichtigungen pausiert. Mit /resume geht es weiter.")


async def cmd_resume(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    repo = _repo(context)
    user = update.effective_user
    if repo is None or user is None:
        await _reply(update, "⚠️ Datenbank nicht verfügbar.")
        return
    await _user_settings(update, context)
    await repo.update_user_settings(user.id, paused=False)
    await _reply(update, "▶️ Benachrichtigungen wieder aktiv.")


# ---------------------------------------------------------------- Callbacks


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return
    data = query.data
    repo = _repo(context)
    user = update.effective_user

    if data == "noop":
        await query.answer()
        return

    if data.startswith("view:"):
        target = data.split(":", 1)[1]
        handlers = {
            "menu": cmd_start,
            "settings": cmd_settings,
            "status": cmd_status,
            "live": cmd_live,
            "value": cmd_value,
            "sports": cmd_sports,
            "scorecard": cmd_scorecard,
            "ledger": cmd_ledger,
            "arbitrage": cmd_arbitrage,
        }
        if target == "prematch":
            await _prematch_view(update, context)
            return
        if target == "fixed_error":
            await _send_alert_list(
                update, context, kind="fixed_error", title="🎯 <b>Fixed-Odds-Fehler</b>"
            )
            return
        if target == "markets":
            _, settings_row = await _user_settings(update, context)
            await _reply(
                update,
                "📋 <b>Märkte</b>\n\nOhne Auswahl gelten alle Märkte.",
                markets_menu(settings_row.markets if settings_row else None),
            )
            return
        handler = handlers.get(target)
        if handler is not None:
            await handler(update, context)
        return

    if data.startswith("bet:"):
        _, action, rest = data.split(":", 2)
        if action == "new":
            await _bet_from_alert(update, context, rest)
        else:
            try:
                await _settle_bet(update, context, action, int(rest))
            except ValueError:
                await query.answer()
        return

    if repo is None or user is None:
        await query.answer("Datenbank nicht verfügbar", show_alert=True)
        return
    _, settings_row = await _user_settings(update, context)
    if settings_row is None:
        await query.answer("Datenbank nicht verfügbar", show_alert=True)
        return

    if data.startswith("set:"):
        _, field, raw_delta = data.split(":", 2)
        low, high = BOUNDS.get(field, (0, 10_000))
        current = getattr(settings_row, field, 0)
        delta = float(raw_delta)
        new_value = current + delta
        new_value = max(low, min(high, new_value))
        if isinstance(current, int):
            new_value = int(round(new_value))
        await repo.update_user_settings(user.id, **{field: new_value})

    elif data.startswith("toggle:"):
        field = data.split(":", 1)[1]
        await repo.update_user_settings(user.id, **{field: not getattr(settings_row, field)})

    elif data.startswith("sport:"):
        sport = data.split(":", 1)[1]
        active = list(settings_row.sports or [])
        if sport in active:
            active.remove(sport)
        else:
            active.append(sport)
        await repo.update_user_settings(user.id, sports=active)
        _, refreshed = await _user_settings(update, context)
        await _reply(
            update,
            "🏟 <b>Sportarten</b>\n\nWähle, wofür du Alarme bekommst:",
            sports_menu(refreshed.sports or []),
        )
        return

    elif data.startswith("market:"):
        market = data.split(":", 1)[1]
        if market == "__all__":
            await repo.update_user_settings(user.id, markets=[])
        else:
            active = list(settings_row.markets or [])
            if market in active:
                active.remove(market)
            else:
                active.append(market)
            await repo.update_user_settings(user.id, markets=active)
        _, refreshed = await _user_settings(update, context)
        await _reply(
            update,
            "📋 <b>Märkte</b>\n\nOhne Auswahl gelten alle Märkte.",
            markets_menu(refreshed.markets),
        )
        return

    _, refreshed = await _user_settings(update, context)
    await _reply(update, fmt.format_settings(refreshed), settings_menu(refreshed))


async def _prematch_view(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    state = _state(context)
    if state is None:
        await _reply(update, "⚠️ Redis nicht verfügbar.")
        return
    events = await state.get_events(await state.all_event_ids())
    upcoming = [e for e in events if e.status.value == "PRE_MATCH"]
    if not upcoming:
        await _reply(update, "🟢 <b>Pre-Match</b>\n\nKeine anstehenden Events.", back_to_menu())
        return
    upcoming.sort(key=lambda e: e.start_time or datetime.max.replace(tzinfo=UTC))
    lines = ["🟢 <b>Anstehende Events</b>", ""]
    for event in upcoming[:20]:
        when = event.start_time.strftime("%d.%m. %H:%M") if event.start_time else "?"
        lines.append(
            f"{fmt.SPORT_ICON.get(event.sport, '🏟')} <b>{fmt.esc(event.home)}</b> vs "
            f"<b>{fmt.esc(event.away)}</b> — {when}"
        )
    await _reply(update, "\n".join(lines), back_to_menu())


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.error("telegram-handler fehlgeschlagen", error=str(context.error))


def register(application: Application) -> None:
    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("help", cmd_help))
    application.add_handler(CommandHandler("status", cmd_status))
    application.add_handler(CommandHandler("settings", cmd_settings))
    application.add_handler(CommandHandler("sports", cmd_sports))
    application.add_handler(CommandHandler("live", cmd_live))
    application.add_handler(CommandHandler("value", cmd_value))
    application.add_handler(CommandHandler("alerts", cmd_alerts))
    application.add_handler(CommandHandler("tipps", cmd_tips))
    application.add_handler(CommandHandler("tips", cmd_tips))
    application.add_handler(CommandHandler("wetten", cmd_bets))
    application.add_handler(CommandHandler("bets", cmd_bets))
    application.add_handler(CommandHandler("kasse", cmd_ledger))
    application.add_handler(CommandHandler("arb", cmd_arbitrage))
    application.add_handler(CommandHandler("sicher", cmd_arbitrage))
    application.add_handler(CommandHandler("bilanz", cmd_scorecard))
    application.add_handler(CommandHandler("scorecard", cmd_scorecard))
    application.add_handler(CommandHandler("pause", cmd_pause))
    application.add_handler(CommandHandler("resume", cmd_resume))
    application.add_handler(CallbackQueryHandler(on_callback))
    application.add_error_handler(on_error)
