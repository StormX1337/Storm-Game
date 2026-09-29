"""Adapters against the vendors' documented response shapes."""

import httpx
import pytest

from app.engine.markets import Market
from app.providers.api_football import ApiFootball, parse_bet, parse_details, parse_odds_item
from app.providers.base import ProviderError
from app.providers.http import ApiClient
from app.providers.names import normalize_team, team_similarity
from app.providers.the_odds_api import match_event, parse_event

AF_FIXTURE = {
    "fixture": {
        "id": 1208021,
        "referee": "Michael Oliver, England",
        "date": "2026-09-19T14:00:00+00:00",
        "venue": {"name": "Emirates Stadium"},
        "status": {"short": "FT", "elapsed": 90},
    },
    "league": {
        "id": 39,
        "name": "Premier League",
        "country": "England",
        "season": 2026,
        "round": "Regular Season - 5",
    },
    "teams": {
        "home": {"id": 42, "name": "Arsenal", "logo": "a.png"},
        "away": {"id": 49, "name": "Chelsea", "logo": "c.png"},
    },
    "goals": {"home": 2, "away": 1},
    "score": {"halftime": {"home": 1, "away": 0}, "fulltime": {"home": 2, "away": 1}},
    "events": [
        {
            "time": {"elapsed": 23, "extra": None},
            "team": {"id": 42},
            "player": {"id": 1, "name": "Saka"},
            "assist": {"id": 2, "name": "Odegaard"},
            "type": "Goal",
            "detail": "Normal Goal",
        },
        {
            "time": {"elapsed": 60, "extra": None},
            "team": {"id": 49},
            "player": {"id": 9, "name": "Palmer"},
            "assist": {"id": None, "name": None},
            "type": "Card",
            "detail": "Yellow Card",
        },
    ],
    "lineups": [
        {
            "team": {"id": 42},
            "formation": "4-3-3",
            "coach": {"name": "Arteta"},
            "startXI": [{"player": {"id": 1, "name": "Saka", "number": 7, "pos": "F"}}],
            "substitutes": [],
        },
    ],
    "statistics": [
        {
            "team": {"id": 42},
            "statistics": [
                {"type": "Shots on Goal", "value": 6},
                {"type": "Total Shots", "value": 15},
                {"type": "Ball Possession", "value": "58%"},
                {"type": "Corner Kicks", "value": 7},
                {"type": "Yellow Cards", "value": None},
                {"type": "Red Cards", "value": None},
                {"type": "Fouls", "value": 9},
                {"type": "expected_goals", "value": "1.84"},
            ],
        },
        {
            "team": {"id": 49},
            "statistics": [
                {"type": "Shots on Goal", "value": 3},
                {"type": "Total Shots", "value": 9},
                {"type": "Ball Possession", "value": "42%"},
                {"type": "Corner Kicks", "value": 3},
                {"type": "Yellow Cards", "value": 2},
                {"type": "Red Cards", "value": None},
                {"type": "Fouls", "value": 13},
                {"type": "expected_goals", "value": "0.91"},
            ],
        },
    ],
}


def test_api_football_fixture_details():
    d = parse_details(AF_FIXTURE)
    assert d.fixture.id == 1208021 and d.fixture.status == "FT"
    assert (d.fixture.home_goals, d.fixture.away_goals) == (2, 1)
    assert (d.fixture.ht_home_goals, d.fixture.ht_away_goals) == (1, 0)
    home, away = d.stats
    assert home.corners == 7 and home.possession == 58.0 and home.xg == pytest.approx(1.84)
    # Null cards next to a populated stats block mean zero cards.
    assert home.yellow_cards == 0 and away.yellow_cards == 2 and away.red_cards == 0
    assert d.events[0].assist_name == "Odegaard"
    assert d.lineups[0].formation == "4-3-3" and d.lineups[0].start_xi[0]["pos"] == "F"


def test_extra_time_uses_ninety_minute_score():
    item = {
        **AF_FIXTURE,
        "fixture": {**AF_FIXTURE["fixture"], "status": {"short": "AET"}},
        "goals": {"home": 3, "away": 1},
        "score": {"halftime": {}, "fulltime": {"home": 1, "away": 1}},
    }
    d = parse_details(item)
    assert (d.fixture.home_goals, d.fixture.away_goals) == (1, 1)


@pytest.mark.parametrize(
    "bet,value,market,side,line,team",
    [
        ("Match Winner", "Home", Market.RESULT_1X2, "home", None, None),
        ("Double Chance", "Draw/Away", Market.DOUBLE_CHANCE, "X2", None, None),
        ("Home/Away", "Away", Market.DRAW_NO_BET, "away", 0.0, None),
        ("Goals Over/Under", "Over 2.5", Market.OVER_UNDER, "over", 2.5, None),
        ("Goals Over/Under", "Under 2.25", Market.ASIAN_TOTAL, "under", 2.25, None),
        ("Asian Handicap", "Home -0.75", Market.ASIAN_HANDICAP, "home", -0.75, None),
        ("Asian Handicap", "Away +1", Market.ASIAN_HANDICAP, "away", 1.0, None),
        ("Both Teams Score", "Yes", Market.BTTS, "yes", None, None),
        ("Total - Home", "Over 1.5", Market.TEAM_GOALS, "over", 1.5, "home"),
        ("Corners Over Under", "Over 9.5", Market.CORNERS_OU, "over", 9.5, None),
        ("Asian Corners", "Under 10", Market.ASIAN_CORNERS, "under", 10.0, None),
        ("Cards Over/Under", "Over 4.5", Market.CARDS_OU, "over", 4.5, None),
    ],
)
def test_api_football_bets(bet, value, market, side, line, team):
    sel = parse_bet(bet, value)
    assert sel is not None
    assert (sel.market, sel.side, sel.line, sel.team) == (market, side, line, team)


