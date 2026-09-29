import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from app.engine.analysis import EngineSettings, analyze
from app.engine.markets import Market, make_selection
from app.engine.rates import baseline_from_pairs
from app.engine.summary import team_summary
from app.engine.types import (
    LeagueBaseline,
    MatchContext,
    MatchRecord,
    Quote,
    RefereeProfile,
    SquadStatus,
)

KICKOFF = datetime(2026, 9, 28, 19, 0, tzinfo=UTC)


def history(n, gf, ga, *, corners=(5, 4), cards=(2, 2), xg=None, start_home=True):
    out = []
    for i in range(n):
        out.append(
            MatchRecord(
                fixture_id=1000 + i,
                date=KICKOFF - timedelta(days=7 * (i + 1)),
                is_home=(i % 2 == 0) == start_home,
                opponent_id=900 + i,
                goals_for=gf[i % len(gf)],
                goals_against=ga[i % len(ga)],
                xg_for=None if xg is None else xg[0],
                xg_against=None if xg is None else xg[1],
                corners_for=None if corners is None else corners[0],
                corners_against=None if corners is None else corners[1],
                cards_for=None if cards is None else cards[0],
                cards_against=None if cards is None else cards[1],
                ht_goals_for=0,
                ht_goals_against=0,
            )
        )
    return out


def league(goals=(1.5, 1.2), corners=(5.3, 4.4), cards=(2.0, 2.3), n=120):
    def pairs(h, a):
        # Alternate around the mean so the baseline has some variance.
        return [(h + (1 if i % 2 else -1) * 0.8, a + (1 if i % 3 else -1) * 0.7) for i in range(n)]

    return LeagueBaseline(
        goals=baseline_from_pairs(pairs(*goals)),
        xg=None,
        corners=None if corners is None else baseline_from_pairs(pairs(*corners)),
        cards=None if cards is None else baseline_from_pairs(pairs(*cards)),
    )


def ctx(**kw):
    base = dict(
        fixture_id=1,
        kickoff=KICKOFF,
        home_id=10,
        away_id=20,
        home_history=history(12, [2, 3, 1, 2], [0, 1, 1, 0]),
        away_history=history(12, [0, 1, 1, 0], [2, 1, 3, 2], start_home=False),
        league=league(),
    )
    base.update(kw)
    return MatchContext(**base)


def by_key(analysis):
    return {e.key: e for e in analysis.evaluations}


def test_strong_home_side_is_favoured_and_prices_are_coherent():
    a = analyze(ctx())
    goals = a.stats["goals"]
    assert goals.status == "OK"
    assert goals.lambda_home > goals.lambda_away
    ev = by_key(a)
    home = ev[make_selection(Market.RESULT_1X2, "home").key]
    away = ev[make_selection(Market.RESULT_1X2, "away").key]
    draw = ev[make_selection(Market.RESULT_1X2, "draw").key]
    assert home.probability > away.probability
    assert math.isclose(home.probability + draw.probability + away.probability, 1, abs_tol=1e-9)
    assert a.top_scores and a.top_scores[0]["probability"] > 0
    # No odds were given: prices exist, value does not.
    assert home.odds is None and home.value_pct is None and home.rank == "NO_VALUE"


def test_value_uses_model_probability_not_the_price():
    sel = make_selection(Market.OVER_UNDER, "over", 2.5)
    a1 = analyze(ctx(quotes=[Quote(sel, 1.5, "bookA", bookmakers=6, prices=(1.5, 1.48))]))
    a2 = analyze(ctx(quotes=[Quote(sel, 3.0, "bookA", bookmakers=6, prices=(3.0, 2.9))]))
    e1, e2 = by_key(a1)[sel.key], by_key(a2)[sel.key]
    assert e1.probability == e2.probability
    assert e1.fair_odds == e2.fair_odds
    assert math.isclose(e1.value_pct, (e1.probability * 1.5 - 1) * 100, rel_tol=1e-9)
    assert e2.value_pct > e1.value_pct


def test_insufficient_history_is_reported_not_guessed():
    a = analyze(ctx(home_history=history(3, [1], [1])))
    assert a.stats["goals"].status == "INSUFFICIENT_DATA"
    assert all(e.status == "INSUFFICIENT_DATA" for e in a.evaluations if e.stat == "goals")
    assert all(e.probability is None for e in a.evaluations if e.stat == "goals")


def test_missing_corner_data_only_blocks_corner_markets():
    home = history(12, [2, 1], [1, 1], corners=None)
    a = analyze(ctx(home_history=home))
    assert a.stats["corners"].status == "INSUFFICIENT_DATA"
    assert a.stats["goals"].status == "OK"
    assert a.stats["cards"].status == "OK"


def test_referee_factor_moves_cards():
    strict = RefereeProfile("Strict", matches=40, avg_cards=7.0)
    lenient = RefereeProfile("Lenient", matches=40, avg_cards=2.5)
    hi = analyze(ctx(referee=strict)).stats["cards"]
    lo = analyze(ctx(referee=lenient)).stats["cards"]
    assert hi.lambda_home + hi.lambda_away > lo.lambda_home + lo.lambda_away


def test_missing_scorers_reduce_attack_and_are_explained():
    base = analyze(ctx()).stats["goals"]
    squad = SquadStatus(injuries_known=True, missing_players=["Star"], missing_goal_share=0.4)
    hurt = analyze(ctx(home_squad=squad)).stats["goals"]
    assert hurt.lambda_home < base.lambda_home
    assert any("Home attack" in note for note in hurt.adjustments)


def test_disabled_markets_are_skipped():
    settings = EngineSettings(enabled_markets={Market.RESULT_1X2})
    a = analyze(ctx(), settings)
    assert {e.market for e in a.evaluations} == {"1x2"}


def test_quote_only_lines_are_priced_too():
    sel = make_selection(Market.ASIAN_TOTAL, "over", 3.75)
    a = analyze(ctx(quotes=[Quote(sel, 2.4, "bookA", bookmakers=3)]))
    assert sel.key in by_key(a)


def test_team_summary_blocks():
    s = team_summary(history(12, [2, 0], [1, 1]), KICKOFF, venue_home=True)
    assert s["form"]["last5"]["matches"] == 5
    assert s["attack"]["big_chances_per_game"] is None
    assert s["corners"]["for_per_game"] == 5
    no_corners = team_summary(history(6, [1], [1], corners=None), KICKOFF, True)
    assert no_corners["corners"]["for_per_game"] is None


def test_analysis_is_json_serialisable():
    import json

    json.dumps(analyze(ctx()).public())


def test_replace_keeps_context_immutable():
    c = ctx()
    c2 = replace(c, fixture_id=2)
    assert c.fixture_id == 1 and c2.fixture_id == 2
