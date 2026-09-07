"""Normalisierung und Event-Matching."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend.core.normalization import (
    EventMatcher,
    basic_clean,
    flip_market,
    flip_selection,
    normalize_bookmaker,
    normalize_player,
    normalize_selection,
    normalize_team,
    parse_line,
    similarity,
    strip_accents,
)
from backend.models.domain import MarketKey, Selection
from backend.models.enums import MarketType, Period, SelectionCode, Sport


class TestTeamNormalization:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("FC Bayern München", "bayern_munchen"),
            ("Bayern Munich", "bayern_munchen"),
            ("Bayern", "bayern_munchen"),
            ("Borussia Dortmund", "dortmund"),
            ("BVB", "dortmund"),
            ("Manchester United", "manchester_united"),
            ("Man Utd", "manchester_united"),
            ("Tottenham", "tottenham_hotspur"),
        ],
    )
    def test_aliases_and_cleanup(self, raw, expected):
        assert normalize_team(raw) == expected

    def test_accents_and_sharp_s(self):
        assert strip_accents("Fußball") == "Fussball"
        assert normalize_team("Fußball Club Köln") == "koln"
        assert strip_accents("Košice") == "Kosice"

    def test_noise_words_removed(self):
        assert normalize_team("FC Sevilla") == "sevilla"
        assert normalize_team("SV Werder Bremen") == "werder_bremen"

    def test_never_returns_empty_for_pure_noise(self):
        # "FC" allein ist zwar reines Rauschen, darf aber nicht verschwinden.
        assert normalize_team("FC") == "fc"

    def test_empty_input(self):
        assert normalize_team("") == ""


class TestPlayerNormalization:
    @pytest.mark.parametrize(
        "raw",
        ["Jannik Sinner", "Sinner J.", "J. Sinner", "Sinner, Jannik", "SINNER Jannik"],
    )
    def test_all_spellings_collapse(self, raw):
        assert normalize_player(raw) == "sinner_j"

    def test_double_surname(self):
        assert normalize_player("Carlos Alcaraz") == "alcaraz_c"

    def test_single_token(self):
        assert normalize_player("Nadal") == "nadal"


class TestSimilarity:
    def test_identical(self):
        assert similarity("bayern_munchen", "bayern_munchen") == 1.0

    def test_transliteration_close(self):
        assert similarity("munchen", "muenchen") > 0.8

    def test_unrelated_low(self):
        assert similarity("bayern", "liverpool") < 0.3

    def test_empty(self):
        assert similarity("", "x") == 0.0


class TestEventMatcher:
    def setup_method(self):
        self.start = datetime(2026, 9, 7, 18, 30, tzinfo=UTC)
        self.matcher = EventMatcher()

    def test_same_event_gets_same_id(self):
        a = self.matcher.match(Sport.FOOTBALL, "FC Bayern München", "Borussia Dortmund", self.start)
        b = self.matcher.match(Sport.FOOTBALL, "Bayern Munich", "BVB", self.start)
        assert a.event_id == b.event_id
        assert a.created is True
        assert b.created is False
        assert b.swapped is False

    def test_reversed_teams_are_detected_as_swapped(self):
        a = self.matcher.match(Sport.FOOTBALL, "Bayern München", "Borussia Dortmund", self.start)
        b = self.matcher.match(Sport.FOOTBALL, "Borussia Dortmund", "Bayern München", self.start)
        assert a.event_id == b.event_id
        assert b.swapped is True

    def test_different_events_get_different_ids(self):
        a = self.matcher.match(Sport.FOOTBALL, "Bayern München", "Borussia Dortmund", self.start)
        b = self.matcher.match(Sport.FOOTBALL, "Real Madrid", "FC Barcelona", self.start)
        assert a.event_id != b.event_id

    def test_same_pairing_on_another_day_is_a_different_event(self):
        a = self.matcher.match(Sport.FOOTBALL, "Bayern München", "Borussia Dortmund", self.start)
        later = self.matcher.match(
            Sport.FOOTBALL, "Bayern München", "Borussia Dortmund", self.start + timedelta(days=7)
        )
        assert a.event_id != later.event_id

    def test_kickoff_shift_within_a_day_still_matches(self):
        a = self.matcher.match(Sport.FOOTBALL, "Bayern München", "Borussia Dortmund", self.start)
        shifted = self.matcher.match(
            Sport.FOOTBALL, "Bayern Munich", "BVB", self.start + timedelta(hours=6)
        )
        assert a.event_id == shifted.event_id

    def test_tennis_spellings_match(self):
        a = self.matcher.match(Sport.TENNIS, "Jannik Sinner", "Carlos Alcaraz", self.start)
        b = self.matcher.match(Sport.TENNIS, "Sinner J.", "Alcaraz C.", self.start)
        assert a.event_id == b.event_id

    def test_sports_never_collide(self):
        a = self.matcher.match(Sport.FOOTBALL, "Alpha", "Beta", self.start)
        b = self.matcher.match(Sport.TENNIS, "Alpha", "Beta", self.start)
        assert a.event_id != b.event_id

    def test_unnormalizable_input_raises(self):
        with pytest.raises(ValueError):
            self.matcher.match(Sport.FOOTBALL, "", "Dortmund", self.start)

    def test_event_ids_are_stable_across_instances(self):
        other = EventMatcher()
        a = self.matcher.match(Sport.FOOTBALL, "Bayern München", "Borussia Dortmund", self.start)
        b = other.match(Sport.FOOTBALL, "FC Bayern", "BVB", self.start)
        assert a.event_id == b.event_id


class TestFlipping:
    def test_selection_flip(self):
        home = Selection(code=SelectionCode.HOME, label="Bayern")
        assert flip_selection(home).code is SelectionCode.AWAY
        assert flip_selection(flip_selection(home)).code is SelectionCode.HOME

    def test_double_chance_flip(self):
        sel = Selection(code=SelectionCode.HOME_OR_DRAW)
        assert flip_selection(sel).code is SelectionCode.AWAY_OR_DRAW

    def test_neutral_selections_are_untouched(self):
        for code in (SelectionCode.OVER, SelectionCode.UNDER, SelectionCode.DRAW):
            sel = Selection(code=code)
            assert flip_selection(sel).code is code

    def test_handicap_line_is_mirrored(self):
        market = MarketKey(type=MarketType.ASIAN_HANDICAP, line=-0.5)
        assert flip_market(market).line == 0.5

    def test_totals_line_stays(self):
        market = MarketKey(type=MarketType.OVER_UNDER, line=2.5)
        assert flip_market(market).line == 2.5


class TestSelectionParsing:
    def test_team_names_map_to_home_away(self):
        sel = normalize_selection(
            "Bayern Munich",
            sport=Sport.FOOTBALL,
            home="FC Bayern München",
            away="Borussia Dortmund",
            market_type=MarketType.MATCH_ODDS,
        )
        assert sel.code is SelectionCode.HOME

    def test_draw(self):
        sel = normalize_selection(
            "Draw", sport=Sport.FOOTBALL, home="A", away="B", market_type=MarketType.MATCH_ODDS
        )
        assert sel.code is SelectionCode.DRAW

    def test_over_under(self):
        over = normalize_selection(
            "Over 2.5", sport=Sport.FOOTBALL, home="A", away="B", market_type=MarketType.OVER_UNDER
        )
        under = normalize_selection(
            "Under", sport=Sport.FOOTBALL, home="A", away="B", market_type=MarketType.OVER_UNDER
        )
        assert over.code is SelectionCode.OVER
        assert under.code is SelectionCode.UNDER

    def test_btts(self):
        yes = normalize_selection(
            "Yes", sport=Sport.FOOTBALL, home="A", away="B", market_type=MarketType.BTTS
        )
        assert yes.code is SelectionCode.YES

    def test_unknown_stays_other_and_keeps_raw(self):
        sel = normalize_selection(
            "3:1", sport=Sport.FOOTBALL, home="A", away="B", market_type=MarketType.CORRECT_SCORE
        )
        assert sel.code is SelectionCode.OTHER
        assert sel.raw == "3:1"
        assert sel.key.startswith("other:")


class TestMisc:
    def test_market_key_roundtrip(self):
        market = MarketKey(type=MarketType.OVER_UNDER, line=2.5, period=Period.FIRST_HALF)
        assert MarketKey.parse(market.key) == market

    def test_market_key_without_line(self):
        market = MarketKey(type=MarketType.MATCH_ODDS)
        assert MarketKey.parse(market.key) == market

    def test_negative_line_roundtrip(self):
        market = MarketKey(type=MarketType.ASIAN_HANDICAP, line=-0.25)
        assert MarketKey.parse(market.key).line == -0.25

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("2.5", 2.5), ("+1", 1.0), ("-0.25", -0.25), ("", None), (None, None), ("x", None)],
    )
    def test_parse_line(self, raw, expected):
        assert parse_line(raw) == expected

    def test_bookmaker_normalization(self):
        assert normalize_bookmaker("William Hill") == "william_hill"
        assert normalize_bookmaker("") == "unknown"

    def test_basic_clean(self):
        assert basic_clean("A.C. Milan & Co.") == "a c milan and co"
