"""Nachrichtenaufbereitung für Telegram (HTML-Parse-Mode).

Kein Zustand, keine I/O - dadurch vollständig testbar. Felder, die ein
Provider nicht liefert, werden schlicht weggelassen statt geraten.
"""

from __future__ import annotations

from html import escape

from backend.core.betlog import STATUS_ICONS, STATUS_LABELS
from backend.core.recommendation import (
    GRADE_FILTER_LABELS,
    GRADE_LABELS,
    PLAYABLE_GRADES,
)
from backend.core.recommendation import REASON_LABELS as RECOMMENDATION_REASONS
from backend.core.verdict import VERDICT_LABELS
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
#: Klartext je Urteil, um "pending" ergänzt - das ist kein Urteil, sondern
#: dessen Abwesenheit, taucht in der Bilanz aber auf.
VERDICT_TEXT: dict[str, str] = {
    **VERDICT_LABELS,
    "pending": "noch offen - Nachkontrolle steht aus",
}

#: Unter so vielen ausgewerteten Alarmen wird kein Durchschnitt gezeigt.
#: Muss zu MIN_SCORED im Dashboard passen.
MIN_SCORED = 10

#: Symbole je Empfehlungsgrad - dieselben wie im Dashboard.
GRADE_ICONS: dict[str, str] = {
    "strong": "🟢",
    "moderate": "🟡",
    "weak": "⚪",
    "skip": "⛔",
}

#: Symbole je Urteil der Nachkontrolle - dieselbe Reihenfolge wie im Dashboard.
VERDICT_ICONS: dict[str, str] = {
    "corrected": "✅",
    "vanished": "🚫",
    "market_followed": "↗️",
    "held": "⏸",
    "reverted": "↩️",
    "superseded": "🔄",
    "unresolved": "❔",
    "pending": "⏳",
}


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

    lines.extend(recommendation_block(alert, compact=compact))

    if not compact:
        lines.append(f"⏳ Quotenalter: {alert.odds_age:.1f}s")
        for note in alert.notes[:3]:
            lines.append(f"ℹ️ {esc(note)}")
        lines.append("")
        lines.append("<i>Nur Analyse - keine automatische Wettabgabe.</i>")
    return "\n".join(line for line in lines if line is not None)


def recommendation_block(alert: Alert, *, compact: bool = False) -> list[str]:
    """Der Teil, auf den es ankommt: spielen oder nicht - und mit wie viel.

    Bewusst *nach* den Rohzahlen: der Value steht oben, die Einordnung
    darunter. Eine gemeldete Abweichung von 200 % ist kein Grund für einen
    großen Einsatz, sondern der Verdacht auf einen Datenfehler - und genau
    das sagt dieser Block dann auch.
    """
    data = alert.recommendation
    if not data:
        return []
    # Ein Bewegungsalarm hat keine faire Quote. Ein "nicht spielen" wäre hier
    # kein Urteil, sondern nur dessen Abwesenheit - also gar nichts schreiben.
    if data.get("reason_code") == "keine_referenz":
        return []
    grade = str(data.get("grade", ""))
    icon = GRADE_ICONS.get(grade, "•")
    label = data.get("label") or GRADE_LABELS.get(grade, grade)
    lines = ["", f"{icon} <b>Empfehlung</b>: {esc(label)}"]

    stake = float(data.get("stake_percent") or 0.0)
    if stake > 0:
        amount = data.get("stake_amount")
        betrag = f" (≈ {float(amount):.2f})" if amount else ""
        lines.append(f"💵 <b>Einsatz</b>: {stake:.1f} % der Bankroll{betrag}")
        edge = float(data.get("credible_edge_percent") or 0.0)
        raw = float(data.get("raw_edge_percent") or 0.0)
        lines.append(f"📐 <b>Realistischer Vorteil</b>: {edge:+.1f} % (gemeldet {raw:+.1f} %)")
    else:
        reason = data.get("reason_label") or data.get("reason_code") or ""
        if reason:
            lines.append(f"↳ {esc(reason)}")

    lines.extend(calculation_lines(data))

    if compact:
        return lines

    for warning in list(data.get("warnings") or [])[:2]:
        lines.append(f"⚠️ {esc(warning)}")
    if stake > 0:
        for item in list(data.get("checklist") or [])[:2]:
            lines.append(f"☑️ {esc(item)}")
    return lines


