"""HTTP-API: Endpunkte, Schemata, Rate-Limit."""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio

from backend.api.app import create_app
from backend.core.config import Settings
from backend.models.domain import now_ts
from backend.models.enums import AlertKind
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
        assert keys == {"the_odds_api", "sportsgameodds", "betfair"}

    async def test_missing_credentials_are_reported(self, client):
        rows = {row["key"]: row for row in (await client.get("/health/providers")).json()}
        assert rows["the_odds_api"]["missing_credentials"] == ["ODDS_API_KEY"]
        assert rows["sportsgameodds"]["missing_credentials"] == ["SGO_API_KEY"]
        assert rows["betfair"]["missing_credentials"]

    async def test_provider_catalogue(self, client):
        rows = (await client.get("/providers")).json()
        assert {row["key"] for row in rows} == {"the_odds_api", "sportsgameodds", "betfair"}
        assert all("docs_url" in row for row in rows)

    async def test_without_credentials_nothing_is_enabled(self, client):
        """Es gibt keine Quelle mehr, die ohne Zugangsdaten läuft."""
        rows = (await client.get("/providers")).json()
        assert not any(row["enabled"] for row in rows)
        assert all(row["missing_credentials"] for row in rows)


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


class TestAbgelaufeneEvents:
    """Ein beendetes Spiel meldet bei den üblichen Quellen kein "beendet" -
    es verschwindet einfach aus der Antwort. Dann darf es auch nicht weiter
    als laufend im Dashboard stehen."""

    @staticmethod
    async def _veraltetes_live_event(redis_state, alter: float = 3600.0):
        event = make_event(event_id="alt")
        event.updated_at = now_ts() - alter
        await redis_state.set_event(event)
        return event

    async def test_altes_event_faellt_aus_der_live_liste(self, client, redis_state):
        await self._veraltetes_live_event(redis_state)
        assert (await client.get("/events/live")).json() == []

    async def test_es_wird_nicht_beendet_behauptet_sondern_alter_genannt(self, client, redis_state):
        """Keine Daten mehr heißt nicht zwingend "Spiel vorbei" - es kann
        auch die Quelle sein. Also nur sagen, was stimmt."""
        await self._veraltetes_live_event(redis_state)
        row = (await client.get("/events")).json()[0]
        assert row["status"] == "LIVE"  # nichts erfunden
        assert row["stale"] is True
        assert row["seconds_since_update"] > 3000

    async def test_frisches_event_bleibt_live(self, client, redis_state, repository):
        await seed(redis_state, repository)
        rows = (await client.get("/events/live")).json()
        assert len(rows) == 2
        assert all(row["stale"] is False for row in rows)
        assert all(row["seconds_since_update"] < 60 for row in rows)

    async def test_datenbank_springt_nicht_mit_alten_zeilen_ein(
        self, client, redis_state, repository
    ):
        """Der Rückfall auf die Datenbank ist für den leeren Redis gedacht.
        Kennt Redis das Event und ist es nur zu alt, wäre dieselbe Zeile aus
        der Datenbank die falsche Antwort."""
        event = await self._veraltetes_live_event(redis_state)
        await repository.write_batch(events=[event])
        assert (await client.get("/events/live")).json() == []

    async def test_aufraeumer_nimmt_die_id_aus_der_live_menge(self, redis_state):
        await self._veraltetes_live_event(redis_state)
        frisch = make_event(event_id="frisch")
        await redis_state.set_event(frisch)
        assert set(await redis_state.live_event_ids()) == {"alt", "frisch"}

        entfernt = await redis_state.prune_live_events(180.0)
        assert entfernt == ["alt"]
        assert await redis_state.live_event_ids() == ["frisch"]
        assert (await redis_state.counters())["live_events"] == 1

    async def test_leiche_ohne_snapshot_fliegt_auch_raus(self, redis_state):
        """Der Event-Schlüssel läuft ab, die ID in der Live-Menge nicht -
        ohne diesen Fall bliebe eine Karteileiche für immer stehen."""
        await redis_state.client.sadd("ev:live", "verwaist")
        assert await redis_state.prune_live_events(180.0) == ["verwaist"]
        assert await redis_state.live_event_ids() == []

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