def test_unknown_bets_are_ignored_not_guessed():
    assert parse_bet("Handicap Result", "Home -1") is None
    assert parse_bet("Exact Score", "1:0") is None
    assert parse_bet("Goals Over/Under", "Over 2.3") is None


def test_api_football_odds_item():
    item = {
        "bookmakers": [
            {
                "id": 8,
                "name": "Bet365",
                "bets": [
                    {
                        "id": 1,
                        "name": "Match Winner",
                        "values": [
                            {"value": "Home", "odd": "2.10"},
                            {"value": "Draw", "odd": "3.40"},
                        ],
                    },
                    {"id": 99, "name": "Something Else", "values": [{"value": "X", "odd": "5.0"}]},
                ],
            }
        ]
    }
    prices = parse_odds_item(item)
    assert [(p.selection.side, p.odds, p.bookmaker) for p in prices] == [
        ("home", 2.1, "Bet365"),
        ("draw", 3.4, "Bet365"),
    ]


ODDS_EVENT = {
    "id": "e1",
    "commence_time": "2026-09-28T19:00:00Z",
    "home_team": "Arsenal",
    "away_team": "Chelsea",
    "bookmakers": [
        {
            "key": "pinnacle",
            "title": "Pinnacle",
            "markets": [
                {
                    "key": "h2h",
                    "outcomes": [
                        {"name": "Arsenal", "price": 2.05},
                        {"name": "Chelsea", "price": 3.6},
                        {"name": "Draw", "price": 3.5},
                    ],
                },
                {
                    "key": "spreads",
                    "outcomes": [
                        {"name": "Arsenal", "price": 1.95, "point": -0.5},
                        {"name": "Chelsea", "price": 1.9, "point": 0.5},
                    ],
                },
                {
                    "key": "totals",
                    "outcomes": [
                        {"name": "Over", "price": 1.85, "point": 2.5},
                        {"name": "Under", "price": 2.0, "point": 2.5},
                    ],
                },
                {
                    "key": "btts",
                    "outcomes": [{"name": "Yes", "price": 1.7}, {"name": "No", "price": 2.1}],
                },
                {
                    "key": "double_chance",
                    "outcomes": [
                        {"name": "Arsenal or Draw", "price": 1.3},
                        {"name": "Draw or Chelsea", "price": 1.75},
                    ],
                },
                {
                    "key": "team_totals",
                    "outcomes": [
                        {"name": "Over", "description": "Chelsea", "price": 2.2, "point": 1.5}
                    ],
                },
                {
                    "key": "alternate_totals_corners",
                    "outcomes": [{"name": "Over", "price": 1.9, "point": 9.5}],
                },
                {
                    "key": "alternate_spreads_cards",
                    "outcomes": [{"name": "Chelsea", "price": 1.8, "point": -0.5}],
                },
            ],
        },
    ],
}


def test_the_odds_api_event():
    got = {(p.selection.key, p.odds) for p in parse_event(ODDS_EVENT)}
    assert ("1x2:home::", 2.05) in got
    assert ("1x2:draw::", 3.5) in got
    assert ("asian_handicap:home::-0.5", 1.95) in got
    assert ("over_under:over::2.5", 1.85) in got
    assert ("btts:yes::", 1.7) in got
    assert ("double_chance:1X::", 1.3) in got
    assert ("double_chance:X2::", 1.75) in got
    assert ("team_goals:over:away:1.5", 2.2) in got
    assert ("corners_ou:over::9.5", 1.9) in got
    assert ("asian_cards:away::-0.5", 1.8) in got


def test_event_matching_tolerates_spelling():
    from datetime import UTC, datetime

    from app.providers.base import FixtureRef

    ref = FixtureRef(
        1, 39, 2026, datetime(2026, 9, 28, 19, 0, tzinfo=UTC), "Arsenal FC", "Chelsea FC"
    )
    assert match_event(ref, [ODDS_EVENT])["id"] == "e1"
    far = FixtureRef(1, 39, 2026, datetime(2026, 9, 29, 19, 0, tzinfo=UTC), "Arsenal", "Chelsea")
    assert match_event(far, [ODDS_EVENT]) is None
    other = FixtureRef(1, 39, 2026, datetime(2026, 9, 28, 19, 0, tzinfo=UTC), "Everton", "Fulham")
    assert match_event(other, [ODDS_EVENT]) is None


def test_name_normalisation():
    assert normalize_team("Club Atlético Peñarol") == "atletico penarol"
    assert team_similarity("Manchester United", "Man United") > 0.7
    assert team_similarity("Arsenal", "Chelsea") < 0.5


def test_client_retries_and_counts_usage(monkeypatch):
    calls = {"n": 0}
    usage = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503)
        return httpx.Response(
            200,
            json={"response": [], "paging": {"current": 1, "total": 1}},
            headers={"x-ratelimit-requests-remaining": "99"},
        )

    monkeypatch.setattr("time.sleep", lambda s: None)
    c = ApiClient(
        "api_football",
        "https://example.test",
        transport=httpx.MockTransport(handler),
        usage_hook=lambda *a: usage.append(a),
        remaining_header="x-ratelimit-requests-remaining",
    )
    assert ApiFootball(c).live_fixtures() == []
    assert calls["n"] == 2
    assert usage[-1] == ("api_football", "/fixtures", True, 99)
    assert usage[0][2] is False


def test_provider_errors_surface():
    def handler(request):
        return httpx.Response(200, json={"errors": {"token": "invalid key"}, "response": []})

    c = ApiClient("api_football", "https://example.test", transport=httpx.MockTransport(handler))
    with pytest.raises(ProviderError):
        ApiFootball(c).live_fixtures()
