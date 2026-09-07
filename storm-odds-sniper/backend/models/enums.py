"""Aufzählungstypen der Domäne.

Bewusst als ``StrEnum``: die Werte landen 1:1 in Redis, PostgreSQL und JSON.
"""

from __future__ import annotations

from enum import StrEnum


class Sport(StrEnum):
    FOOTBALL = "football"
    TENNIS = "tennis"


class EventStatus(StrEnum):
    PRE_MATCH = "PRE_MATCH"
    LIVE = "LIVE"
    SUSPENDED = "SUSPENDED"
    FINISHED = "FINISHED"
    UNKNOWN = "UNKNOWN"


class MarketType(StrEnum):
    """Marktarten.

    Neue Marktarten können jederzeit ergänzt werden - die Engine arbeitet
    generisch über ``MarketKey``/``Selection`` und kennt keine Sonderfälle
    je Markt.
    """

    # ---------------------------------------------------------- Fußball
    MATCH_ODDS = "1x2"
    DOUBLE_CHANCE = "double_chance"
    DRAW_NO_BET = "draw_no_bet"
    OVER_UNDER = "over_under"
    BTTS = "btts"
    ASIAN_HANDICAP = "asian_handicap"
    HANDICAP = "handicap"
    CORRECT_SCORE = "correct_score"
    TOTAL_CORNERS = "total_corners"
    TOTAL_CARDS = "total_cards"

    # ----------------------------------------------------------- Tennis
    MATCH_WINNER = "match_winner"
    SET_WINNER = "set_winner"
    GAME_HANDICAP = "game_handicap"
    SET_HANDICAP = "set_handicap"
    OVER_UNDER_GAMES = "over_under_games"
    CORRECT_SET_SCORE = "correct_set_score"

    # ------------------------------------------------------ Sonstiges
    OTHER = "other"


class Period(StrEnum):
    """Marktbezug (Zeitraum/Abschnitt)."""

    FULL_TIME = "full_time"
    FIRST_HALF = "first_half"
    SECOND_HALF = "second_half"
    MATCH = "match"
    SET_1 = "set_1"
    SET_2 = "set_2"
    SET_3 = "set_3"
    SET_4 = "set_4"
    SET_5 = "set_5"
    CURRENT_SET = "current_set"
    CURRENT_GAME = "current_game"


class SelectionCode(StrEnum):
    """Normalisierte Selektionscodes.

    Der Code ist providerunabhängig; das Anzeige-Label (Team-/Spielername)
    steht separat in ``Selection.label``.
    """

    HOME = "home"
    AWAY = "away"
    DRAW = "draw"
    HOME_OR_DRAW = "home_or_draw"
    AWAY_OR_DRAW = "away_or_draw"
    HOME_OR_AWAY = "home_or_away"
    OVER = "over"
    UNDER = "under"
    YES = "yes"
    NO = "no"
    OTHER = "other"


class AlertKind(StrEnum):
    VALUE = "value"
    FIXED_ERROR = "fixed_error"
    ODDS_MOVE = "odds_move"


class ProviderStatus(StrEnum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DEGRADED = "degraded"
    ERROR = "error"
    DISABLED = "disabled"


FOOTBALL_MARKETS: frozenset[MarketType] = frozenset(
    {
        MarketType.MATCH_ODDS,
        MarketType.DOUBLE_CHANCE,
        MarketType.DRAW_NO_BET,
        MarketType.OVER_UNDER,
        MarketType.BTTS,
        MarketType.ASIAN_HANDICAP,
        MarketType.HANDICAP,
        MarketType.CORRECT_SCORE,
        MarketType.TOTAL_CORNERS,
        MarketType.TOTAL_CARDS,
    }
)

TENNIS_MARKETS: frozenset[MarketType] = frozenset(
    {
        MarketType.MATCH_WINNER,
        MarketType.SET_WINNER,
        MarketType.GAME_HANDICAP,
        MarketType.SET_HANDICAP,
        MarketType.OVER_UNDER_GAMES,
        MarketType.CORRECT_SET_SCORE,
    }
)

MARKETS_BY_SPORT: dict[Sport, frozenset[MarketType]] = {
    Sport.FOOTBALL: FOOTBALL_MARKETS,
    Sport.TENNIS: TENNIS_MARKETS,
}

#: Märkte, deren Selektionen sich zu genau 100 % ergänzen (vollständiges Buch).
#: Nur für diese ist eine Margin-Bereinigung über das komplette Buch sauber.
COMPLETE_BOOK_MARKETS: frozenset[MarketType] = frozenset(
    {
        MarketType.MATCH_ODDS,
        MarketType.OVER_UNDER,
        MarketType.BTTS,
        MarketType.DRAW_NO_BET,
        MarketType.MATCH_WINNER,
        MarketType.SET_WINNER,
        MarketType.OVER_UNDER_GAMES,
        MarketType.ASIAN_HANDICAP,
        MarketType.HANDICAP,
        MarketType.GAME_HANDICAP,
        MarketType.SET_HANDICAP,
    }
)

#: Erwartete Anzahl Selektionen je Markt (für Vollständigkeitsprüfung).
EXPECTED_SELECTIONS: dict[MarketType, int] = {
    MarketType.MATCH_ODDS: 3,
    MarketType.OVER_UNDER: 2,
    MarketType.BTTS: 2,
    MarketType.DRAW_NO_BET: 2,
    MarketType.DOUBLE_CHANCE: 3,
    MarketType.ASIAN_HANDICAP: 2,
    MarketType.HANDICAP: 3,
    MarketType.MATCH_WINNER: 2,
    MarketType.SET_WINNER: 2,
    MarketType.OVER_UNDER_GAMES: 2,
    MarketType.GAME_HANDICAP: 2,
    MarketType.SET_HANDICAP: 2,
}

MARKET_LABELS: dict[MarketType, str] = {
    MarketType.MATCH_ODDS: "1X2",
    MarketType.DOUBLE_CHANCE: "Double Chance",
    MarketType.DRAW_NO_BET: "Draw No Bet",
    MarketType.OVER_UNDER: "Over/Under",
    MarketType.BTTS: "Both Teams To Score",
    MarketType.ASIAN_HANDICAP: "Asian Handicap",
    MarketType.HANDICAP: "Handicap",
    MarketType.CORRECT_SCORE: "Correct Score",
    MarketType.TOTAL_CORNERS: "Total Corners",
    MarketType.TOTAL_CARDS: "Total Cards",
    MarketType.MATCH_WINNER: "Match Winner",
    MarketType.SET_WINNER: "Set Winner",
    MarketType.GAME_HANDICAP: "Game Handicap",
    MarketType.SET_HANDICAP: "Set Handicap",
    MarketType.OVER_UNDER_GAMES: "Over/Under Games",
    MarketType.CORRECT_SET_SCORE: "Correct Set Score",
    MarketType.OTHER: "Other",
}
