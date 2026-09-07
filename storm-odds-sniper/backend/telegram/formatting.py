"""Nachrichtenaufbereitung für Telegram (HTML-Parse-Mode).

Kein Zustand, keine I/O - dadurch vollständig testbar. Felder, die ein
Provider nicht liefert, werden schlicht weggelassen statt geraten.
"""

from __future__ import annotations

from html import escape

from backend.models.domain import Alert, EventSnapshot, now_ts
from backend.models.enums import AlertKind, EventStatus, Sport

SPORT_ICON = {Sport.FOOTBALL: "⚽", Sport.TENNIS: "🎾"}
STATUS_ICON = {
    EventStatus.LIVE: "🔴",
    EventStatus.PRE_MATCH: "🟢",
    EventStatus.SUSPENDED: "⏸",
    EventStatus.FINISHED: "🏁",
    EventStatus.UNKNOWN: "⚪",
}
KIND_TITLE = {
    AlertKind.FIXED_ERROR: "🎯 FIXED ODDS ERROR",
    AlertKind.VALUE: "💎 VALUE",
    AlertKind.ODDS_MOVE: "📈 ODDS MOVE",
}
KIND_ICON = {AlertKind.FIXED_ERROR: "🎯", AlertKind.VALUE: "💎", AlertKind.ODDS_MOVE: "📈"}

#: Provider, deren Daten erfunden sind. Alarme daraus werden deutlich
#: gekennzeichnet - sonst suchen Nutzer nach Spielen, die es nicht gibt.
SIMULATED_PROVIDERS = frozenset({"mock"})

SIMULATION_NOTE = "🧪 <b>SIMULATION</b> — dieses Spiel und diese Quoten sind <b>erfunden</b>."


def is_simulated(provider: str) -> bool:
    return (provider or "").lower() in SIMULATED_PROVIDERS


def esc(text: object) -> str:
    return escape(str(text), quote=False)


def confidence_bar(confidence: int, width: int = 10) -> str:
    filled = max(0, min(width, round(confidence / 100 * width)))
    return "█" * filled + "░" * (width - filled)


def format_time(ts: float) -> str:
    from datetime import datetime

    return datetime.fromtimestamp(ts).strftime("%H:%M:%S.%f")[:-3]


# ------------------------------------------------------------- Event-Kontext


def football_context(event: EventSnapshot) -> list[str]:
    lines: list[str] = []
    state = event.football
    if state is not None and state.minute is not None:
        minute = f"{state.minute}'"
        if state.stoppage_time:
            minute += f"+{state.stoppage_time}"
        if state.period:
            minute += f" ({esc(state.period)})"
        lines.append(f"⏱ {minute}")
    if event.score is not None and (score := event.score.as_text()):
        lines.append(f"📊 Score: <b>{score}</b>")
    if state is not None and (state.home_red_cards or state.away_red_cards):
        lines.append(f"🟥 Rote Karten: {state.home_red_cards or 0}-{state.away_red_cards or 0}")
    return lines


def tennis_context(event: EventSnapshot) -> list[str]:
    lines: list[str] = []
    state = event.tennis
    if state is None:
        return lines
    if state.sets_home is not None and state.sets_away is not None:
        lines.append(f"📊 Sätze: <b>{state.sets_home}:{state.sets_away}</b>")
    if state.set_number is not None:
        lines.append(f"🎾 Satz: {state.set_number}")
    if (games := state.games_text()) is not None:
        lines.append(f"🎮 Games: {games}")
    if (points := state.points_text()) is not None:
        lines.append(f"⚡ Punkte: {points}")
    if state.server in ("home", "away"):
        server_name = event.home if state.server == "home" else event.away
        lines.append(f"🎯 Aufschlag: {esc(server_name)}")
    return lines


def event_context(event: EventSnapshot) -> list[str]:
    """Live-Details - nur was der Provider wirklich geliefert hat."""
    if event.sport is Sport.FOOTBALL:
        return football_context(event)
    return tennis_context(event)


# --------------------------------------------------------------- Hauptalarm


