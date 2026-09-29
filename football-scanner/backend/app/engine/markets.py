"""Market catalogue, selection pricing and settlement.

A selection is priced and settled by the same function: pricing feeds it the
model's distribution, settlement feeds it the one outcome that happened. That
is what guarantees a quarter-line Asian bet is graded exactly the way it was
priced.
"""

from dataclasses import dataclass
from enum import StrEnum

from app.engine.joint import JointDistribution


class Market(StrEnum):
    RESULT_1X2 = "1x2"
    DOUBLE_CHANCE = "double_chance"
    DRAW_NO_BET = "dnb"
    ASIAN_HANDICAP = "asian_handicap"
    ASIAN_TOTAL = "asian_total"
    OVER_UNDER = "over_under"
    BTTS = "btts"
    TEAM_GOALS = "team_goals"
    CORNERS_OU = "corners_ou"
    ASIAN_CORNERS = "asian_corners"
    TEAM_CORNERS = "team_corners"
    CARDS_OU = "cards_ou"
    ASIAN_CARDS = "asian_cards"
    TEAM_CARDS = "team_cards"


MARKET_LABELS: dict[Market, str] = {
    Market.RESULT_1X2: "1X2",
    Market.DOUBLE_CHANCE: "Double Chance",
    Market.DRAW_NO_BET: "Draw No Bet",
    Market.ASIAN_HANDICAP: "Asian Handicap",
    Market.ASIAN_TOTAL: "Asian Total",
    Market.OVER_UNDER: "Over/Under Goals",
    Market.BTTS: "BTTS",
    Market.TEAM_GOALS: "Team Goals",
    Market.CORNERS_OU: "Over/Under Corners",
    Market.ASIAN_CORNERS: "Asian Corners",
    Market.TEAM_CORNERS: "Team Corners",
    Market.CARDS_OU: "Over/Under Cards",
    Market.ASIAN_CARDS: "Asian Cards",
    Market.TEAM_CARDS: "Team Cards",
}

# History and scanner grouping. Integer and quarter lines are Asian whatever
# they count, which is how the spec groups Asian corners and cards.
CATEGORY_OF: dict[Market, str] = {
    Market.RESULT_1X2: "1X2",
    Market.DOUBLE_CHANCE: "1X2",
    Market.DRAW_NO_BET: "1X2",
    Market.ASIAN_HANDICAP: "ASIAN",
    Market.ASIAN_TOTAL: "ASIAN",
    Market.OVER_UNDER: "GOALS",
    Market.BTTS: "BTTS",
    Market.TEAM_GOALS: "GOALS",
    Market.CORNERS_OU: "CORNERS",
    Market.ASIAN_CORNERS: "ASIAN",
    Market.TEAM_CORNERS: "CORNERS",
    Market.CARDS_OU: "CARDS",
    Market.ASIAN_CARDS: "ASIAN",
    Market.TEAM_CARDS: "CARDS",
}

# Match page tab each market is shown on.
TAB_OF: dict[Market, str] = {
    Market.RESULT_1X2: "RESULT",
    Market.DOUBLE_CHANCE: "RESULT",
    Market.DRAW_NO_BET: "RESULT",
    Market.ASIAN_HANDICAP: "ASIAN",
    Market.ASIAN_TOTAL: "ASIAN",
    Market.OVER_UNDER: "GOALS",
    Market.BTTS: "GOALS",
    Market.TEAM_GOALS: "GOALS",
    Market.CORNERS_OU: "CORNERS",
    Market.ASIAN_CORNERS: "ASIAN",
    Market.TEAM_CORNERS: "CORNERS",
    Market.CARDS_OU: "CARDS",
    Market.ASIAN_CARDS: "ASIAN",
    Market.TEAM_CARDS: "CARDS",
}

STAT_OF: dict[Market, str] = {
    Market.RESULT_1X2: "goals",
    Market.DOUBLE_CHANCE: "goals",
    Market.DRAW_NO_BET: "goals",
    Market.ASIAN_HANDICAP: "goals",
    Market.ASIAN_TOTAL: "goals",
    Market.OVER_UNDER: "goals",
    Market.BTTS: "goals",
    Market.TEAM_GOALS: "goals",
    Market.CORNERS_OU: "corners",
    Market.ASIAN_CORNERS: "corners",
    Market.TEAM_CORNERS: "corners",
    Market.CARDS_OU: "cards",
    Market.ASIAN_CARDS: "cards",
    Market.TEAM_CARDS: "cards",
}


class Kind(StrEnum):
    RESULT = "result"  # 1X2 / double chance
    TOTAL = "total"  # over/under on the match total
    HANDICAP = "handicap"  # on the margin; DNB is handicap 0
    TEAM_TOTAL = "team_total"
    BTTS = "btts"


