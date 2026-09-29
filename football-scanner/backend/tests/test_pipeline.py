"""End to end: provider DTOs -> database -> engine -> API -> settlement.

The provider below is a test double implementing the provider interfaces; it
lives only in the test suite.
"""

import random
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.engine.markets import Market, make_selection
from app.models import Fixture, League, OddsSnapshot, Signal
from app.providers.base import (
    FixtureDetailsDTO,
    FixtureDTO,
    InjuryDTO,
    LeagueDTO,
    LineupDTO,
    PriceDTO,
    TeamRef,
    TeamStatsDTO,
)
from app.services import analysis_service, settlement, sync

NOW = datetime.now(UTC).replace(microsecond=0)
KICKOFF = NOW + timedelta(hours=20)
TEAMS = [TeamRef(i, f"Team {i}") for i in range(1, 9)]
HOME, AWAY = TEAMS[0], TEAMS[1]


def _history() -> list[FixtureDetailsDTO]:
    rng = random.Random(7)
    out, fid = [], 5000
    for week in range(1, 16):
        order = TEAMS[:]
        rng.shuffle(order)
        for i in range(0, len(order), 2):
            h, a = order[i], order[i + 1]
            # Team 1 is strong, team 2 is weak.
            hg = rng.choice([0, 1, 1, 2, 2, 3]) + (1 if h is HOME else 0)
            ag = (
                rng.choice([0, 1, 1, 2])
                + (1 if a is HOME else 0)
                - (1 if a is AWAY and rng.random() < 0.5 else 0)
            )
            ag = max(0, ag)
            fid += 1
            fx = FixtureDTO(
                id=fid,
                league_id=39,
                league_name="Test League",
                country="Testland",
                season=2026,
                round=f"R{week}",
                kickoff=NOW - timedelta(days=7 * week),
                status="FT",
                elapsed=90,
                home=h,
                away=a,
                referee=rng.choice(["Ref One, Testland", "Ref Two, Testland"]),
                home_goals=hg,
                away_goals=ag,
                ht_home_goals=min(hg, 1),
                ht_away_goals=0,
            )
            stats = [
                TeamStatsDTO(
                    team_id=h.id,
                    shots=12,
                    shots_on_target=5,
                    possession=55.0,
                    corners=rng.randint(3, 8),
                    yellow_cards=rng.randint(0, 3),
                    red_cards=0,
                    fouls=11,
                    xg=round(hg * 0.8 + 0.4, 2),
                ),
                TeamStatsDTO(
                    team_id=a.id,
                    shots=9,
                    shots_on_target=3,
                    possession=45.0,
                    corners=rng.randint(2, 7),
                    yellow_cards=rng.randint(1, 3),
                    red_cards=0,
                    fouls=12,
                    xg=round(ag * 0.8 + 0.3, 2),
                ),
            ]
            lineups = [
                LineupDTO(
                    team_id=h.id,
                    formation="4-3-3",
                    coach=None,
                    start_xi=[{"id": h.id * 100 + 1, "name": "Keeper", "pos": "G"}],
                    substitutes=[],
                ),
            ]
            out.append(FixtureDetailsDTO(fixture=fx, stats=stats, events=[], lineups=lineups))
    return out


HISTORY = _history()
UPCOMING = FixtureDTO(
    id=9001,
    league_id=39,
    league_name="Test League",
    country="Testland",
    season=2026,
    round="R16",
    kickoff=KICKOFF,
    status="NS",
    elapsed=None,
    home=HOME,
    away=AWAY,
    referee="Ref One, Testland",
)


class FakeData:
    name = "fake"

    def leagues(self):
        return [LeagueDTO(39, "Test League", "Testland", None, "League", 2026)]

    def fixtures_between(self, league_id, season, start, end):
        return [UPCOMING]

    def league_season_fixtures(self, league_id, season):
        return [d.fixture for d in HISTORY] if season == 2026 else []

    def team_last_fixtures(self, team_id, last):
        return [d.fixture for d in HISTORY if team_id in (d.fixture.home.id, d.fixture.away.id)][
            :last
        ]

    def fixture_details(self, ids):
        by_id = {d.fixture.id: d for d in HISTORY}
        return [by_id[i] for i in ids if i in by_id]

    def injuries(self, fixture_id):
        return [
            InjuryDTO(fixture_id, AWAY.id, 777, "Injured Player", "Missing Fixture", "Knee Injury")
        ]

    def head_to_head(self, home_id, away_id, last):
        return []

    def live_fixtures(self):
        return []