def format_alert(alert: Alert, *, compact: bool = False) -> str:
    """Vollständige Alarmnachricht im HTML-Format."""
    event = alert.event
    icon = SPORT_ICON.get(event.sport, "🏟")
    status_icon = STATUS_ICON.get(event.status, "⚪")
    sport_name = "FOOTBALL" if event.sport is Sport.FOOTBALL else "TENNIS"

    lines = ["🚨 <b>STORM ODDS SNIPER</b>"]
    if is_simulated(alert.provider):
        lines += [SIMULATION_NOTE, ""]
    lines += [
        f"{status_icon} <b>{event.status.value}</b> — {sport_name}",
        f"{KIND_TITLE.get(alert.kind, '')}",
        "",
        f"{icon} <b>{esc(event.home)}</b>",
        "vs",
        f"{icon} <b>{esc(event.away)}</b>",
    ]
    if event.league:
        lines.append(f"🏆 {esc(event.league)}")
    lines.extend(event_context(event))

    lines += [
        "",
        f"📋 <b>Markt</b>: {esc(alert.market.label)}",
        f"🎲 <b>Auswahl</b>: {esc(alert.selection.display)}",
        f"🏦 <b>Buchmacher</b>: {esc(alert.bookmaker)}",
        "",
        f"💰 <b>Quote</b>: <code>{alert.odds:.2f}</code>",
    ]

    if alert.kind is AlertKind.ODDS_MOVE:
        previous = f"{alert.previous_odds:.2f}" if alert.previous_odds else "?"
        lines += [
            f"↩️ <b>Vorher</b>: <code>{previous}</code>",
            f"📈 <b>Bewegung</b>: <b>{alert.deviation_percent:+.1f}%</b>",
        ]
        if alert.speed_percent_per_second:
            lines.append(f"⚡ <b>Tempo</b>: {alert.speed_percent_per_second:.1f} %/s")
    else:
        lines += [
            f"📊 <b>Faire Quote</b>: <code>{alert.fair_odds:.2f}</code>",
            f"💎 <b>Value</b>: <b>{alert.value_percent:+.1f}%</b>",
            f"📈 <b>Abweichung</b>: <b>{alert.deviation_percent:+.1f}%</b>",
            f"🏦 <b>Referenz</b>: {alert.bookmaker_count} Buchmacher",
            "",
            f"🧠 <b>Confidence</b>: {confidence_bar(alert.confidence)} {alert.confidence}/100",
        ]
        if alert.kind is AlertKind.FIXED_ERROR:
            lines.append(
                f"🎯 <b>Error-Score</b>: {confidence_bar(alert.error_score)} "
                f"{alert.error_score}/100"
            )

    lines.append(f"⚡ <b>Erkannt</b>: {format_time(alert.detected_at)}")

    if not compact and alert.kind is not AlertKind.ODDS_MOVE:
        lines.extend(explain_alert(alert))

    if not compact:
        lines.append(f"⏳ Quotenalter: {alert.odds_age:.1f}s")
        for note in alert.notes[:3]:
            lines.append(f"ℹ️ {esc(note)}")
        lines.append("")
        lines.append("<i>Nur Analyse - keine automatische Wettabgabe.</i>")
    return "\n".join(line for line in lines if line is not None)


def explain_alert(alert: Alert) -> list[str]:
    """Kurze Begründung: woraus die faire Quote stammt.

    Ohne sie muss man dem Ergebnis blind vertrauen - mit ihr lässt sich der
    Alarm in Sekunden gegen den Markt prüfen.
    """
    lines: list[str] = []

    if alert.references:
        prices = sorted(alert.references.items(), key=lambda kv: kv[1])
        shown = ", ".join(f"{esc(name)} {price:.2f}" for name, price in prices[:6])
        more = f" (+{len(prices) - 6})" if len(prices) > 6 else ""
        lines += ["", f"🔎 <b>Verglichen mit</b>: {shown}{more}"]

    models = {k: v for k, v in (alert.fair_models or {}).items() if v}
    if models:
        labels = {
            "median": "Median",
            "margin_removed": "margenbereinigt",
            "weighted_consensus": "Konsens",
        }
        parts = " · ".join(f"{labels.get(k, k)} {v:.2f}" for k, v in models.items())
        lines.append(f"🧮 <b>Modelle</b>: {parts}")

    if alert.score_components:
        top = sorted(alert.score_components.items(), key=lambda kv: kv[1], reverse=True)[:3]
        parts = " · ".join(f"{_COMPONENT_LABELS.get(k, k)} {v:.0f}" for k, v in top)
        lines.append(f"🎯 <b>Stärkste Signale</b>: {parts}")

    return lines


_COMPONENT_LABELS = {
    "deviation": "Abweichung",
    "breadth": "Marktbreite",
    "speed": "Tempo",
    "history": "Historie",
    "live": "Live",
    "liquidity": "Liquidität",
    "quality": "Datenqualität",
    "freshness": "Aktualität",
}


def format_alert_short(alert: Alert) -> str:
    """Einzeiler für Listen (/alerts, /value)."""
    icon = KIND_ICON.get(alert.kind, "•")
    status = STATUS_ICON.get(alert.event.status, "")
    sim = "🧪" if is_simulated(alert.provider) else ""
    return (
        f"{icon}{status}{sim} <b>{esc(alert.event.home)}</b> vs <b>{esc(alert.event.away)}</b>\n"
        f"    {esc(alert.market.label)} · {esc(alert.selection.display)} · "
        f"{esc(alert.bookmaker)}\n"
        f"    <code>{alert.odds:.2f}</code> (fair <code>{alert.fair_odds:.2f}</code>) · "
        f"<b>{alert.value_percent:+.1f}%</b> · C{alert.confidence}"
    )


def format_event_line(event: EventSnapshot) -> str:
    """Eine Zeile je Event für /live."""
    icon = SPORT_ICON.get(event.sport, "🏟")
    sim = "🧪 " if is_simulated(event.provider) else ""
    parts = [f"{sim}{icon} <b>{esc(event.home)}</b> vs <b>{esc(event.away)}</b>"]
    context = event_context(event)
    detail = " · ".join(
        line.split(" ", 1)[1].replace("<b>", "").replace("</b>", "") for line in context[:3]
    )
    if detail:
        parts.append(f"   {esc(detail) if '<' not in detail else detail}")
    return "\n".join(parts)