class Outcome(StrEnum):
    WIN = "won"
    HALF_WIN = "half_won"
    PUSH = "push"
    HALF_LOSS = "half_lost"
    LOSS = "lost"


@dataclass(frozen=True)
class Selection:
    market: Market
    kind: Kind
    side: str  # home/draw/away/1X/12/X2/over/under/yes/no
    line: float | None = None
    team: str | None = None  # home/away for team totals

    @property
    def stat(self) -> str:
        return STAT_OF[self.market]

    @property
    def key(self) -> str:
        line = "" if self.line is None else _fmt_line(self.line)
        return f"{self.market.value}:{self.side}:{self.team or ''}:{line}"

    @classmethod
    def from_key(cls, key: str) -> "Selection":
        market_s, side, team, line_s = key.split(":")
        market = Market(market_s)
        line = float(line_s) if line_s else None
        return make_selection(market, side, line, team or None)

    def label(self) -> str:
        noun = {"goals": "", "corners": " corners", "cards": " cards"}[self.stat]
        if self.kind is Kind.RESULT:
            return {
                "home": "Home",
                "draw": "Draw",
                "away": "Away",
                "1X": "1X",
                "12": "12",
                "X2": "X2",
            }[self.side]
        if self.kind is Kind.BTTS:
            return "BTTS Yes" if self.side == "yes" else "BTTS No"
        if self.kind is Kind.HANDICAP:
            if self.market is Market.DRAW_NO_BET:
                return f"{self.side.title()} DNB"
            return f"{self.side.title()} {_signed(self.line)}{noun}"
        if self.kind is Kind.TEAM_TOTAL:
            return f"{(self.team or '').title()} {self.side.title()} {_fmt_line(self.line)}{noun}"
        return f"{self.side.title()} {_fmt_line(self.line)}{noun}"


def is_asian_line(line: float) -> bool:
    """Integer and quarter lines can push or half-settle; x.5 lines cannot."""
    return (line * 2) % 2 != 1


def make_selection(
    market: Market, side: str, line: float | None = None, team: str | None = None
) -> Selection:
    kind = {
        Market.RESULT_1X2: Kind.RESULT,
        Market.DOUBLE_CHANCE: Kind.RESULT,
        Market.DRAW_NO_BET: Kind.HANDICAP,
        Market.ASIAN_HANDICAP: Kind.HANDICAP,
        Market.ASIAN_TOTAL: Kind.TOTAL,
        Market.OVER_UNDER: Kind.TOTAL,
        Market.BTTS: Kind.BTTS,
        Market.TEAM_GOALS: Kind.TEAM_TOTAL,
        Market.CORNERS_OU: Kind.TOTAL,
        Market.TEAM_CORNERS: Kind.TEAM_TOTAL,
        Market.CARDS_OU: Kind.TOTAL,
        Market.TEAM_CARDS: Kind.TEAM_TOTAL,
    }.get(market)
    if market in (Market.ASIAN_CORNERS, Market.ASIAN_CARDS):
        kind = Kind.HANDICAP if side in ("home", "away") else Kind.TOTAL
    if kind is None:
        raise ValueError(f"unknown market {market}")
    if market is Market.DRAW_NO_BET:
        line = 0.0
    _validate(market, kind, side, line, team)
    return Selection(market=market, kind=kind, side=side, line=line, team=team)


def _validate(market: Market, kind: Kind, side: str, line: float | None, team: str | None):
    allowed = {
        Kind.RESULT: {"home", "draw", "away"}
        if market is Market.RESULT_1X2
        else {"1X", "12", "X2"},
        Kind.TOTAL: {"over", "under"},
        Kind.HANDICAP: {"home", "away"},
        Kind.TEAM_TOTAL: {"over", "under"},
        Kind.BTTS: {"yes", "no"},
    }[kind]
    if side not in allowed:
        raise ValueError(f"invalid side {side!r} for {market}")
    if kind in (Kind.TOTAL, Kind.HANDICAP, Kind.TEAM_TOTAL):
        if line is None:
            raise ValueError(f"{market} needs a line")
        if (line * 4) % 1 != 0:
            raise ValueError(f"line {line} is not a quarter line")
    if kind is Kind.TEAM_TOTAL and team not in ("home", "away"):
        raise ValueError("team totals need team=home|away")
    if kind is Kind.TOTAL and line is not None:
        asian_market = market in (Market.ASIAN_TOTAL, Market.ASIAN_CORNERS, Market.ASIAN_CARDS)
        if asian_market != is_asian_line(line):
            raise ValueError(f"line {line} does not belong to {market}")