class FakeOdds:
    name = "fake_odds"

    def __init__(self, over_price: float):
        self.over_price = over_price

    def prices(self, fixtures):
        sel_over = make_selection(Market.OVER_UNDER, "over", 2.5)
        sel_under = make_selection(Market.OVER_UNDER, "under", 2.5)
        home = make_selection(Market.RESULT_1X2, "home")
        draw = make_selection(Market.RESULT_1X2, "draw")
        away = make_selection(Market.RESULT_1X2, "away")
        out = []
        for book, bump in (("BookA", 0.0), ("BookB", -0.03), ("BookC", -0.05)):
            out += [
                PriceDTO(sel_over, book, round(self.over_price + bump, 2)),
                PriceDTO(sel_under, book, round(1.95 + bump, 2)),
                PriceDTO(home, book, round(1.6 + bump, 2)),
                PriceDTO(draw, book, round(4.0 + bump, 2)),
                PriceDTO(away, book, round(5.5 + bump, 2)),
            ]
        return {f.id: out for f in fixtures}


@pytest.fixture
def loaded(db):
    data = FakeData()
    sync.upsert_leagues(db, data.leagues())
    db.get(League, 39).enabled = True
    db.commit()
    sync.sync_fixtures(db, data, days_ahead=2)
    sync.sync_league_history(db, data)
    sync.sync_team_history(db, data, days_ahead=2, last=15)
    sync.sync_injuries(db, data)
    sync.sync_odds(db, FakeOdds(2.10), days_ahead=2)
    sync.sync_odds(db, FakeOdds(2.30), days_ahead=2)  # the price drifts
    sync.sync_odds(db, FakeOdds(2.30), days_ahead=2)  # unchanged: no new rows
    analysis_service.run_analysis(db, days_ahead=2)
    return db


def test_sync_stores_history_and_price_changes_only(loaded):
    db = loaded
    assert db.get(Fixture, 9001) is not None
    detailed = db.scalars(select(Fixture).where(Fixture.details_synced_at.is_not(None))).all()
    assert len(detailed) == len(HISTORY)
    key = make_selection(Market.OVER_UNDER, "over", 2.5).key
    rows = db.scalars(
        select(OddsSnapshot).where(
            OddsSnapshot.selection_key == key, OddsSnapshot.bookmaker == "BookA"
        )
    ).all()
    assert [r.odds for r in rows] == [2.1, 2.3]
    assert rows[-1].last_seen_at > rows[-1].captured_at


def test_analysis_prices_every_stat_and_explains_absences(loaded, admin_client):
    detail = admin_client.get("/api/matches/9001").json()
    a = detail["analysis"]
    assert {k for k, v in a["stats"].items() if v["status"] == "OK"} == {
        "goals",
        "corners",
        "cards",
    }
    assert a["stats"]["goals"]["lambda_home"] > a["stats"]["goals"]["lambda_away"]
    assert {m["name"] for m in a["stats"]["goals"]["models"]} == {"season", "form", "xg"}
    ctx = a["context"]
    assert ctx["away_squad"]["missing_players"] == ["Injured Player"]
    assert ctx["away_squad"]["injuries_known"] is True
    assert ctx["referee"]["name"] == "Ref One"
    assert ctx["home"]["form"]["last5"]["matches"] == 5
    assert ctx["home_tactics"]["formation"] == "4-3-3"
    assert ctx["home"]["attack"]["big_chances_per_game"] is None  # N/A, not invented

    evs = {e["key"]: e for e in a["evaluations"]}
    over = evs["over_under:over::2.5"]
    assert over["odds"] == 2.3 and over["bookmakers"] == 3
    assert over["opening_odds"] == 2.1
    assert over["fair_odds"] == pytest.approx(1 / over["probability"])
    assert over["value_pct"] == pytest.approx((over["probability"] * 2.3 - 1) * 100)
    assert over["no_vig_probability"] is not None
    # Unquoted lines are still priced.
    assert evs["corners_ou:over::9.5"]["probability"] is not None
    assert evs["corners_ou:over::9.5"]["odds"] is None


def test_odds_movement_endpoint(loaded, admin_client):
    key = "over_under:over::2.5"
    r = admin_client.get(f"/api/matches/9001/odds?key={key}").json()
    m = r["movement"]
    assert (m["opening"], m["current"], m["lowest"], m["highest"]) == (2.1, 2.3, 2.1, 2.3)
    assert m["direction"] == "drifting"
    assert m["movement_pct"] == pytest.approx(9.5238, rel=1e-3)
    assert len(r["series"]) == 2
    assert "fixed" not in str(r).lower()