def calculation_lines(data: dict) -> list[str]:
    """Die Rechnung in Klartext: was kostet es, was kommt zurück?

    Ohne hinterlegte Bankroll bleiben die Beträge weg - eine Zahl in Euro zu
    nennen, die niemand festgelegt hat, wäre erfunden. Die Verhältnisse
    gelten trotzdem, die stehen dann allein da.
    """
    math = data.get("math") or {}
    if not math:
        return []
    lines: list[str] = []
    einsatz = math.get("stake_amount")
    auszahlung = math.get("payout_amount")
    if einsatz and auszahlung:
        gewinn = math.get("profit_amount") or 0.0
        lines.append(
            f"🧮 <b>Rechnung</b>: {float(einsatz):.2f} → "
            f"{float(auszahlung):.2f} (Gewinn {float(gewinn):+.2f})"
        )
        erwartung = math.get("expected_value_amount")
        if erwartung is not None:
            lines.append(f"📈 <b>Erwartungswert</b>: {float(erwartung):+.2f} je Wette")
    noetig = math.get("break_even_percent")
    geschaetzt = math.get("credible_probability")
    if noetig is not None and geschaetzt is not None:
        lines.append(
            f"🎯 <b>Trefferquote</b>: {float(noetig):.1f} % nötig · "
            f"{float(geschaetzt) * 100:.1f} % geschätzt"
        )
    return lines


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
    return (
        f"{icon}{status} <b>{esc(alert.event.home)}</b> vs <b>{esc(alert.event.away)}</b>\n"
        f"    {esc(alert.market.label)} · {esc(alert.selection.display)} · "
        f"{esc(alert.bookmaker)}\n"
        f"    <code>{alert.odds:.2f}</code> (fair <code>{alert.fair_odds:.2f}</code>) · "
        f"<b>{alert.value_percent:+.1f}%</b> · C{alert.confidence}"
    )


def format_slip(slip, *, window_minutes: int, bankroll: float = 0.0) -> str:
    """Die Bestenliste für Telegram.

    Wenn nichts übrig bleibt, steht hier *warum*. Eine leere Liste ohne
    Begründung ist der Zustand, in dem man an der Anlage zweifelt statt am
    Markt.
    """
    lines = [
        "🎯 <b>Was jetzt spielen?</b>",
        f"<i>Aus den Alarmen der letzten {window_minutes} Minuten.</i>",
        "",
    ]
    if not slip.picks:
        lines.append(f"Nichts Spielbares unter {slip.considered} geprüften Alarmen.")
        if slip.dropped:
            lines.append("")
            lines.append("<b>Warum</b>:")
            for code, count in slip.dropped.most_common(5):
                lines.append(f"• {esc(RECOMMENDATION_REASONS.get(code, code))}: {count}")
        lines.append("")
        lines.append("<i>Kein Vorschlag ist auch ein Ergebnis - erzwungene Wetten kosten Geld.</i>")
        return "\n".join(lines)

    for index, pick in enumerate(slip.picks, start=1):
        alert, rec = pick.alert, pick.recommendation
        icon = GRADE_ICONS.get(rec.grade.value, "•")
        betrag = f" (≈ {rec.stake_amount:.2f})" if rec.stake_amount else ""
        lines += [
            f"{index}. {icon} <b>{esc(alert.event.home)}</b> vs <b>{esc(alert.event.away)}</b>",
            f"    {esc(alert.market.label)} · <b>{esc(alert.selection.display)}</b>",
            f"    🏦 {esc(alert.bookmaker)} · <code>{alert.odds:.2f}</code>",
            f"    💵 <b>{rec.stake_percent:.1f} %</b> der Bankroll{betrag} · "
            f"Vorteil {rec.credible_edge_percent:+.1f} % "
            f"(gemeldet {rec.raw_edge_percent:+.1f} %)",
        ]
        math = rec.math
        if math is not None:
            if math.stake_amount and math.payout_amount:
                lines.append(
                    f"    🧮 {math.stake_amount:.2f} → {math.payout_amount:.2f} "
                    f"(Gewinn {math.profit_amount:+.2f}, "
                    f"Erwartungswert {math.expected_value_amount:+.2f})"
                )
            lines.append(
                f"    🎯 {math.break_even_percent:.1f} % Trefferquote nötig · "
                f"{math.credible_probability * 100:.1f} % geschätzt"
            )
        lines.append("")

    lines.append(f"<b>Gesamteinsatz</b>: {slip.total_stake_percent:.1f} % der Bankroll")
    if not bankroll:
        lines.append("<i>Keine Bankroll hinterlegt - Beträge werden nicht geraten (BANKROLL).</i>")
    lines += [
        "",
        "<i>Preise vor dem Setzen selbst prüfen. Schätzung aus öffentlichen",
        "Quoten - keine Wettberatung, keine Gewinngarantie. Es wird nichts",
        "automatisch gesetzt.</i>",
    ]
    return "\n".join(lines)


