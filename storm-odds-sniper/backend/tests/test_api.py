"""HTTP-API: Endpunkte, Schemata, Rate-Limit."""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio

from backend.api.app import create_app
from backend.core.config import Settings
from backend.models.domain import now_ts
from backend.tests.conftest import make_event, make_quote, make_tennis_event


@pytest.fixture
def api_settings() -> Settings:
    return Settings(
        _env_file=None,
        api_cors_origins="http://localhost:8080",
        api_rate_limit_per_minute=1000,
        api_docs_enabled=True,
        log_json=False,
    )


@pytest_asyncio.fixture
async def client(api_settings, redis_state, repository):
    """App ohne Lifespan - Zustand wird direkt gesetzt (hermetisch)."""
    app = create_app(api_settings)
    app.state.redis = redis_state
    app.state.repository = repository
    app.state.hub = None
    app.state.started_at = now_ts()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def seed(redis_state, repository):
    football = make_event()
    tennis = make_tennis_event()
    for event in (football, tennis):
        await redis_state.set_event(event)
    await repository.write_batch(events=[football, tennis])
    for bookmaker, price in (("b1", 2.40), ("b2", 2.45), ("b3", 3.80)):
        await redis_state.apply_quote(make_quote(bookmaker=bookmaker, price=price))
    return football, tennis


class TestHealth:
    async def test_health_reports_components(self, client):
        response = await client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] in {"ok", "degraded"}
        assert {c["name"] for c in body["components"]} == {"redis", "database"}
        assert body["uptime_seconds"] >= 0

    async def test_provider_health_lists_every_adapter(self, client):
        response = await client.get("/health/providers")
        assert response.status_code == 200
        keys = {row["key"] for row in response.json()}
        assert keys == {"mock", "the_odds_api", "sportsgameodds", "betfair"}

    async def test_missing_credentials_are_reported(self, client):
        rows = {row["key"]: row for row in (await client.get("/health/providers")).json()}
        assert rows["the_odds_api"]["missing_credentials"] == ["ODDS_API_KEY"]
        assert rows["sportsgameodds"]["missing_credentials"] == ["SGO_API_KEY"]
        assert rows["mock"]["missing_credentials"] == []

    async def test_provider_catalogue(self, client):
        rows = (await client.get("/providers")).json()
        assert any(row["enabled"] for row in rows)
        assert all("docs_url" in row for row in rows)


class TestEvents:
    async def test_list_events(self, client, redis_state, repository):
        await seed(redis_state, repository)
        rows = (await client.get("/events")).json()
        assert len(rows) == 2

    async def test_sport_filter(self, client, redis_state, repository):
        await seed(redis_state, repository)
        rows = (await client.get("/events?sport=tennis")).json()
        assert len(rows) == 1
        assert rows[0]["sport"] == "tennis"

    async def test_live_endpoint(self, client, redis_state, repository):
        await seed(redis_state, repository)
        rows = (await client.get("/events/live")).json()
        assert all(row["status"] == "LIVE" for row in rows)

    async def test_live_details_are_passed_through(self, client, redis_state, repository):
        await seed(redis_state, repository)
        rows = (await client.get("/events?sport=football")).json()
        assert rows[0]["football"]["minute"] == 67
        assert rows[0]["score"] == {"home": 1, "away": 1}
        assert rows[0]["tennis"] is None

    async def test_single_event(self, client, redis_state, repository):
        football, _ = await seed(redis_state, repository)
        row = (await client.get(f"/events/{football.event_id}")).json()
        assert row["home"] == "Bayern München"

    async def test_unknown_event_is_404(self, client):
        assert (await client.get("/events/nope")).status_code == 404

    async def test_invalid_sport_is_rejected(self, client):
        assert (await client.get("/events?sport=chess")).status_code == 422

    async def test_database_fallback_when_redis_is_empty(self, client, repository):
        await repository.write_batch(events=[make_event()])
        rows = (await client.get("/events")).json()
        assert len(rows) == 1
        assert rows[0]["home"] == "Bayern München"


class TestOdds:
    async def test_current_odds(self, client, redis_state, repository):
        football, _ = await seed(redis_state, repository)
        rows = (await client.get(f"/odds?event_id={football.event_id}")).json()
        assert len(rows) == 3
        assert {row["bookmaker"] for row in rows} == {"b1", "b2", "b3"}
        assert all(row["age_seconds"] >= 0 for row in rows)

    async def test_event_id_is_required(self, client):
        assert (await client.get("/odds")).status_code == 422

    async def test_stale_quotes_can_be_filtered(self, client, redis_state, repository):
        football, _ = await seed(redis_state, repository)
        await redis_state.apply_quote(
            make_quote(bookmaker="old", price=9.0, event_id=football.event_id, ts=now_ts() - 600)
        )
        fresh = (
            await client.get(
                f"/odds?event_id={football.event_id}&include_stale=false&max_age_seconds=30"
            )
        ).json()
        assert "old" not in {row["bookmaker"] for row in fresh}


