"""False-Positive-Schutz: Stale, Cooldown, Duplikate, Schwellen."""

from __future__ import annotations

import asyncio

import pytest

from backend.core.filters import (
    AlertGate,
    FilterThresholds,
    InMemoryCooldownStore,
    check_error_signal,
    check_quote,
    check_signal,
    check_value_signal,
    cooldown_key,
    duplicate_key,
    fingerprint,
    is_stale,
)
from backend.models.domain import Alert, now_ts
from backend.models.enums import AlertKind, EventStatus, MarketType, Sport
from backend.tests.conftest import OVER, OVER_UNDER_25, make_event, make_quote


@pytest.fixture
def thresholds() -> FilterThresholds:
    return FilterThresholds(
        min_value_percent=10.0,
        min_outlier_percent=15.0,
        min_bookmakers=3,
        min_odds=1.50,
        max_odds=51.0,
        max_odds_age_seconds=10.0,
        alert_cooldown_seconds=60,
        min_confidence=60,
        min_error_score=60,
    )


def make_alert(**overrides) -> Alert:
    data = {
        "kind": AlertKind.FIXED_ERROR,
        "event": make_event(),
        "market": OVER_UNDER_25,
        "selection": OVER,
        "bookmaker": "examplebookie",
        "odds": 4.20,
        "fair_odds": 2.68,
        "value_percent": 56.7,
        "deviation_percent": 56.7,
        "confidence": 94,
        "error_score": 88,
        "bookmaker_count": 6,
    }
    data.update(overrides)
    alert = Alert(**data)
    alert.fingerprint = fingerprint(alert)
    return alert


class TestQuoteFilter:
    def test_fresh_quote_passes(self, thresholds):
        quote = make_quote(bookmaker="b1", price=4.20)
        assert check_quote(quote, make_event(), thresholds).passed

    def test_stale_quote_is_rejected(self, thresholds):
        quote = make_quote(bookmaker="b1", price=4.20, ts=now_ts() - 45)
        decision = check_quote(quote, make_event(), thresholds)
        assert not decision.passed
        assert decision.reason.startswith("stale")

    def test_is_stale_helper(self):
        assert is_stale(make_quote(bookmaker="b", price=2.0, ts=now_ts() - 20), 10.0)
        assert not is_stale(make_quote(bookmaker="b", price=2.0), 10.0)

    def test_quote_exactly_at_age_limit_passes(self, thresholds):
        # Feste Referenzzeit - sonst entscheidet die Uhr über den Test.
        quote = make_quote(bookmaker="b1", price=4.20)
        reference = quote.ts + thresholds.max_odds_age_seconds
        assert check_quote(quote, make_event(), thresholds, reference=reference).passed

    def test_quote_just_over_the_age_limit_fails(self, thresholds):
        quote = make_quote(bookmaker="b1", price=4.20)
        reference = quote.ts + thresholds.max_odds_age_seconds + 0.5
        assert not check_quote(quote, make_event(), thresholds, reference=reference).passed

    def test_suspended_quote_is_rejected(self, thresholds):
        quote = make_quote(bookmaker="b1", price=4.20, suspended=True)
        assert check_quote(quote, make_event(), thresholds).reason == "suspended"

    def test_suspended_event_is_rejected(self, thresholds):
        quote = make_quote(bookmaker="b1", price=4.20)
        event = make_event(status=EventStatus.SUSPENDED)
        assert check_quote(quote, event, thresholds).reason == "event_suspended"

    def test_finished_event_is_rejected(self, thresholds):
        quote = make_quote(bookmaker="b1", price=4.20)
        event = make_event(status=EventStatus.FINISHED)
        assert check_quote(quote, event, thresholds).reason == "event_finished"

    def test_odds_below_minimum(self, thresholds):
        quote = make_quote(bookmaker="b1", price=1.20)
        assert check_quote(quote, make_event(), thresholds).reason == "odds_below_min"

    def test_odds_above_maximum(self, thresholds):
        quote = make_quote(bookmaker="b1", price=250.0)
        assert check_quote(quote, make_event(), thresholds).reason == "odds_above_max"

    def test_disabled_sport(self, thresholds):
        limited = thresholds.with_overrides(sports=frozenset({Sport.TENNIS}))
        quote = make_quote(bookmaker="b1", price=4.20)
        assert check_quote(quote, make_event(), limited).reason == "sport_disabled"

    def test_live_can_be_switched_off(self, thresholds):
        limited = thresholds.with_overrides(scan_live=False)
        quote = make_quote(bookmaker="b1", price=4.20)
        assert check_quote(quote, make_event(), limited).reason == "live_disabled"

    def test_prematch_can_be_switched_off(self, thresholds):
        limited = thresholds.with_overrides(scan_prematch=False)
        quote = make_quote(bookmaker="b1", price=4.20)
        event = make_event(status=EventStatus.PRE_MATCH)
        assert check_quote(quote, event, limited).reason == "prematch_disabled"

    def test_market_whitelist(self, thresholds):
        limited = thresholds.with_overrides(markets=frozenset({MarketType.MATCH_ODDS}))
        quote = make_quote(bookmaker="b1", price=4.20)
        assert check_quote(quote, make_event(), limited).reason == "market_disabled"