def format_settings(settings_row) -> str:
    """Einstellungsübersicht eines Nutzers."""
    sports = ", ".join(settings_row.sports or []) or "keine"
    markets = ", ".join(settings_row.markets) if settings_row.markets else "alle"
    return "\n".join(
        [
            "⚙️ <b>Deine Einstellungen</b>",
            "",
            f"💎 Min. Value: <b>{settings_row.min_value_percent:.0f}%</b>",
            f"📈 Min. Abweichung: <b>{settings_row.min_outlier_percent:.0f}%</b>",
            f"💰 Min. Quote: <b>{settings_row.min_odds:.2f}</b>",
            f"💰 Max. Quote: <b>{settings_row.max_odds:.2f}</b>",
            f"🏦 Min. Buchmacher: <b>{settings_row.min_bookmakers}</b>",
            f"🧠 Min. Confidence: <b>{settings_row.min_confidence}</b>",
            f"⏱ Cooldown: <b>{settings_row.cooldown_seconds}s</b>",
            f"🏟 Sportarten: <b>{sports}</b>",
            f"📋 Märkte: <b>{markets}</b>",
            f"🔴 Live: <b>{'an' if settings_row.live_enabled else 'aus'}</b>",
            f"🟢 Pre-Match: <b>{'an' if settings_row.prematch_enabled else 'aus'}</b>",
            f"⏸ Pausiert: <b>{'ja' if settings_row.paused else 'nein'}</b>",
        ]
    )


def format_status(
    *,
    providers: list[dict],
    counters: dict,
    stats: dict,
    paused: bool,
) -> str:
    lines = [
        "📊 <b>Systemstatus</b>",
        "",
        f"🏟 Events beobachtet: <b>{counters.get('tracked_events', 0)}</b>",
        f"🔴 Davon live: <b>{counters.get('live_events', 0)}</b>",
        f"🚨 Alarme (24h): <b>{stats.get('alerts_window', 0)}</b>",
    ]
    by_kind = stats.get("alerts_by_kind") or {}
    if by_kind:
        detail = " · ".join(f"{k}: {v}" for k, v in sorted(by_kind.items()))
        lines.append(f"   {esc(detail)}")
    lines += ["", "<b>Datenquellen</b>"]
    if not providers:
        lines.append("⚪ keine Statusmeldung (läuft der Scanner?)")
    for provider in providers:
        icon = "🟢" if provider.get("healthy") else "🔴"
        name = esc(provider.get("name", "?"))
        status = esc(provider.get("status", "?"))
        quotes = provider.get("quotes", 0)
        errors = provider.get("errors", 0)
        line = f"{icon} <b>{name}</b> — {status} · {quotes} Quoten · {errors} Fehler"
        if provider.get("rate_limit_remaining") is not None:
            line += f" · Kontingent {provider['rate_limit_remaining']}"
        lines.append(line)
    if any(is_simulated(p.get("name", "")) and p.get("healthy") for p in providers):
        lines += [
            "",
            "🧪 <b>Achtung:</b> Es laufen <b>simulierte</b> Daten. Die gemeldeten "
            "Spiele und Quoten sind erfunden. Für echte Daten <code>PROVIDERS</code> "
            "in der <code>.env</code> umstellen.",
        ]
    lines += ["", f"🔔 Benachrichtigungen: <b>{'pausiert' if paused else 'aktiv'}</b>"]
    return "\n".join(lines)


HELP_TEXT = """
🚨 <b>Storm Odds Sniper</b>

Ich überwache Fußball- und Tennisquoten mehrerer Anbieter und melde:

🎯 <b>Fixed-Odds-Fehler</b> — Quoten, die stark vom Markt abweichen
💎 <b>Value</b> — positiver Erwartungswert gegenüber der fairen Quote
📈 <b>Bewegungen</b> — plötzliche Quotensprünge

<b>Befehle</b>
/start — Bot starten und Menü öffnen
/help — diese Hilfe
/status — Systemstatus und Datenquellen
/settings — Filter anzeigen und ändern
/sports — Sportarten wählen
/live — laufende Events
/value — beste aktuelle Value-Alarme
/alerts — letzte Alarme
/pause — Benachrichtigungen pausieren
/resume — Benachrichtigungen fortsetzen

<i>Der Bot analysiert ausschließlich. Er platziert keine Wetten und
verändert nichts bei Buchmachern.</i>
""".strip()

START_TEXT = """
🚨 <b>Storm Odds Sniper</b> ist aktiv.

Du bekommst ab sofort Alarme, sobald eine Quote auffällig vom Marktkonsens
abweicht. Über ⚙️ <b>Einstellungen</b> legst du fest, ab welchem Value,
welcher Confidence und für welche Sportarten du benachrichtigt wirst.

<i>Analyse-Tool - keine automatische Wettabgabe.</i>
""".strip()


def now_time() -> str:
    return format_time(now_ts())