class TestEmpfehlungen:
    """Die Bestenliste: was man jetzt spielen würde."""

    @staticmethod
    def _mit_empfehlung(**overrides):
        from backend.core.recommendation import evaluate
        from backend.tests.test_database import make_alert

        alert = make_alert(**overrides)
        alert.recommendation = evaluate(alert).to_json()
        return alert

    async def test_alarm_traegt_seine_empfehlung(self, client, repository):
        alert = self._mit_empfehlung(value_percent=11.0, odds=2.10)
        await repository.write_batch(alerts=[alert])
        row = (await client.get("/alerts")).json()[0]
        assert row["recommendation"]["grade"] in {"strong", "moderate", "weak", "skip"}
        assert row["recommendation"]["play"]

    async def test_alter_alarm_ohne_empfehlung_bleibt_null(self, client, repository):
        from backend.tests.test_database import make_alert

        await repository.write_batch(alerts=[make_alert()])
        assert (await client.get("/alerts")).json()[0]["recommendation"] is None

    async def test_filter_nach_grad(self, client, repository):
        spielbar = self._mit_empfehlung(value_percent=11.0, odds=2.10)
        absurd = self._mit_empfehlung(value_percent=250.0, odds=9.0, bookmaker="anderer")
        await repository.write_batch(alerts=[spielbar, absurd])
        skip = (await client.get("/alerts?grade=skip")).json()
        assert [row["bookmaker"] for row in skip] == ["anderer"]
        assert (await client.get("/alerts?grade=nonsense")).status_code == 422

    async def test_bestenliste_nennt_wette_und_einsatz(self, client, repository):
        alert = self._mit_empfehlung(value_percent=11.0, odds=2.10)
        await repository.write_batch(alerts=[alert])
        body = (await client.get("/alerts/recommendations")).json()
        assert body["considered"] == 1
        assert len(body["picks"]) == 1
        pick = body["picks"][0]
        assert pick["alert"]["bookmaker"] == "examplebookie"
        assert pick["recommendation"]["stake_percent"] > 0
        assert "Einsatz" in pick["recommendation"]["play"]
        assert body["total_stake_percent"] == pytest.approx(pick["recommendation"]["stake_percent"])

    async def test_leere_bestenliste_nennt_den_grund(self, client, repository):
        """Der Fehler, den dieses Projekt nicht mehr machen darf: nichts
        anzeigen und nicht sagen, warum."""
        await repository.write_batch(alerts=[self._mit_empfehlung(value_percent=250.0)])
        body = (await client.get("/alerts/recommendations")).json()
        assert body["picks"] == []
        assert body["dropped"]
        assert body["dropped"][0]["code"] == "unplausibel"
        assert body["dropped"][0]["label"]

    async def test_absurder_value_steht_nicht_oben(self, client, repository):
        massvoll = self._mit_empfehlung(
            value_percent=11.0, odds=2.10, event=make_event(event_id="m1")
        )
        absurd = self._mit_empfehlung(
            value_percent=180.0, odds=8.0, event=make_event(event_id="a1")
        )
        await repository.write_batch(alerts=[massvoll, absurd])
        picks = (await client.get("/alerts/recommendations")).json()["picks"]
        assert [pick["alert"]["event_id"] for pick in picks] == [massvoll.event.event_id]

    async def test_altes_fenster_liefert_nichts(self, client, repository):
        alert = self._mit_empfehlung(value_percent=11.0, odds=2.10)
        alert.detected_at = now_ts() - 7200
        await repository.write_batch(alerts=[alert])
        body = (await client.get("/alerts/recommendations?window_minutes=15")).json()
        assert body["considered"] == 0
        assert body["picks"] == []

    async def test_hinweis_steht_in_jeder_antwort(self, client):
        body = (await client.get("/alerts/recommendations")).json()
        assert "Keine Wettberatung" in body["disclaimer"]
        assert "nichts automatisch gesetzt" in body["disclaimer"]

    async def test_kennzahlen_zaehlen_die_grade(self, client, redis_state):
        await redis_state.add_grades({"strong": 2, "skip": 7})
        body = (await client.get("/stats")).json()
        codes = {entry["code"]: entry["count"] for entry in body["grades"]}
        assert codes == {"strong": 2, "skip": 7}
        assert body["playable_alerts"] == 2


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