class TestSignalFilter:
    def test_strong_signal_passes(self, thresholds):
        assert check_signal(
            value_percent=56.7,
            deviation_percent=56.7,
            bookmaker_count=6,
            confidence=94,
            error_score=88,
            thresholds=thresholds,
        ).passed

    def test_too_few_bookmakers(self, thresholds):
        decision = check_signal(
            value_percent=56.7,
            deviation_percent=56.7,
            bookmaker_count=2,
            confidence=94,
            error_score=88,
            thresholds=thresholds,
        )
        assert decision.reason == "too_few_bookmakers_2"

    def test_value_below_minimum(self, thresholds):
        assert not check_value_signal(
            value_percent=4.0, bookmaker_count=6, confidence=90, thresholds=thresholds
        ).passed

    def test_value_exactly_at_minimum_passes(self, thresholds):
        assert check_value_signal(
            value_percent=10.0, bookmaker_count=3, confidence=60, thresholds=thresholds
        ).passed

    def test_confidence_below_minimum(self, thresholds):
        decision = check_value_signal(
            value_percent=40.0, bookmaker_count=6, confidence=30, thresholds=thresholds
        )
        assert decision.reason == "confidence_30_below_min"

    def test_error_signal_needs_deviation_and_score(self, thresholds):
        assert not check_error_signal(
            deviation_percent=8.0,
            bookmaker_count=6,
            error_score=90,
            confidence=90,
            thresholds=thresholds,
        ).passed
        assert not check_error_signal(
            deviation_percent=40.0,
            bookmaker_count=6,
            error_score=20,
            confidence=90,
            thresholds=thresholds,
        ).passed
        assert check_error_signal(
            deviation_percent=40.0,
            bookmaker_count=6,
            error_score=80,
            confidence=90,
            thresholds=thresholds,
        ).passed

    def test_error_signal_respects_confidence(self, thresholds):
        """Eine faire Quote, der die Engine nicht traut, taugt nicht als Referenz."""
        assert not check_error_signal(
            deviation_percent=200.0,
            bookmaker_count=6,
            error_score=95,
            confidence=40,
            thresholds=thresholds,
        ).passed


class TestCooldownAndDuplicates:
    async def test_first_alert_passes_then_cooldown_blocks(self, thresholds):
        gate = AlertGate(InMemoryCooldownStore(), thresholds)
        alert = make_alert()
        assert (await gate.allow(alert)).passed
        second = await gate.allow(make_alert())
        assert not second.passed
        assert second.reason in {"duplicate", "cooldown"}

    async def test_same_price_is_a_duplicate(self, thresholds):
        gate = AlertGate(InMemoryCooldownStore(), thresholds)
        await gate.allow(make_alert(odds=4.20))
        assert (await gate.allow(make_alert(odds=4.21))).reason == "duplicate"

    async def test_clearly_different_price_is_a_new_signal(self, thresholds):
        # Cooldown-Schlüssel greift trotzdem - hier nur der Duplikat-Bucket.
        assert duplicate_key(make_alert(odds=4.20)) != duplicate_key(make_alert(odds=6.00))

    async def test_other_bookmaker_is_not_a_duplicate(self, thresholds):
        gate = AlertGate(InMemoryCooldownStore(), thresholds)
        assert (await gate.allow(make_alert(bookmaker="a"))).passed
        assert (await gate.allow(make_alert(bookmaker="b"))).passed

    async def test_other_selection_is_not_a_duplicate(self, thresholds):
        from backend.models.domain import Selection
        from backend.models.enums import SelectionCode

        gate = AlertGate(InMemoryCooldownStore(), thresholds)
        under = Selection(code=SelectionCode.UNDER, label="Under")
        assert (await gate.allow(make_alert())).passed
        assert (await gate.allow(make_alert(selection=under))).passed

    async def test_cooldown_expires(self):
        thresholds = FilterThresholds(alert_cooldown_seconds=1, duplicate_price_tolerance=0.0)
        gate = AlertGate(InMemoryCooldownStore(), thresholds)
        assert (await gate.allow(make_alert())).passed
        await asyncio.sleep(1.05)
        assert (await gate.allow(make_alert())).passed

    async def test_redis_backed_gate(self, redis_state, thresholds):
        gate = AlertGate(redis_state, thresholds)
        assert (await gate.allow(make_alert())).passed
        assert not (await gate.allow(make_alert())).passed

    def test_keys_are_specific(self):
        alert = make_alert()
        key = cooldown_key(alert)
        assert alert.event.event_id in key
        assert alert.bookmaker in key
        assert cooldown_key(make_alert(bookmaker="other")) != key

    def test_fingerprint_is_stable_and_specific(self):
        assert fingerprint(make_alert()) == fingerprint(make_alert())
        assert fingerprint(make_alert(odds=9.9)) != fingerprint(make_alert())


class TestThresholdOverrides:
    def test_overrides_replace_only_given_values(self, thresholds):
        updated = thresholds.with_overrides(min_value_percent=25.0)
        assert updated.min_value_percent == 25.0
        assert updated.min_bookmakers == thresholds.min_bookmakers

    def test_none_values_are_ignored(self, thresholds):
        updated = thresholds.with_overrides(min_value_percent=None)
        assert updated.min_value_percent == thresholds.min_value_percent
