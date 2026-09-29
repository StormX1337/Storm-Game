"""The Odds API v4 adapter (https://the-odds-api.com/liveapi/guides/v4/).

Featured markets (h2h, spreads, totals) come from the sport endpoint in one
call per competition; the rest (BTTS, DNB, double chance, team totals,
alternate lines, corners, cards) only exist on the per-event endpoint and
are fetched for fixtures inside the configured window.
"""

import logging
from datetime import datetime

from app.engine.markets import (
    Market,
    Selection,
    handicap_selection,
    make_selection,
    team_total_selection,
    total_selection,
)
from app.providers.base import FixtureRef, PriceDTO
from app.providers.http import ApiClient
from app.providers.names import fixture_match_score, team_similarity

log = logging.getLogger(__name__)

FEATURED_MARKETS = "h2h,spreads,totals"
EXTRA_MARKETS = (
    "btts,draw_no_bet,double_chance,team_totals,alternate_totals,alternate_spreads,"
    "alternate_totals_corners,alternate_spreads_corners,alternate_totals_cards,"
    "alternate_spreads_cards"
)
MATCH_THRESHOLD = 0.72


def _side_for_team(name: str, home: str, away: str) -> str | None:
    sh, sa = team_similarity(name, home), team_similarity(name, away)
    if max(sh, sa) < 0.6:
        return None
    return "home" if sh >= sa else "away"


def parse_outcome(market_key: str, outcome: dict, home: str, away: str) -> Selection | None:
    name = str(outcome.get("name") or "")
    point = outcome.get("point")
    lower = name.lower()
    try:
        if market_key == "h2h":
            if lower == "draw":
                return make_selection(Market.RESULT_1X2, "draw")
            side = _side_for_team(name, home, away)
            return make_selection(Market.RESULT_1X2, side) if side else None
        if market_key == "draw_no_bet":
            side = _side_for_team(name, home, away)
            return make_selection(Market.DRAW_NO_BET, side) if side else None
        if market_key == "double_chance":
            parts = [p.strip() for p in name.replace("/", " or ").split(" or ")]
            if len(parts) != 2:
                return None
            sides = {
                ("draw" if p.lower() == "draw" else _side_for_team(p, home, away)) for p in parts
            }
            key = {
                frozenset({"home", "draw"}): "1X",
                frozenset({"home", "away"}): "12",
                frozenset({"draw", "away"}): "X2",
            }.get(frozenset(sides))
            return make_selection(Market.DOUBLE_CHANCE, key) if key else None
        if market_key == "btts":
            return make_selection(Market.BTTS, lower) if lower in ("yes", "no") else None
        if point is None:
            return None
        line = float(point)
        stat = (
            "corners"
            if market_key.endswith("_corners")
            else "cards"
            if market_key.endswith("_cards")
            else "goals"
        )
        if market_key in (
            "totals",
            "alternate_totals",
            "alternate_totals_corners",
            "alternate_totals_cards",
        ):
            return total_selection(stat, lower, line) if lower in ("over", "under") else None
        if market_key in (
            "spreads",
            "alternate_spreads",
            "alternate_spreads_corners",
            "alternate_spreads_cards",
        ):
            side = _side_for_team(name, home, away)
            return handicap_selection(stat, side, line) if side else None
        if market_key == "team_totals":
            team = _side_for_team(str(outcome.get("description") or ""), home, away)
            if team is None or lower not in ("over", "under"):
                return None
            return team_total_selection("goals", team, lower, line)
    except ValueError:
        return None
    return None


def parse_event(event: dict) -> list[PriceDTO]:
    home, away = event.get("home_team") or "", event.get("away_team") or ""
    out: list[PriceDTO] = []
    for book in event.get("bookmakers") or []:
        title = book.get("title") or book.get("key") or "?"
        for market in book.get("markets") or []:
            for outcome in market.get("outcomes") or []:
                price = outcome.get("price")
                if not isinstance(price, int | float) or price <= 1:
                    continue
                sel = parse_outcome(market.get("key") or "", outcome, home, away)
                if sel is not None:
                    out.append(PriceDTO(selection=sel, bookmaker=title, odds=float(price)))
    return out


class TheOddsApi:
    name = "the_odds_api"

    def __init__(self, client: ApiClient, regions: str = "eu", fetch_extra_markets: bool = True):
        self._c = client
        self._regions = regions
        self._extra = fetch_extra_markets

    def sports(self) -> list[dict]:
        return self._c.get("/sports", {"all": "false"}, cache_ttl=86400)

    def prices(self, fixtures: list[FixtureRef]) -> dict[int, list[PriceDTO]]:
        out: dict[int, list[PriceDTO]] = {}
        by_key: dict[str, list[FixtureRef]] = {}
        for fx in fixtures:
            if fx.odds_key:
                by_key.setdefault(fx.odds_key, []).append(fx)
        for sport_key, refs in by_key.items():
            try:
                events = self._c.get(
                    f"/sports/{sport_key}/odds",
                    {
                        "regions": self._regions,
                        "markets": FEATURED_MARKETS,
                        "oddsFormat": "decimal",
                    },
                    cache_ttl=240,
                )
            except Exception as exc:
                log.warning("odds for %s failed: %s", sport_key, exc)
                continue
            for ref in refs:
                event = match_event(ref, events)
                if event is None:
                    continue
                prices = parse_event(event)
                if self._extra:
                    try:
                        detail = self._c.get(
                            f"/sports/{sport_key}/events/{event['id']}/odds",
                            {
                                "regions": self._regions,
                                "markets": EXTRA_MARKETS,
                                "oddsFormat": "decimal",
                            },
                            cache_ttl=240,
                        )
                        prices.extend(parse_event(detail))
                    except Exception as exc:
                        log.info("extra markets for %s unavailable: %s", event.get("id"), exc)
                if prices:
                    out[ref.id] = prices
        return out


def match_event(ref: FixtureRef, events: list[dict]) -> dict | None:
    best, best_score = None, 0.0
    for ev in events:
        if ref.odds_event_id and ev.get("id") == ref.odds_event_id:
            return ev
        try:
            kickoff = datetime.fromisoformat(str(ev["commence_time"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        score = fixture_match_score(
            ref.home_name,
            ref.away_name,
            ref.kickoff,
            ev.get("home_team", ""),
            ev.get("away_team", ""),
            kickoff,
        )
        if score > best_score:
            best, best_score = ev, score
    return best if best_score >= MATCH_THRESHOLD else None
