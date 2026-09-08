"""Redis-Zustand: Quoten, Events, Cooldowns, Pub/Sub."""

from __future__ import annotations

import asyncio

import pytest

from backend.models.domain import now_ts
from backend.models.enums import EventStatus
from backend.tests.conftest import OVER, OVER_UNDER_25, UNDER, make_event, make_quote


class TestQuoteState:
    async def test_first_quote_is_a_change_without_history(self, redis_state):
        change = await redis_state.apply_quote(make_quote(bookmaker="b1", price=2.40))
        assert change is not None
        assert change.previous_price is None
        assert change.delta_percent is None

    async def test_unchanged_price_returns_none(self, redis_state):
        await redis_state.apply_quote(make_quote(bookmaker="b1", price=2.40))
        assert await redis_state.apply_quote(make_quote(bookmaker="b1", price=2.40)) is None

    async def test_changed_price_reports_the_delta(self, redis_state):
        first = make_quote(bookmaker="b1", price=2.00, ts=now_ts() - 2.0)
        await redis_state.apply_quote(first)
        change = await redis_state.apply_quote(make_quote(bookmaker="b1", price=2.20))
        assert change is not None
        assert change.previous_price == 2.00
        assert change.delta_percent == pytest.approx(10.0)
        assert change.elapsed >= 1.5
        assert change.speed_percent_per_second > 0

    async def test_suspension_is_always_processed(self, redis_state):
        await redis_state.apply_quote(make_quote(bookmaker="b1", price=2.40))
        change = await redis_state.apply_quote(
            make_quote(bookmaker="b1", price=2.40, suspended=True)
        )
        assert change is not None

    async def test_line_returns_all_bookmakers(self, redis_state):
        for bookmaker, price in (("b1", 2.4), ("b2", 2.45), ("b3", 2.5)):
            await redis_state.apply_quote(make_quote(bookmaker=bookmaker, price=price))
        line = await redis_state.get_line("foo_test", OVER_UNDER_25.key, OVER.key)
        assert {q.bookmaker for q in line} == {"b1", "b2", "b3"}
        assert {q.price for q in line} == {2.4, 2.45, 2.5}

    async def test_market_covers_every_selection(self, redis_state):
        await redis_state.apply_quote(make_quote(bookmaker="b1", price=2.4, selection=OVER))
        await redis_state.apply_quote(make_quote(bookmaker="b1", price=1.6, selection=UNDER))
        quotes = await redis_state.get_market("foo_test", OVER_UNDER_25.key)
        assert {q.selection.key for q in quotes} == {OVER.key, UNDER.key}

    async def test_market_keys_are_indexed(self, redis_state):
        await redis_state.apply_quote(make_quote(bookmaker="b1", price=2.4))
        assert await redis_state.market_keys("foo_test") == [OVER_UNDER_25.key]

    async def test_quote_survives_a_roundtrip(self, redis_state):
        original = make_quote(bookmaker="ex", price=2.4, liquidity=1234.5, is_exchange=True)
        await redis_state.apply_quote(original)
        restored = (await redis_state.get_line("foo_test", OVER_UNDER_25.key, OVER.key))[0]
        assert restored.price == original.price
        assert restored.liquidity == 1234.5
        assert restored.is_exchange is True
        assert restored.market == original.market

    async def test_drop_removes_the_quote(self, redis_state):
        quote = make_quote(bookmaker="b1", price=2.4)
        await redis_state.apply_quote(quote)
        await redis_state.drop_quote(quote)
        assert await redis_state.get_line("foo_test", OVER_UNDER_25.key, OVER.key) == []


class TestEventState:
    async def test_live_events_are_indexed(self, redis_state):
        await redis_state.set_event(make_event(event_id="e1"))
        await redis_state.set_event(
            make_event(event_id="e2", status=EventStatus.PRE_MATCH, minute=None, score=None)
        )
        assert await redis_state.live_event_ids() == ["e1"]
        assert set(await redis_state.all_event_ids()) == {"e1", "e2"}

    async def test_event_leaves_the_live_set_when_it_ends(self, redis_state):
        await redis_state.set_event(make_event(event_id="e1"))
        await redis_state.set_event(make_event(event_id="e1", status=EventStatus.FINISHED))
        assert await redis_state.live_event_ids() == []

    async def test_event_roundtrip_keeps_live_details(self, redis_state):
        await redis_state.set_event(make_event(event_id="e1"))
        restored = await redis_state.get_event("e1")
        assert restored.football.minute == 67
        assert restored.score.as_text() == "1:1"
        assert restored.status is EventStatus.LIVE

    async def test_unknown_event(self, redis_state):
        assert await redis_state.get_event("nope") is None

    async def test_bulk_read(self, redis_state):
        await redis_state.set_event(make_event(event_id="e1"))
        await redis_state.set_event(make_event(event_id="e2"))
        assert len(await redis_state.get_events(["e1", "e2", "missing"])) == 2
        assert await redis_state.get_events([]) == []

    async def test_counters(self, redis_state):
        await redis_state.set_event(make_event(event_id="e1"))
        await redis_state.set_event(
            make_event(event_id="e2", status=EventStatus.PRE_MATCH, minute=None, score=None)
        )
        assert await redis_state.counters() == {"live_events": 1, "tracked_events": 2}


class TestCooldownStore:
    async def test_claim_is_exclusive(self, redis_state):
        assert await redis_state.claim("cd:x", 60) is True
        assert await redis_state.claim("cd:x", 60) is False

    async def test_claim_expires(self, redis_state):
        assert await redis_state.claim("cd:y", 1) is True
        await asyncio.sleep(1.1)
        assert await redis_state.claim("cd:y", 1) is True

    async def test_release(self, redis_state):
        await redis_state.claim("cd:z", 60)
        await redis_state.release("cd:z")
        assert await redis_state.claim("cd:z", 60) is True


class TestProviderHealth:
    async def test_roundtrip(self, redis_state):
        await redis_state.set_provider_health("sgo", {"name": "sgo", "healthy": True})
        rows = await redis_state.get_provider_health()
        assert rows == [{"name": "sgo", "healthy": True}]

    async def test_empty(self, redis_state):
        assert await redis_state.get_provider_health() == []


class TestPubSub:
    async def test_published_messages_arrive(self, redis_state):
        received: list = []

        async def listen():
            async for _channel, payload in redis_state.subscribe("storm:test"):
                received.append(payload)
                return

        task = asyncio.create_task(listen())
        await asyncio.sleep(0.15)
        await redis_state.publish("storm:test", {"hello": "world"})
        await asyncio.wait_for(task, timeout=3)
        assert received == [{"hello": "world"}]


class TestLocalCache:
    async def test_stale_entries_are_pruned(self, redis_state):
        await redis_state.apply_quote(make_quote(bookmaker="b1", price=2.4, ts=now_ts() - 7200))
        assert redis_state.prune_local_cache(max_entries=0) == 1

    async def test_fresh_entries_are_kept(self, redis_state):
        await redis_state.apply_quote(make_quote(bookmaker="b1", price=2.4))
        assert redis_state.prune_local_cache(max_entries=0) == 0