class TestKennzahlenBleibenWiderspruchsfrei:
    """Die Kachel darf nicht "1 Live-Event" sagen, während die Liste
    darunter "keine laufenden Events" zeigt - beides aus derselben Menge."""

    async def test_veraltetes_event_zaehlt_nicht_als_live(self, client, redis_state):
        event = make_event(event_id="alt")
        event.updated_at = now_ts() - 3600
        await redis_state.set_event(event)

        body = (await client.get("/stats")).json()
        assert body["live_events_redis"] == 0
        assert body["tracked_events_redis"] == 1
        assert (await client.get("/events/live")).json() == []

    async def test_frisches_event_zaehlt(self, client, redis_state):
        await redis_state.set_event(make_event(event_id="frisch"))
        assert (await client.get("/stats")).json()["live_events_redis"] == 1


class TestWettTagebuch:
    """Lesen ist offen, Schreiben nicht - und die Bilanz rechnet mit dem,
    was wirklich passiert ist."""

    @pytest_asyncio.fixture
    async def schreib_client(self, redis_state, repository):
        """Eigene App mit freigeschaltetem Schreibzugriff."""
        settings = Settings(
            _env_file=None,
            api_rate_limit_per_minute=1000,
            log_json=False,
            betlog_api_writes=True,
            bankroll=1000.0,
        )
        app = create_app(settings)
        app.state.redis = redis_state
        app.state.repository = repository
        app.state.hub = None
        app.state.started_at = now_ts()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            yield http

    async def test_schreiben_ist_standardmaessig_zu(self, client, repository):
        response = await client.post("/bets", json={"event_id": "e1", "odds": 2.0, "stake": 10.0})
        assert response.status_code == 403
        assert "Dashboard" in response.json()["detail"]

    async def test_lesen_geht_auch_ohne_schreibrecht(self, client):
        assert (await client.get("/bets")).status_code == 200
        assert (await client.get("/bets/ledger")).json()["total"] == 0

    async def test_wette_von_hand_eintragen(self, schreib_client):
        response = await schreib_client.post(
            "/bets",
            json={
                "event_id": "e1",
                "event_title": "A vs B",
                "odds": 2.50,
                "stake": 10.0,
                "bookmaker": "bet365",
            },
        )
        assert response.status_code == 201
        body = response.json()
        assert body["status"] == "open"
        assert body["status_label"] == "offen"
        assert body["profit"] is None

    async def test_wette_aus_einem_alarm_uebernimmt_alles(self, schreib_client, repository):
        from backend.core.recommendation import RecommendationConfig, evaluate
        from backend.tests.test_database import make_alert

        alert = make_alert(kind=AlertKind.VALUE, odds=2.50, value_percent=11.0)
        alert.recommendation = evaluate(alert, RecommendationConfig(bankroll=1000.0)).to_json()
        await repository.write_batch(alerts=[alert])

        body = (
            await schreib_client.post("/bets", json={"alert_fingerprint": alert.fingerprint})
        ).json()
        assert body["event_title"] == "Bayern München vs Borussia Dortmund"
        assert body["bookmaker"] == "examplebookie"
        assert body["odds"] == pytest.approx(2.50)
        assert body["stake"] > 0
        # Was die Empfehlung versprach, wird mitgeschrieben - sonst lässt
        # sich später nicht vergleichen.
        assert body["expected_edge_percent"] is not None

    async def test_genommene_quote_darf_abweichen(self, schreib_client, repository):
        """Der Preis beim Klicken ist meist ein anderer als der gemeldete."""
        from backend.core.recommendation import evaluate
        from backend.tests.test_database import make_alert

        alert = make_alert(kind=AlertKind.VALUE, odds=2.50, value_percent=11.0)
        alert.recommendation = evaluate(alert).to_json()
        await repository.write_batch(alerts=[alert])
        body = (
            await schreib_client.post(
                "/bets",
                json={"alert_fingerprint": alert.fingerprint, "odds": 2.30, "stake": 10.0},
            )
        ).json()
        assert body["odds"] == pytest.approx(2.30)

    async def test_unbekannter_alarm_ist_404(self, schreib_client):
        response = await schreib_client.post("/bets", json={"alert_fingerprint": "gibtsnicht"})
        assert response.status_code == 404

    async def test_ohne_alarm_braucht_es_die_eckdaten(self, schreib_client):
        assert (await schreib_client.post("/bets", json={"note": "nichts"})).status_code == 422

    async def test_abrechnen_setzt_den_gewinn(self, schreib_client):
        bet_id = (
            await schreib_client.post("/bets", json={"event_id": "e1", "odds": 2.50, "stake": 10.0})
        ).json()["id"]

        gewonnen = (
            await schreib_client.post(f"/bets/{bet_id}/settle", json={"status": "won"})
        ).json()
        assert gewonnen["profit"] == pytest.approx(15.0)
        assert gewonnen["settled_at"] is not None

        ledger = (await schreib_client.get("/bets/ledger")).json()
        assert ledger["profit"] == pytest.approx(15.0)
        assert ledger["staked"] == pytest.approx(10.0)
        assert ledger["roi_percent"] == pytest.approx(150.0)
        # Eine Rendite aus einer Wette ist keine Rendite.
        assert ledger["reliable"] is False
        assert ledger["notes"]

    async def test_zurueck_auf_offen_loescht_die_abrechnung(self, schreib_client):
        bet_id = (
            await schreib_client.post("/bets", json={"event_id": "e1", "odds": 2.0, "stake": 5.0})
        ).json()["id"]
        await schreib_client.post(f"/bets/{bet_id}/settle", json={"status": "lost"})
        wieder = (
            await schreib_client.post(f"/bets/{bet_id}/settle", json={"status": "open"})
        ).json()
        assert wieder["profit"] is None
        assert wieder["settled_at"] is None

    async def test_unbekannter_ausgang_wird_abgelehnt(self, schreib_client):
        response = await schreib_client.post("/bets/1/settle", json={"status": "vielleicht"})
        assert response.status_code == 422

    async def test_loeschen(self, schreib_client):
        bet_id = (
            await schreib_client.post("/bets", json={"event_id": "e1", "odds": 2.0, "stake": 5.0})
        ).json()["id"]
        assert (await schreib_client.delete(f"/bets/{bet_id}")).status_code == 204
        assert (await schreib_client.delete(f"/bets/{bet_id}")).status_code == 404

    async def test_einheit_haengt_an_der_bankroll(self, client, schreib_client):
        """Ohne Bankroll sind Einsätze Anteile, keine Beträge."""
        assert (await client.get("/bets/ledger")).json()["unit"] == "% der Bankroll"
        assert (await schreib_client.get("/bets/ledger")).json()["unit"] == "Kontowährung"

    async def test_kennzahlen_verraten_ob_der_knopf_sinn_hat(self, client, schreib_client):
        assert (await client.get("/stats")).json()["betlog_writes"] is False
        assert (await schreib_client.get("/stats")).json()["betlog_writes"] is True