def format_bet_line(bet, *, index: int | None = None) -> str:
    """Eine Wette in einer Zeile."""
    icon = STATUS_ICONS.get(bet.status, "•")
    kopf = f"{index}. " if index is not None else ""
    zeilen = [
        f"{icon} {kopf}<b>{esc(bet.event_title or bet.event_id)}</b>",
        f"    {esc(bet.market_label)} · <b>{esc(bet.selection_label)}</b> · {esc(bet.bookmaker)}",
        f"    Einsatz <b>{bet.stake:.2f}</b> zu <code>{bet.odds:.2f}</code>",
    ]
    if bet.profit is not None:
        zeilen.append(
            f"    Ergebnis: <b>{bet.profit:+.2f}</b> ({esc(STATUS_LABELS.get(bet.status, bet.status))})"
        )
    return "\n".join(zeilen)


def format_ledger(ledger) -> str:
    """Die Kasse: was die gespielten Wetten gebracht haben.

    Bewusst zuerst die Zählerstände, dann erst die Rendite - und die nur,
    wenn genug Wetten dahinterstehen. Eine Prozentzahl aus fünf Wetten sieht
    nach Können aus und ist Zufall.
    """
    data = ledger.to_json()
    einheit = data["unit"]
    lines = [
        "💰 <b>Kasse</b>",
        f"<i>Was tatsächlich gespielt wurde. Einsätze in {esc(einheit)}.</i>",
        "",
        f"📓 <b>Wetten</b>: {data['total']} ({data['open_count']} offen)",
    ]
    if data["settled"]:
        lines += [
            f"✅ {data['wins']} gewonnen · ❌ {data['losses']} verloren"
            + (f" · ➖ {data['voids']} annulliert" if data["voids"] else ""),
            f"💵 <b>Eingesetzt</b>: {data['staked']:.2f}",
            f"📊 <b>Ergebnis</b>: <b>{data['profit']:+.2f}</b>",
        ]
        if data["hit_rate_percent"] is not None:
            lines.append(f"🎯 <b>Trefferquote</b>: {data['hit_rate_percent']:.1f} %")
        if data["reliable"] and data["roi_percent"] is not None:
            lines.append(f"📈 <b>Rendite</b>: {data['roi_percent']:+.1f} % vom Einsatz")
            if data["expected_roi_percent"] is not None:
                lines.append(f"🔮 <b>Erwartet war</b>: {data['expected_roi_percent']:+.1f} %")
    else:
        lines.append("Noch nichts abgerechnet.")
    if data["open_stake"]:
        lines.append(f"⏳ <b>Im Spiel</b>: {data['open_stake']:.2f}")

    for note in data["notes"]:
        lines.append(f"ℹ️ {esc(note)}")
    lines += [
        "",
        "<i>Eingetragen wird von Hand - der Bot setzt nichts und kennt keine",
        "Ergebnisse. Er rechnet nur zusammen, was du ihm sagst.</i>",
    ]
    return "\n".join(lines)


