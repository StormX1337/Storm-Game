"""Repository gegen SQLite (Schema identisch zur PostgreSQL-Migration)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend.models.domain import Alert, OddsChange, now_ts
from backend.models.enums import AlertKind, EventStatus, ProviderStatus
from backend.providers.base import ProviderHealth
from backend.tests.conftest import OVER, OVER_UNDER_25, make_event, make_quote, make_tennis_event


def make_alert(**overrides) -> Alert:
    from backend.core.filters import fingerprint

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
        "error_score": 91,
        "bookmaker_count": 7,
        "provider": "mock",
    }
    data.update(overrides)
    alert = Alert(**data)
    alert.fingerprint = fingerprint(alert)
    return alert


def make_change(price: float = 4.20, previous: float | None = 3.90) -> OddsChange:
    return OddsChange(
        quote=make_quote(bookmaker="examplebookie", price=price),
        previous_price=previous,
        previous_ts=now_ts() - 2.0,
    )


class TestWriteBatch:
    async def test_event_is_stored(self, repository):
        await repository.write_batch(events=[make_event()])
        rows = await repository.list_events()
        assert len(rows) == 1
        assert rows[0].home == "Bayern München"
        assert rows[0].status == "LIVE"
        assert rows[0].live_state["minute"] == 67

    async def test_event_upsert_updates_in_place(self, repository):
        await repository.write_batch(events=[make_event()])
        await repository.write_batch(events=[make_event(minute=90, score=(2, 1))])
        rows = await repository.list_events()
        assert len(rows) == 1
        assert rows[0].live_state["minute"] == 90
        assert rows[0].score_home == 2

    async def test_prematch_event_has_no_live_state(self, repository):
        event = make_event(status=EventStatus.PRE_MATCH, minute=None, score=None)
        event.football.period = None
        await repository.write_batch(events=[event])
        assert (await repository.list_events())[0].live_state is None

    async def test_tennis_live_state(self, repository):
        await repository.write_batch(events=[make_tennis_event()])
        row = (await repository.list_events(sport="tennis"))[0]
        assert row.live_state["games_home"] == 4
        assert row.live_state["server"] == "home"

    async def test_changes_create_market_and_selection(self, repository):
        await repository.write_batch(events=[make_event()], changes=[make_change()])
        odds = await repository.list_odds("foo_test")
        assert len(odds) == 1
        assert odds[0]["bookmaker"] == "examplebookie"
        assert odds[0]["price"] == 4.20

    async def test_many_markets_are_all_persisted(self, repository):
        from backend.models.domain import MarketKey
        from backend.models.enums import MarketType, Period

        changes = []
        for market_type in (MarketType.MATCH_ODDS, MarketType.OVER_UNDER, MarketType.BTTS):
            quote = make_quote(
                bookmaker="b1",
                price=2.5,
                market=MarketKey(type=market_type, line=2.5, period=Period.FULL_TIME),
            )
            changes.append(OddsChange(quote=quote, previous_price=None, previous_ts=None))
        await repository.write_batch(events=[make_event()], changes=changes)
        odds = await repository.list_odds("foo_test")
        assert len({row["market_type"] for row in odds}) == 3

    async def test_snapshots_can_be_skipped(self, repository):
        await repository.write_batch(
            events=[make_event()], changes=[make_change()], store_snapshots=False
        )
        assert await repository.list_odds("foo_test") == []
        stats = await repository.stats()
        assert stats["odds_snapshots"] == 0

    async def test_alert_is_stored_with_payload(self, repository):
        await repository.write_batch(events=[make_event()], alerts=[make_alert()])
        rows = await repository.list_alerts()
        assert len(rows) == 1
        assert rows[0].payload["event"]["home"] == "Bayern München"
        assert rows[0].telegram_sent is False

    async def test_duplicate_fingerprints_are_ignored(self, repository):
        alert = make_alert()
        await repository.write_batch(alerts=[alert])
        await repository.write_batch(alerts=[alert])
        assert len(await repository.list_alerts()) == 1

    async def test_empty_batch_is_a_noop(self, repository):
        await repository.write_batch()
        assert await repository.list_events() == []


class TestQueries:
    async def test_alert_filters(self, repository):
        await repository.write_batch(
            alerts=[
                make_alert(bookmaker="a", kind=AlertKind.VALUE, value_percent=12.0),
                make_alert(bookmaker="b", kind=AlertKind.FIXED_ERROR, value_percent=60.0),
                make_alert(bookmaker="c", event=make_tennis_event(), value_percent=30.0),
            ]
        )
        assert len(await repository.list_alerts()) == 3
        assert len(await repository.list_alerts(kind="value")) == 1
        assert len(await repository.list_alerts(sport="tennis")) == 1
        assert len(await repository.list_alerts(min_value=25.0)) == 2

    async def test_alerts_since(self, repository):
        await repository.write_batch(alerts=[make_alert()])
        future = datetime.now(UTC) + timedelta(minutes=5)
        assert await repository.list_alerts(since=future) == []

    async def test_event_filters(self, repository):
        await repository.write_batch(
            events=[
                make_event(),
                make_tennis_event(),
                make_event(
                    event_id="foo_pre", provider_event_id="p-2", status=EventStatus.PRE_MATCH
                ),
            ]
        )
        assert len(await repository.list_events()) == 3
        assert len(await repository.list_events(sport="football")) == 2
        assert len(await repository.list_events(status="LIVE")) == 2

    async def test_get_event(self, repository):
        await repository.write_batch(events=[make_event()])
        assert (await repository.get_event("foo_test")).home == "Bayern München"
        assert await repository.get_event("does_not_exist") is None

    async def test_latest_price_wins(self, repository):
        await repository.write_batch(events=[make_event()], changes=[make_change(price=4.20)])
        await repository.write_batch(changes=[make_change(price=3.10, previous=4.20)])
        odds = await repository.list_odds("foo_test")
        assert len(odds) == 1
        assert odds[0]["price"] == 3.10

    async def test_stats(self, repository):
        await repository.write_batch(
            events=[make_event(), make_tennis_event()],
            changes=[make_change()],
            alerts=[make_alert()],
        )
        stats = await repository.stats()
        assert stats["events_total"] == 2
        assert stats["events_live"] == 2
        assert stats["alerts_total"] == 1
        assert stats["alerts_by_kind"] == {"fixed_error": 1}
        assert stats["odds_snapshots"] == 1
        assert stats["bookmakers"] == 1
        assert stats["avg_value_percent"] == pytest.approx(56.7, abs=0.1)


class TestProviderHealth:
    async def test_upsert(self, repository):
        health = ProviderHealth(
            name="mock", status=ProviderStatus.CONNECTED, messages=10, quotes=100
        )
        await repository.upsert_provider_health(health)
        health.messages = 20
        await repository.upsert_provider_health(health)
        rows = await repository.list_provider_health()
        assert len(rows) == 1
        assert rows[0].messages == 20
        assert rows[0].status == "connected"


class TestUsers:
    async def test_user_is_created_with_defaults(self, repository):
        user, settings = await repository.get_or_create_user(4711, username="tester")
        assert user.telegram_id == 4711
        assert settings.min_value_percent == 10.0
        assert settings.sports == ["football", "tennis"]
        assert settings.paused is False

    async def test_second_call_returns_the_same_user(self, repository):
        first, _ = await repository.get_or_create_user(4711)
        second, _ = await repository.get_or_create_user(4711)
        assert first.id == second.id

    async def test_settings_update(self, repository):
        await repository.get_or_create_user(4711)
        updated = await repository.update_user_settings(4711, min_value_percent=25.0, paused=True)
        assert updated.min_value_percent == 25.0
        assert updated.paused is True

    async def test_update_for_unknown_user(self, repository):
        assert await repository.update_user_settings(999, paused=True) is None

    async def test_active_users_are_listed(self, repository):
        await repository.get_or_create_user(1)
        await repository.get_or_create_user(2)
        assert len(await repository.list_active_users()) == 2

    async def test_mark_alert_sent(self, repository):
        alert = make_alert()
        await repository.write_batch(alerts=[alert])
        await repository.mark_alert_sent(alert.fingerprint)
        assert (await repository.list_alerts())[0].telegram_sent is True


class TestMaintenance:
    async def test_prune_removes_old_rows(self, repository):
        old_ts = now_ts() - 60 * 60 * 24 * 30
        quote = make_quote(bookmaker="b1", price=2.0, ts=old_ts)
        await repository.write_batch(
            events=[make_event()],
            changes=[OddsChange(quote=quote, previous_price=None, previous_ts=None)],
        )
        removed = await repository.prune(snapshot_days=7, alert_days=30)
        assert removed["odds_snapshots"] == 1
        assert removed["odds_changes"] == 1

    async def test_prune_keeps_recent_rows(self, repository):
        await repository.write_batch(events=[make_event()], changes=[make_change()])
        removed = await repository.prune(snapshot_days=7, alert_days=30)
        assert removed["odds_snapshots"] == 0

    async def test_id_cache_is_clearable(self, repository):
        await repository.write_batch(events=[make_event()], changes=[make_change()])
        assert repository._market_ids
        repository.clear_caches()
        assert not repository._market_ids
        # Nach dem Leeren müssen die IDs erneut auflösbar sein.
        await repository.write_batch(changes=[make_change(price=5.0)])
        assert len(await repository.list_odds("foo_test")) == 1