def test_dashboard_matches_and_scanner(loaded, admin_client):
    day = KICKOFF.date().isoformat()
    d = admin_client.get(f"/api/dashboard?date={day}&tz=UTC").json()
    assert d["matches_today"] == 1 and d["analysed"] == 1
    lst = admin_client.get(f"/api/matches?date={day}&tz=UTC").json()["matches"]
    assert lst[0]["fixture_id"] == 9001 and lst[0]["analysed"] and lst[0]["has_odds"]

    scan = admin_client.post(
        "/api/scanner/scan",
        json={
            "date": day,
            "tz": "UTC",
            "markets": ["GOALS"],
            "min_probability": 0,
            "min_value": -100,
            "max_risk": "VERY HIGH",
            "min_confidence": 0,
        },
    ).json()
    assert scan["total"] > 0 and all(r["category"] == "GOALS" for r in scan["results"])
    strict = admin_client.post(
        "/api/scanner/scan",
        json={"date": day, "tz": "UTC", "min_probability": 0.99, "min_value": 50},
    ).json()
    assert strict["total"] == 0


def test_signals_lock_and_settle(loaded, admin_client):
    db = loaded
    # A lenient policy so the over price above becomes a signal.
    admin_client.put(
        "/api/admin/settings/signal_policy",
        json={"min_value": -100, "min_confidence": 0, "max_risk": "VERY HIGH"},
    )
    admin_client.put(
        "/api/admin/settings/thresholds",
        json={
            "moderate_value": -100,
            "moderate_confidence": 0,
            "unreliable_confidence": 0,
            "avoid_value": -1000,
        },
    )
    analysis_service.run_analysis(db, days_ahead=2)
    sigs = db.scalars(select(Signal).where(Signal.fixture_id == 9001)).all()
    assert sigs, "expected signals under a lenient policy"

    # Kick-off passes and the match ends 2-1 with 11 corners and 5 cards.
    fx = db.get(Fixture, 9001)
    fx.kickoff_at = NOW - timedelta(hours=3)
    db.commit()
    final = FixtureDTO(
        **{
            **UPCOMING.__dict__,
            "kickoff": NOW - timedelta(hours=3),
            "status": "FT",
            "home_goals": 2,
            "away_goals": 1,
        }
    )
    sync.store_details(
        db,
        FixtureDetailsDTO(
            fixture=final,
            stats=[
                TeamStatsDTO(HOME.id, corners=6, yellow_cards=2, red_cards=0),
                TeamStatsDTO(AWAY.id, corners=5, yellow_cards=3, red_cards=0),
            ],
        ),
    )
    db.commit()
    analysis_service.lock_started(db)
    settled = settlement.settle(db)
    assert settled == len(sigs)
    db.expire_all()
    by_key = {
        s.selection_key: s for s in db.scalars(select(Signal).where(Signal.fixture_id == 9001))
    }
    over = by_key.get("over_under:over::2.5")
    if over is not None:
        assert over.status == "won" and over.profit_units == pytest.approx(over.odds - 1)
    under = by_key.get("over_under:under::2.5")
    if under is not None:
        assert under.status == "lost" and under.profit_units == -1

    stats = admin_client.get("/api/history/stats").json()
    assert stats["overall"]["settled_bets"] == len(sigs)
    assert stats["pending"] == 0
    hist = admin_client.get("/api/history?status=settled").json()["items"]
    assert len(hist) == len(sigs) and hist[0]["score"] == "2-1"
    perf = admin_client.get("/api/admin/performance").json()
    assert perf["overall"]["settled_bets"] == len(sigs)


def test_withdrawn_signals_do_not_count(loaded, admin_client):
    db = loaded
    admin_client.put(
        "/api/admin/settings/signal_policy",
        json={"min_value": -100, "min_confidence": 0, "max_risk": "VERY HIGH"},
    )
    admin_client.put(
        "/api/admin/settings/thresholds",
        json={
            "moderate_value": -100,
            "moderate_confidence": 0,
            "unreliable_confidence": 0,
            "avoid_value": -1000,
        },
    )
    analysis_service.run_analysis(db, days_ahead=2)
    assert db.scalars(select(Signal)).all()
    admin_client.put("/api/admin/settings/signal_policy", json={"min_value": 1000})
    analysis_service.run_analysis(db, days_ahead=2)
    db.expire_all()
    assert {s.status for s in db.scalars(select(Signal))} == {"withdrawn"}
    assert admin_client.get("/api/history").json()["items"] == []