def format_arbitrage(item: dict, *, bankroll: float = 0.0, max_total_percent: float = 6.0) -> str:
    """Ein Widerspruch zwischen Büchern, mit Einsatzverteilung.

    Anders als beim Rest steht hier kein "vermutlich": die Rechnung geht auf,
    egal wie das Spiel ausgeht. Was nicht aufgeht, ist die Annahme, dass
    beide Preise stehen bleiben, bis beide Wetten platziert sind - und genau
    das steht deshalb darunter.
    """
    icon = "⚠️" if item.get("suspicious") else "🔒"
    lines = [
        f"{icon} <b>SICHERE WETTE</b> · <b>{item.get('profit_percent', 0):+.2f} %</b>",
        "",
        f"🏟 <b>{esc(item.get('event_title') or item.get('event_id'))}</b>",
        f"📋 {esc(item.get('market_label') or item.get('market'))}",
        "",
    ]
    # Rechnerisch ist eine Arbitrage risikofrei - praktisch ist sie es nicht:
    # füllt nur ein Bein, steht man mit einer ungewollten Einzelwette da.
    # Deshalb gilt hier derselbe Gesamtdeckel wie für alles andere, statt
    # die ganze Bankroll auf einen Fund zu legen.
    einsatz_basis = bankroll * max_total_percent / 100.0 if bankroll > 0 else 100.0
    einheit = "" if bankroll > 0 else " %"
    for leg in item.get("legs", []):
        anteil = float(leg.get("stake_percent", 0.0))
        betrag = einsatz_basis * anteil / 100.0
        boerse = " 🔁" if leg.get("is_exchange") else ""
        lines.append(
            f"• <b>{esc(leg.get('selection_label') or leg.get('selection'))}</b> "
            f"bei {esc(leg.get('bookmaker'))}{boerse} zu "
            f"<code>{float(leg.get('odds', 0)):.2f}</code>"
        )
        lines.append(f"    Einsatz {betrag:.2f}{einheit} ({anteil:.1f} % des Gesamteinsatzes)")
    if item.get("legs"):
        erster = item["legs"][0]
        rueck = (
            einsatz_basis
            * float(erster.get("stake_percent", 0))
            / 100.0
            * float(erster.get("odds", 0))
        )
        lines += [
            "",
            f"💰 <b>Zurück</b>: {rueck:.2f}{einheit} — bei jedem Ausgang gleich",
        ]
    if bankroll <= 0:
        lines.append("<i>Beträge je 100 Einsatz; mit BANKROLL werden es echte Beträge.</i>")
    else:
        lines.append(
            f"<i>Gesamteinsatz {max_total_percent:.1f} % der Bankroll "
            f"({einsatz_basis:.2f}) - nicht mehr, weil ein Bein ausfallen kann.</i>"
        )

    if item.get("has_exchange"):
        lines += [
            "",
            "🔁 <b>Börse beteiligt.</b> Gerechnet ist mit der angenommenen",
            "Kommission auf den Nettogewinn; dein Konto kann eine andere",
            "haben. Spielen musst du zur angezeigten Quote.",
        ]
    if item.get("thin_liquidity"):
        lines += [
            "",
            "💧 <b>Wenig Geld dahinter.</b> Die Börsenquote nimmt den Einsatz",
            "womöglich gar nicht auf - dann steht der Fund nur auf dem Papier.",
        ]
    if item.get("suspicious"):
        lines += [
            "",
            "⚠️ <b>Zu gut, um wahr zu sein.</b> Reale Widersprüche liegen bei",
            "0,5-3 %. So ein Fund ist fast immer eine falsche Linie oder ein",
            "veralteter Preis - erst prüfen, dann gar nichts.",
        ]
    lines += [
        "",
        f"⏳ Älteste Quote: {float(item.get('max_age', 0)):.0f}s",
        "",
        "<i>Arithmetik, kein Selbstläufer: beide Preise müssen stehen, bis",
        "beide Wetten platziert sind. Bekommst du nur eine Seite, hast du",
        "eine ungewollte Einzelwette. Es wird nichts automatisch gesetzt.</i>",
    ]
    return "\n".join(lines)