class TestAlerts:
    async def test_alert_list(self, client, repository):
        from backend.tests.test_database import make_alert

        await repository.write_batch(alerts=[make_alert()])
        rows = (await client.get("/alerts")).json()
        assert len(rows) == 1
        row = rows[0]
        assert row["event_title"] == "Bayern München vs Borussia Dortmund"
        assert row["score"] == "1:1"
        assert row["value_percent"] == pytest.approx(56.7)
        assert row["kind"] == "fixed_error"

    async def test_kind_filter_is_validated(self, client):
        assert (await client.get("/alerts?kind=nonsense")).status_code == 422

    async def test_limits_are_validated(self, client):
        assert (await client.get("/alerts?limit=99999")).status_code == 422

    async def test_alert_without_followup_reports_no_verdict(self, client, repository):
        """Kein Urteil ist etwas anderes als ein schlechtes Urteil."""
        from backend.tests.test_database import make_alert

        await repository.write_batch(alerts=[make_alert()])
        row = (await client.get("/alerts")).json()[0]
        assert row["verdict"] is None
        assert row["clv_percent"] is None

    async def test_verdict_is_returned_with_plain_text(self, client, repository):
        from backend.tests.test_database import make_alert

        alert = make_alert()
        await repository.write_batch(alerts=[alert])
        await repository.resolve_alerts(
            [
                {
                    "fingerprint": alert.fingerprint,
                    "verdict": "corrected",
                    "clv_percent": 12.5,
                    "closing_odds": 2.70,
                    "closing_fair_odds": 2.66,
                }
            ]
        )
        row = (await client.get("/alerts")).json()[0]
        assert row["verdict"] == "corrected"
        assert "Buchmacher" in row["verdict_label"]
        assert row["clv_percent"] == pytest.approx(12.5)
        assert row["resolved_at"] is not None


class TestScorecard:
    async def test_empty_scorecard_is_not_an_error(self, client):
        body = (await client.get("/alerts/scorecard")).json()
        assert body["resolved"] == 0
        assert body["pending"] == 0
        assert body["avg_clv_percent"] is None

    async def test_scorecard_counts_open_and_resolved(self, client, repository):
        from backend.tests.test_database import make_alert

        alert = make_alert()
        await repository.write_batch(alerts=[alert])
        assert (await client.get("/alerts/scorecard")).json()["pending"] == 1

        await repository.resolve_alerts(
            [{"fingerprint": alert.fingerprint, "verdict": "corrected", "clv_percent": 20.0}]
        )
        body = (await client.get("/alerts/scorecard")).json()
        assert body["resolved"] == 1
        assert body["pending"] == 0
        assert body["avg_clv_percent"] == pytest.approx(20.0)
        assert body["beat_close_share"] == 100.0
        assert body["verdicts"][0]["verdict"] == "corrected"
        assert body["by_bookmaker"][0]["bookmaker"] == "examplebookie"

    async def test_window_is_validated(self, client):
        assert (await client.get("/alerts/scorecard?window_hours=0")).status_code == 422

    async def test_scorecard_route_is_not_shadowed_by_the_list(self, client):
        """/alerts/scorecard darf nicht als Alarm-Filter enden."""
        body = (await client.get("/alerts/scorecard")).json()
        assert isinstance(body, dict)


class TestStats:
    async def test_stats_combine_redis_and_database(self, client, redis_state, repository):
        await seed(redis_state, repository)
        body = (await client.get("/stats")).json()
        assert body["events_total"] == 2
        assert body["tracked_events_redis"] == 2
        assert body["live_events_redis"] == 2
        assert body["window_hours"] == 24

    async def test_stats_expose_the_followup_backlog(self, client, redis_state, repository):
        from backend.tests.test_database import make_alert

        alert = make_alert()
        await repository.write_batch(alerts=[alert])
        await redis_state.schedule_followup(alert, due_at=now_ts() + 300)
        await redis_state.add_verdicts({"corrected": 3})
        body = (await client.get("/stats")).json()
        assert body["followups_pending"] == 1
        assert body["verdicts"][0]["verdict"] == "corrected"
        assert body["verdicts"][0]["count"] == 3
        assert "Buchmacher" in body["verdicts"][0]["label"]


class TestInfrastructure:
    async def test_root(self, client):
        body = (await client.get("/")).json()
        assert body["name"]
        assert "keine Wetten" in body["hinweis"]

    async def test_openapi_is_generated(self, client):
        schema = (await client.get("/openapi.json")).json()
        assert schema["info"]["title"]
        for path in (
            "/health",
            "/events",
            "/events/live",
            "/odds",
            "/alerts",
            "/alerts/scorecard",
            "/stats",
        ):
            assert path in schema["paths"], path

    async def test_swagger_ui(self, client):
        assert (await client.get("/docs")).status_code == 200

    async def test_metrics(self, client):
        response = await client.get("/metrics")
        assert response.status_code == 200
        assert "storm_" in response.text

    async def test_security_headers(self, client):
        headers = (await client.get("/health")).headers
        assert headers["x-content-type-options"] == "nosniff"
        assert headers["x-frame-options"] == "DENY"
        assert headers["x-request-id"]

    async def test_cors_is_not_a_wildcard(self, client):
        response = await client.get("/health", headers={"Origin": "https://evil.example"})
        assert response.headers.get("access-control-allow-origin") != "*"

    async def test_configured_origin_is_allowed(self, client):
        response = await client.get("/health", headers={"Origin": "http://localhost:8080"})
        assert response.headers.get("access-control-allow-origin") == "http://localhost:8080"

    async def test_rate_limit_kicks_in(self, api_settings, redis_state, repository):
        settings = api_settings.model_copy(update={"api_rate_limit_per_minute": 3})
        app = create_app(settings)
        app.state.redis = redis_state
        app.state.repository = repository
        app.state.hub = None
        app.state.started_at = now_ts()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            codes = [(await http.get("/stats")).status_code for _ in range(6)]
        assert 429 in codes
        # Health bleibt erreichbar, damit Monitoring nie ausgesperrt wird.
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            assert (await http.get("/health")).status_code == 200