def total_selection(stat: str, side: str, line: float) -> Selection:
    """Match-total selection; the line decides between classic and Asian."""
    asian = is_asian_line(line)
    market = {
        "goals": Market.ASIAN_TOTAL if asian else Market.OVER_UNDER,
        "corners": Market.ASIAN_CORNERS if asian else Market.CORNERS_OU,
        "cards": Market.ASIAN_CARDS if asian else Market.CARDS_OU,
    }[stat]
    return make_selection(market, side, line)


def handicap_selection(stat: str, side: str, line: float) -> Selection:
    market = {
        "goals": Market.ASIAN_HANDICAP,
        "corners": Market.ASIAN_CORNERS,
        "cards": Market.ASIAN_CARDS,
    }[stat]
    return make_selection(market, side, line)


def team_total_selection(stat: str, team: str, side: str, line: float) -> Selection:
    market = {
        "goals": Market.TEAM_GOALS,
        "corners": Market.TEAM_CORNERS,
        "cards": Market.TEAM_CARDS,
    }[stat]
    return make_selection(market, side, line, team)


@dataclass(frozen=True)
class OutcomeProbabilities:
    win: float
    half_win: float
    push: float
    half_loss: float
    loss: float

    @property
    def effective_probability(self) -> float:
        """Win probability of the stake that is not refunded.

        Half outcomes are half a push. With this definition fair odds are
        exactly ``1 / p`` and EV is ``active * (p * odds - 1)``, which reduces
        to the textbook ``p * odds - 1`` on any line that cannot push.
        """
        won = self.win + 0.5 * self.half_win
        lost = self.loss + 0.5 * self.half_loss
        if won + lost <= 0:
            return 0.0
        return won / (won + lost)

    @property
    def active_fraction(self) -> float:
        return self.win + self.loss + 0.5 * (self.half_win + self.half_loss)

    def expected_value(self, odds: float) -> float:
        return (
            self.win * (odds - 1) + self.half_win * (odds - 1) / 2 - self.half_loss / 2 - self.loss
        )


def _component_lines(line: float) -> list[float]:
    if (line * 4) % 2 == 1:  # quarter line: split stake over the two neighbours
        return [line - 0.25, line + 0.25]
    return [line]


def _grade(values: list[float]) -> Outcome:
    signs = [0 if abs(v) < 1e-9 else (1 if v > 0 else -1) for v in values]
    if len(signs) == 1:
        return {1: Outcome.WIN, 0: Outcome.PUSH, -1: Outcome.LOSS}[signs[0]]
    score = sum(signs)
    if score == 2:
        return Outcome.WIN
    if score == -2:
        return Outcome.LOSS
    if sorted(signs) == [0, 1]:
        return Outcome.HALF_WIN
    if sorted(signs) == [-1, 0]:
        return Outcome.HALF_LOSS
    return Outcome.PUSH


def grade(selection: Selection, home: int, away: int) -> Outcome:
    """Grade a selection against final counts of its stat."""
    kind = selection.kind
    side = selection.side
    if kind is Kind.RESULT:
        hit = {
            "home": home > away,
            "draw": home == away,
            "away": away > home,
            "1X": home >= away,
            "12": home != away,
            "X2": away >= home,
        }[side]
        return Outcome.WIN if hit else Outcome.LOSS
    if kind is Kind.BTTS:
        both = home > 0 and away > 0
        return Outcome.WIN if both == (side == "yes") else Outcome.LOSS
    assert selection.line is not None
    lines = _component_lines(selection.line)
    if kind is Kind.HANDICAP:
        margin = home - away if side == "home" else away - home
        return _grade([margin + ln for ln in lines])
    value = home + away if kind is Kind.TOTAL else (home if selection.team == "home" else away)
    if side == "over":
        return _grade([value - ln for ln in lines])
    return _grade([ln - value for ln in lines])


def price(selection: Selection, joint: JointDistribution) -> OutcomeProbabilities:
    buckets = {o: 0.0 for o in Outcome}
    for h, a, p in joint.cells():
        if p:
            buckets[grade(selection, h, a)] += p
    return OutcomeProbabilities(
        win=buckets[Outcome.WIN],
        half_win=buckets[Outcome.HALF_WIN],
        push=buckets[Outcome.PUSH],
        half_loss=buckets[Outcome.HALF_LOSS],
        loss=buckets[Outcome.LOSS],
    )


def profit_units(outcome: Outcome, odds: float) -> float:
    return {
        Outcome.WIN: odds - 1,
        Outcome.HALF_WIN: (odds - 1) / 2,
        Outcome.PUSH: 0.0,
        Outcome.HALF_LOSS: -0.5,
        Outcome.LOSS: -1.0,
    }[outcome]


def _fmt_line(line: float | None) -> str:
    if line is None:
        return ""
    return f"{line:g}"


def _signed(line: float | None) -> str:
    if line is None:
        return ""
    if line == 0:
        return "0"
    return f"{line:+g}"