def format_digest(
    *,
    stats: dict,
    scorecard: dict,
    ledger,
    grades: dict[str, int],
    hours: int = 24,
    bankroll: float = 0.0,
) -> str:
    """Ein Bericht statt tausend Meldungen.

    Die Reihenfolge ist Absicht: erst was du gespielt hast, dann was das
    System gemeldet hat, zuletzt wie gut die Meldungen waren. Die eigene
    Kasse steht oben, weil sie die Frage beantwortet, wegen der man das
    Ganze betreibt.
    """
    lines = [f"📅 <b>Bericht der letzten {hours} Stunden</b>", ""]

    # 1) Die eigene Kasse.
    daten = ledger.to_json()
    if daten["total"]:
        lines.append("💰 <b>Deine Wetten</b>")
        if daten["settled"]:
            lines.append(
                f"   {daten['wins']}× gewonnen, {daten['losses']}× verloren"
                + (f", {daten['voids']}× annulliert" if daten["voids"] else "")
            )
            lines.append(
                f"   Ergebnis <b>{daten['profit']:+.2f}</b> auf {daten['staked']:.2f} Einsatz"
            )
            if daten["reliable"] and daten["roi_percent"] is not None:
                lines.append(f"   Rendite <b>{daten['roi_percent']:+.1f} %</b>")
        if daten["open_count"]:
            lines.append(f"   ⏳ {daten['open_count']} offen ({daten['open_stake']:.2f} im Spiel)")
        lines.append("")
    else:
        lines += ["💰 <b>Deine Wetten</b>", "   Nichts eingetragen.", ""]

    # 2) Was das System gemeldet hat.
    lines.append("🚨 <b>Alarme</b>")
    lines.append(f"   {stats.get('alerts_window', 0)} in diesem Zeitraum")
    if grades:
        # Die Gradzähler laufen in Redis über eine Woche und lassen sich
        # nicht auf 24 Stunden zurückschneiden. Sie als Anteil der
        # Tageszahl zu zeigen, ergäbe Sätze wie "120 Alarme, davon 340
        # spielbar" - deshalb steht der Zeitraum ausdrücklich dabei.
        spielbar = sum(count for grade, count in grades.items() if grade in PLAYABLE_GRADE_VALUES)
        lines.append("")
        lines.append("🎯 <b>Empfehlungsgrade</b> <i>(laufende Woche)</i>")
        lines.append(f"   spielbar: <b>{spielbar}</b> von {sum(grades.values())}")
        for grade in ("strong", "moderate", "weak", "skip"):
            if grades.get(grade):
                lines.append(
                    f"   {GRADE_ICONS.get(grade, '•')} {esc(GRADE_LABELS.get(grade, grade))}: "
                    f"{grades[grade]}"
                )
    lines.append("")

    # 3) Wie gut die Meldungen waren.
    if scorecard.get("scored", 0) >= MIN_SCORED and scorecard.get("avg_clv_percent") is not None:
        lines += [
            "📒 <b>Trefferbilanz</b>",
            f"   Ø gegenüber dem späteren Markt: <b>{scorecard['avg_clv_percent']:+.1f} %</b>",
            f"   <i>({scorecard['scored']} ausgewertete Alarme - kein Gewinn, nur der",
            "   Abstand zum Marktkonsens danach.)</i>",
            "",
        ]
    elif scorecard.get("resolved"):
        lines += [
            "📒 <b>Trefferbilanz</b>",
            f"   {scorecard['resolved']} nachkontrolliert, {scorecard.get('pending', 0)} offen.",
            f"   <i>Ein Durchschnitt braucht {MIN_SCORED} ausgewertete Alarme.</i>",
            "",
        ]

    if not bankroll:
        lines.append("<i>Einsätze in Prozentpunkten der Bankroll (BANKROLL nicht gesetzt).</i>")
    lines.append("<i>Nur Analyse - es wird nichts automatisch gesetzt.</i>")
    return "\n".join(lines)


def format_event_line(event: EventSnapshot) -> str:
    """Eine Zeile je Event für /live."""
    icon = SPORT_ICON.get(event.sport, "🏟")
    parts = [f"{icon} <b>{esc(event.home)}</b> vs <b>{esc(event.away)}</b>"]
    context = event_context(event)
    detail = " · ".join(
        line.split(" ", 1)[1].replace("<b>", "").replace("</b>", "") for line in context[:3]
    )
    if detail:
        parts.append(f"   {esc(detail) if '<' not in detail else detail}")
    return "\n".join(parts)


