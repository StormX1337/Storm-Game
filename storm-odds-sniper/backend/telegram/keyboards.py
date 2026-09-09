"""Inline-Tastaturen des Bots."""

from __future__ import annotations

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

MAIN_MENU = [
    [
        InlineKeyboardButton("⚽ Fußball", callback_data="filter:sport:football"),
        InlineKeyboardButton("🎾 Tennis", callback_data="filter:sport:tennis"),
    ],
    [
        InlineKeyboardButton("🔴 Live", callback_data="view:live"),
        InlineKeyboardButton("🟢 Pre-Match", callback_data="view:prematch"),
    ],
    [
        InlineKeyboardButton("💎 Value", callback_data="view:value"),
        InlineKeyboardButton("🎯 Fixed Error", callback_data="view:fixed_error"),
    ],
    [
        InlineKeyboardButton("📒 Bilanz", callback_data="view:scorecard"),
        InlineKeyboardButton("💰 Kasse", callback_data="view:ledger"),
        InlineKeyboardButton("🔒 Sicher", callback_data="view:arbitrage"),
        InlineKeyboardButton("📊 Status", callback_data="view:status"),
    ],
    [
        InlineKeyboardButton("⚙️ Einstellungen", callback_data="view:settings"),
    ],
]


def main_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(MAIN_MENU)


def bet_button(fingerprint: str) -> InlineKeyboardMarkup:
    """Ein Knopf am Alarm: "das habe ich gespielt".

    Er setzt nichts - er hält fest. Ohne diesen Weg müsste man jede Wette
    von Hand nachtragen, und dann führt niemand Buch.
    """
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("✅ Gespielt", callback_data=f"bet:new:{fingerprint}")]]
    )


def bet_settle_buttons(bet_id: int) -> InlineKeyboardMarkup:
    """Wie ist es ausgegangen?"""
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("✅ Gewonnen", callback_data=f"bet:won:{bet_id}"),
                InlineKeyboardButton("❌ Verloren", callback_data=f"bet:lost:{bet_id}"),
            ],
            [
                InlineKeyboardButton("➖ Annulliert", callback_data=f"bet:void:{bet_id}"),
                InlineKeyboardButton("🗑 Löschen", callback_data=f"bet:del:{bet_id}"),
            ],
        ]
    )


def settings_menu(settings_row) -> InlineKeyboardMarkup:
    live = "🔴 Live: an" if settings_row.live_enabled else "⚪ Live: aus"
    prematch = "🟢 Pre: an" if settings_row.prematch_enabled else "⚪ Pre: aus"
    paused = "▶️ Fortsetzen" if settings_row.paused else "⏸ Pausieren"
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("➖ Value", callback_data="set:min_value_percent:-5"),
                InlineKeyboardButton(
                    f"💎 {settings_row.min_value_percent:.0f}%", callback_data="noop"
                ),
                InlineKeyboardButton("➕ Value", callback_data="set:min_value_percent:5"),
            ],
            [
                InlineKeyboardButton("➖ Quote", callback_data="set:min_odds:-0.25"),
                InlineKeyboardButton(f"💰 {settings_row.min_odds:.2f}", callback_data="noop"),
                InlineKeyboardButton("➕ Quote", callback_data="set:min_odds:0.25"),
            ],
            [
                InlineKeyboardButton("➖ Bookies", callback_data="set:min_bookmakers:-1"),
                InlineKeyboardButton(f"🏦 {settings_row.min_bookmakers}", callback_data="noop"),
                InlineKeyboardButton("➕ Bookies", callback_data="set:min_bookmakers:1"),
            ],
            [
                InlineKeyboardButton("➖ Confidence", callback_data="set:min_confidence:-5"),
                InlineKeyboardButton(f"🧠 {settings_row.min_confidence}", callback_data="noop"),
                InlineKeyboardButton("➕ Confidence", callback_data="set:min_confidence:5"),
            ],
            [
                InlineKeyboardButton("➖ Cooldown", callback_data="set:cooldown_seconds:-30"),
                InlineKeyboardButton(f"⏱ {settings_row.cooldown_seconds}s", callback_data="noop"),
                InlineKeyboardButton("➕ Cooldown", callback_data="set:cooldown_seconds:30"),
            ],
            [
                InlineKeyboardButton(live, callback_data="toggle:live_enabled"),
                InlineKeyboardButton(prematch, callback_data="toggle:prematch_enabled"),
            ],
            [
                InlineKeyboardButton("🏟 Sportarten", callback_data="view:sports"),
                InlineKeyboardButton("📋 Märkte", callback_data="view:markets"),
            ],
            [
                InlineKeyboardButton(paused, callback_data="toggle:paused"),
                InlineKeyboardButton("⬅️ Menü", callback_data="view:menu"),
            ],
        ]
    )


def sports_menu(active: list[str]) -> InlineKeyboardMarkup:
    def label(key: str, text: str) -> str:
        return f"{'✅' if key in active else '⬜'} {text}"

    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton(
                    label("football", "⚽ Fußball"), callback_data="sport:football"
                ),
                InlineKeyboardButton(label("tennis", "🎾 Tennis"), callback_data="sport:tennis"),
            ],
            [InlineKeyboardButton("⬅️ Einstellungen", callback_data="view:settings")],
        ]
    )


MARKET_CHOICES = [
    ("1x2", "1X2"),
    ("double_chance", "Double Chance"),
    ("draw_no_bet", "Draw No Bet"),
    ("over_under", "Over/Under"),
    ("btts", "BTTS"),
    ("asian_handicap", "Asian Handicap"),
    ("handicap", "Handicap"),
    ("match_winner", "Match Winner"),
    ("set_winner", "Set Winner"),
    ("game_handicap", "Game Handicap"),
    ("set_handicap", "Set Handicap"),
    ("over_under_games", "O/U Games"),
]


def markets_menu(active: list[str] | None) -> InlineKeyboardMarkup:
    selected = set(active or [])
    rows = []
    for index in range(0, len(MARKET_CHOICES), 2):
        row = []
        for key, text in MARKET_CHOICES[index : index + 2]:
            mark = "✅" if (not selected or key in selected) else "⬜"
            row.append(InlineKeyboardButton(f"{mark} {text}", callback_data=f"market:{key}"))
        rows.append(row)
    rows.append(
        [
            InlineKeyboardButton("🔄 Alle Märkte", callback_data="market:__all__"),
            InlineKeyboardButton("⬅️ Einstellungen", callback_data="view:settings"),
        ]
    )
    return InlineKeyboardMarkup(rows)


def back_to_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("⬅️ Menü", callback_data="view:menu")]])
