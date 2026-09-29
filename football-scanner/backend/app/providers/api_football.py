"""API-Football v3 (api-sports.io) adapter: fixtures, statistics, line-ups,
injuries, head-to-head and pre-match odds.

Response shapes follow https://www.api-football.com/documentation-v3.
"""

import logging
import re
from datetime import date, datetime

from app.engine.markets import (
    Market,
    Selection,
    handicap_selection,
    make_selection,
    team_total_selection,
    total_selection,
)
from app.providers.base import (
    EventDTO,
    FixtureDetailsDTO,
    FixtureDTO,
    FixtureRef,
    InjuryDTO,
    LeagueDTO,
    LineupDTO,
    PriceDTO,
    TeamRef,
    TeamStatsDTO,
)
from app.providers.http import ApiClient

log = logging.getLogger(__name__)

FINISHED = {"FT", "AET", "PEN"}
LIVE = {"1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"}


def _int(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(float(str(v).rstrip("%")))
    except ValueError:
        return None


def _float(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(str(v).rstrip("%"))
    except ValueError:
        return None


def parse_fixture(item: dict) -> FixtureDTO:
    fx = item["fixture"]
    league = item.get("league") or {}
    teams = item["teams"]
    goals = item.get("goals") or {}
    score = item.get("score") or {}
    ht = score.get("halftime") or {}
    status = (fx.get("status") or {}).get("short") or "NS"
    home_goals, away_goals = goals.get("home"), goals.get("away")
    # Markets settle on regular time: after extra time use the 90-minute score.
    ft = score.get("fulltime") or {}
    if status in ("AET", "PEN") and ft.get("home") is not None:
        home_goals, away_goals = ft.get("home"), ft.get("away")
    return FixtureDTO(
        id=fx["id"],
        league_id=league.get("id"),
        league_name=league.get("name"),
        country=league.get("country"),
        season=league.get("season"),
        round=league.get("round"),
        kickoff=datetime.fromisoformat(fx["date"]),
        status=status,
        elapsed=(fx.get("status") or {}).get("elapsed"),
        home=TeamRef(teams["home"]["id"], teams["home"]["name"], teams["home"].get("logo")),
        away=TeamRef(teams["away"]["id"], teams["away"]["name"], teams["away"].get("logo")),
        venue=(fx.get("venue") or {}).get("name"),
        referee=fx.get("referee"),
        home_goals=home_goals,
        away_goals=away_goals,
        ht_home_goals=ht.get("home"),
        ht_away_goals=ht.get("away"),
    )


_STAT_FIELDS = {
    "Total Shots": "shots",
    "Shots on Goal": "shots_on_target",
    "Ball Possession": "possession",
    "Corner Kicks": "corners",
    "Yellow Cards": "yellow_cards",
    "Red Cards": "red_cards",
    "Fouls": "fouls",
    "expected_goals": "xg",
}


def _stat_values(stats: list[dict]) -> dict:
    out: dict = {}
    for s in stats or []:
        field = _STAT_FIELDS.get(s.get("type"))
        if field is None:
            continue
        raw = s.get("value")
        out[field] = _float(raw) if field in ("possession", "xg") else _int(raw)
    # The API reports zero cards as null for some leagues; a null next to a
    # populated stats block means none, but with no other stats it means unknown.
    if out and any(v is not None for k, v in out.items() if k not in ("yellow_cards", "red_cards")):
        for card in ("yellow_cards", "red_cards"):
            if out.get(card) is None:
                out[card] = 0
    return out


def parse_team_stats(block: dict) -> TeamStatsDTO:
    values = _stat_values(block.get("statistics") or [])
    fh = _stat_values(block.get("statistics_1h") or [])
    fh_cards = None
    if fh.get("yellow_cards") is not None or fh.get("red_cards") is not None:
        fh_cards = (fh.get("yellow_cards") or 0) + (fh.get("red_cards") or 0)
    return TeamStatsDTO(
        team_id=block["team"]["id"],
        fh_corners=fh.get("corners"),
        fh_cards=fh_cards,
        raw={s.get("type"): s.get("value") for s in block.get("statistics") or []},
        **values,
    )


def parse_details(item: dict) -> FixtureDetailsDTO:
    events = [
        EventDTO(
            team_id=(e.get("team") or {}).get("id"),
            minute=(e.get("time") or {}).get("elapsed"),
            extra=(e.get("time") or {}).get("extra"),
            type=e.get("type") or "",
            detail=e.get("detail"),
            player_id=(e.get("player") or {}).get("id"),
            player_name=(e.get("player") or {}).get("name"),
            assist_id=(e.get("assist") or {}).get("id"),
            assist_name=(e.get("assist") or {}).get("name"),
        )
        for e in item.get("events") or []
    ]
    lineups = [
        LineupDTO(
            team_id=lu["team"]["id"],
            formation=lu.get("formation"),
            coach=(lu.get("coach") or {}).get("name"),
            start_xi=[_player(p) for p in lu.get("startXI") or []],
            substitutes=[_player(p) for p in lu.get("substitutes") or []],
        )
        for lu in item.get("lineups") or []
    ]
    stats = [parse_team_stats(b) for b in item.get("statistics") or [] if b.get("statistics")]
    return FixtureDetailsDTO(
        fixture=parse_fixture(item), stats=stats, events=events, lineups=lineups
    )


def _player(p: dict) -> dict:
    pl = p.get("player") or {}
    return {
        "id": pl.get("id"),
        "name": pl.get("name"),
        "number": pl.get("number"),
        "pos": pl.get("pos"),
    }


# ------------------------------------------------------------------ odds

_VALUE_RE = re.compile(r"^(Over|Under|Home|Away)\s*([+-]?\d+(?:\.\d+)?)$", re.I)


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


# Bet names as API-Football publishes them, normalised.
_BETS = {
    "match winner": "1x2",
    "double chance": "dc",
    "home away": "dnb",
    "draw no bet": "dnb",
    "asian handicap": "ah",
    "goals over under": "goals_total",
    "both teams score": "btts",
    "total home": "home_goals",
    "total away": "away_goals",
    "corners over under": "corners_total",
    "total corners": "corners_total",
    "asian corners": "corners_total",
    "corners asian handicap": "corners_ah",
    "home corners over under": "home_corners",
    "away corners over under": "away_corners",
    "cards over under": "cards_total",
    "asian cards": "cards_total",
    "cards asian handicap": "cards_ah",
    "home team total cards": "home_cards",
    "away team total cards": "away_cards",
}


def parse_bet(bet_name: str, value: str) -> Selection | None:
    """Map one API-Football bet value onto a canonical selection, or ``None``."""
    kind = _BETS.get(_norm(bet_name))
    if kind is None:
        return None
    v = str(value).strip()
    try:
        if kind == "1x2":
            side = {"home": "home", "draw": "draw", "away": "away"}.get(v.lower())
            return make_selection(Market.RESULT_1X2, side) if side else None
        if kind == "dc":
            side = {"home/draw": "1X", "home/away": "12", "draw/away": "X2"}.get(v.lower())
            return make_selection(Market.DOUBLE_CHANCE, side) if side else None
        if kind == "dnb":
            side = v.lower()
            return make_selection(Market.DRAW_NO_BET, side) if side in ("home", "away") else None
        if kind == "btts":
            side = v.lower()
            return make_selection(Market.BTTS, side) if side in ("yes", "no") else None
        m = _VALUE_RE.match(v)
        if not m:
            return None
        word, line = m.group(1).lower(), float(m.group(2))
        if kind in ("ah", "corners_ah", "cards_ah"):
            if word not in ("home", "away"):
                return None
            stat = {"ah": "goals", "corners_ah": "corners", "cards_ah": "cards"}[kind]
            return handicap_selection(stat, word, line)
        if word not in ("over", "under"):
            return None
        if kind in ("goals_total", "corners_total", "cards_total"):
            return total_selection(kind.split("_")[0], word, line)
        team, stat = kind.split("_")
        return team_total_selection(stat, team, word, line)
    except ValueError:
        return None


def parse_odds_item(item: dict) -> list[PriceDTO]:
    out: list[PriceDTO] = []
    for book in item.get("bookmakers") or []:
        name = book.get("name") or str(book.get("id"))
        for bet in book.get("bets") or []:
            for val in bet.get("values") or []:
                odd = _float(val.get("odd"))
                if odd is None or odd <= 1:
                    continue
                sel = parse_bet(bet.get("name") or "", val.get("value") or "")
                if sel is not None:
                    out.append(PriceDTO(selection=sel, bookmaker=name, odds=odd))
    return out


class ApiFootball:
    name = "api_football"

    def __init__(self, client: ApiClient):
        self._c = client

    def _all(self, path: str, params: dict, cache_ttl: int = 0) -> list[dict]:
        data = self._c.get(path, params, cache_ttl=cache_ttl)
        _raise_on_errors(data)
        items = list(data.get("response") or [])
        paging = data.get("paging") or {}
        page, total = paging.get("current", 1), paging.get("total", 1)
        while page < total:
            page += 1
            more = self._c.get(path, {**params, "page": page}, cache_ttl=cache_ttl)
            _raise_on_errors(more)
            items.extend(more.get("response") or [])
        return items

    def leagues(self) -> list[LeagueDTO]:
        out = []
        for item in self._all("/leagues", {"current": "true"}, cache_ttl=86400):
            lg, country = item["league"], item.get("country") or {}
            season = next((s["year"] for s in item.get("seasons") or [] if s.get("current")), None)
            out.append(
                LeagueDTO(
                    lg["id"],
                    lg["name"],
                    country.get("name"),
                    lg.get("logo"),
                    lg.get("type"),
                    season,
                )
            )
        return out

    def fixtures_between(
        self, league_id: int, season: int, start: date, end: date
    ) -> list[FixtureDTO]:
        params = {
            "league": league_id,
            "season": season,
            "from": start.isoformat(),
            "to": end.isoformat(),
        }
        return [parse_fixture(i) for i in self._all("/fixtures", params, cache_ttl=600)]

    def league_season_fixtures(self, league_id: int, season: int) -> list[FixtureDTO]:
        params = {"league": league_id, "season": season}
        return [parse_fixture(i) for i in self._all("/fixtures", params, cache_ttl=3600)]

    def team_last_fixtures(self, team_id: int, last: int) -> list[FixtureDTO]:
        params = {"team": team_id, "last": last}
        return [parse_fixture(i) for i in self._all("/fixtures", params, cache_ttl=3600)]

    def fixture_details(self, ids: list[int]) -> list[FixtureDetailsDTO]:
        out = []
        for i in range(0, len(ids), 20):  # the endpoint takes at most 20 ids
            chunk = ids[i : i + 20]
            data = self._c.get("/fixtures", {"ids": "-".join(str(x) for x in chunk)})
            _raise_on_errors(data)
            out.extend(parse_details(item) for item in data.get("response") or [])
        return out

    def injuries(self, fixture_id: int) -> list[InjuryDTO]:
        out = []
        for item in self._all("/injuries", {"fixture": fixture_id}, cache_ttl=900):
            p = item.get("player") or {}
            if p.get("id") is None:
                continue
            out.append(
                InjuryDTO(
                    fixture_id=fixture_id,
                    team_id=(item.get("team") or {}).get("id"),
                    player_id=p["id"],
                    player_name=p.get("name") or "",
                    type=p.get("type"),
                    reason=p.get("reason"),
                )
            )
        return out

    def head_to_head(self, home_id: int, away_id: int, last: int) -> list[FixtureDTO]:
        params = {"h2h": f"{home_id}-{away_id}", "last": last}
        return [
            parse_fixture(i) for i in self._all("/fixtures/headtohead", params, cache_ttl=21600)
        ]

    def live_fixtures(self) -> list[FixtureDTO]:
        return [parse_fixture(i) for i in self._all("/fixtures", {"live": "all"})]

    # Odds (the same key serves both data and odds on API-Football).
    def prices(self, fixtures: list[FixtureRef]) -> dict[int, list[PriceDTO]]:
        out: dict[int, list[PriceDTO]] = {}
        for fx in fixtures:
            try:
                items = self._all("/odds", {"fixture": fx.id}, cache_ttl=300)
            except Exception as exc:
                log.warning("odds for fixture %s failed: %s", fx.id, exc)
                continue
            prices: list[PriceDTO] = []
            for item in items:
                prices.extend(parse_odds_item(item))
            if prices:
                out[fx.id] = prices
        return out


def _raise_on_errors(data: dict) -> None:
    errors = data.get("errors")
    if errors and (isinstance(errors, dict) and errors or isinstance(errors, list) and errors):
        from app.providers.base import ProviderError

        raise ProviderError(f"api_football error: {errors}")