#: Werte der spielbaren Grade - einmal abgeleitet statt dreimal getippt.
PLAYABLE_GRADE_VALUES: frozenset[str] = frozenset(g.value for g in PLAYABLE_GRADES)

#: Klartext des Mindestgrads - eine Quelle, nicht drei Kopien.
GRADE_FILTER_TEXT = GRADE_FILTER_LABELS


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
            f"🎯 Nur ab Grad: <b>{esc(GRADE_FILTER_TEXT.get(getattr(settings_row, 'min_grade', 'any') or 'any', 'alle Alarme'))}</b>",
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
    lines += ["", f"🔔 Benachrichtigungen: <b>{'pausiert' if paused else 'aktiv'}</b>"]
    return "\n".join(lines)


def format_scorecard(data: dict) -> str:
    """Trefferbilanz für Telegram.

    Bewusst ohne Gewinnversprechen: gezeigt wird, ob die gemeldeten Preise
    besser waren als der Markt kurz danach - nicht, ob eine Wette gewonnen
    hätte.
    """
    window = data.get("window_hours", 168)
    resolved = data.get("resolved", 0)
    pending = data.get("pending", 0)
    scored = data.get("scored", 0)
    lines = [
        "📒 <b>Trefferbilanz</b>",
        f"<i>Zeitraum: letzte {window} Stunden</i>",
        "",
        f"✅ Nachkontrolliert: <b>{resolved}</b>",
        f"⏳ Noch offen: <b>{pending}</b>",
    ]
    if not resolved:
        lines += [
            "",
            "Noch keine Nachkontrolle abgeschlossen. Jeder Alarm wird einige "
            "Minuten später erneut gegen den Markt gehalten - danach steht hier, "
            "was daraus geworden ist.",
        ]
        return "\n".join(lines)

    avg = data.get("avg_clv_percent")
    share = data.get("beat_close_share")
    if avg is not None and scored >= MIN_SCORED:
        lines.append(f"📈 Ø Abstand zum späteren Markt: <b>{avg:+.1f} %</b> (n={scored})")
        if share is not None:
            lines.append(f"🎯 Besser als der Markt: <b>{share:.0f} %</b> von {scored}")
    else:
        # Ein Mittelwert aus zwei Alarmen ist ein Zufallsergebnis, kein Ergebnis.
        lines.append(
            f"📈 Noch kein Durchschnitt: erst {scored} von {MIN_SCORED} Alarmen "
            "sind mit einer Marktreferenz ausgewertet."
        )

    lines += ["", "<b>Was aus den Alarmen wurde</b>"]
    for entry in data.get("verdicts", [])[:6]:
        code = entry.get("verdict", "")
        icon = VERDICT_ICONS.get(code, "•")
        lines.append(f"{icon} {esc(entry.get('label', code))}: <b>{entry.get('count', 0)}</b>")

    books = data.get("by_bookmaker") or []
    if books:
        lines += ["", "<b>Auffälligste Buchmacher</b>"]
        for entry in books[:5]:
            clv = entry.get("avg_clv_percent")
            suffix = f" · Ø {clv:+.1f} %" if clv is not None else ""
            lines.append(
                f"🏦 {esc(entry.get('bookmaker', '?'))}: {entry.get('alerts', 0)} Alarme{suffix}"
            )

    lines += [
        "",
        "<i>Der Abstand zum Markt ist kein Gewinn. Er zeigt nur, dass ein "
        "Preis besser war als der Konsens kurz danach.</i>",
    ]
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
/tipps — was man jetzt spielen würde, mit Einsatz
/wetten — gespielte Wetten, abrechnen per Knopf
/kasse — was dabei herausgekommen ist
/arb — sichere Wetten (Widersprüche zwischen Büchern)
/bericht — Tagesbericht: Wetten, Alarme, Trefferbilanz
/bilanz — Trefferbilanz: was aus den Alarmen wurde
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
