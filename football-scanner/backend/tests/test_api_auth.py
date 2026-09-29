from sqlalchemy import select

from app.models import ApiCredential, UserSession
from tests.conftest import register


def test_first_user_is_admin_and_later_users_are_not(client, db):
    from fastapi.testclient import TestClient

    from app.main import app

    assert register(client, "a@example.com")["role"] == "admin"
    with TestClient(app) as other:
        assert register(other, "b@example.com")["role"] == "user"


def test_registration_validation(client):
    assert (
        client.post("/api/auth/register", json={"email": "bad", "password": "x" * 12}).status_code
        == 422
    )
    assert (
        client.post("/api/auth/register", json={"email": "a@b.co", "password": "short"}).status_code
        == 422
    )
    register(client, "a@b.co")
    r = client.post("/api/auth/register", json={"email": "A@B.co", "password": "x" * 12})
    assert r.status_code == 409


def test_session_cookie_is_http_only_and_stored_hashed(client, db):
    r = client.post("/api/auth/register", json={"email": "c@example.com", "password": "x" * 12})
    cookie = r.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie
    token = client.cookies.get("fvs_session")
    stored = db.scalar(select(UserSession.token_hash))
    assert token and stored and token != stored


def test_login_logout_cycle(client):
    register(client, "d@example.com")
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    bad = client.post(
        "/api/auth/login", json={"email": "d@example.com", "password": "wrong password"}
    )
    assert bad.status_code == 401
    ok = client.post(
        "/api/auth/login", json={"email": "d@example.com", "password": "correct horse battery"}
    )
    assert ok.status_code == 200
    assert client.get("/api/auth/me").json()["email"] == "d@example.com"


def test_login_is_rate_limited(client):
    register(client, "e@example.com")
    for _ in range(10):
        client.post("/api/auth/login", json={"email": "e@example.com", "password": "nope nope"})
    r = client.post("/api/auth/login", json={"email": "e@example.com", "password": "nope nope"})
    assert r.status_code == 429


def test_foreign_origin_is_rejected_for_state_changes(admin_client):
    r = admin_client.post("/api/auth/logout", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert (
        admin_client.get("/api/auth/me", headers={"Origin": "https://evil.example"}).status_code
        == 200
    )


def test_admin_routes_require_admin(user_client):
    assert user_client.get("/api/admin/users").status_code == 403
    assert user_client.get("/api/dashboard").status_code == 200


def test_unauthenticated_requests_are_refused(client):
    for path in ("/api/dashboard", "/api/matches", "/api/history", "/api/meta"):
        assert client.get(path).status_code == 401


def test_api_key_is_encrypted_and_masked(admin_client, db):
    r = admin_client.put(
        "/api/admin/api-keys", json={"provider": "the_odds_api", "key": "abcd1234efgh5678"}
    )
    assert r.status_code == 200
    entry = next(k for k in r.json() if k["provider"] == "the_odds_api")
    assert entry["configured"] and entry["source"] == "admin"
    assert entry["masked"] == "abcd••••••••5678"
    row = db.get(ApiCredential, "the_odds_api")
    assert "abcd1234efgh5678" not in row.encrypted_key
    r = admin_client.put("/api/admin/api-keys", json={"provider": "the_odds_api", "key": None})
    assert not next(k for k in r.json() if k["provider"] == "the_odds_api")["configured"]


def test_last_admin_cannot_be_demoted(admin_client):
    me = admin_client.get("/api/auth/me").json()
    r = admin_client.patch(f"/api/admin/users/{me['id']}", json={"role": "user"})
    assert r.status_code == 409


def test_settings_round_trip_and_unknown_key(admin_client):
    r = admin_client.put("/api/admin/settings/signal_policy", json={"min_value": 5})
    assert r.status_code == 200 and r.json()["min_value"] == 5 and r.json()["max_risk"] == "HIGH"
    assert admin_client.put("/api/admin/settings/nope", json={}).status_code == 404
    bad = admin_client.put("/api/admin/settings/signal_policy", json={"min_value": "lots"})
    assert bad.status_code == 422
    assert (
        admin_client.put(
            "/api/admin/settings/signal_policy", json={"max_risk": "EXTREME"}
        ).status_code
        == 422
    )
    assert admin_client.get("/api/admin/settings").json()["signal_policy"]["min_value"] == 5


def test_job_request_is_queued(admin_client):
    r = admin_client.post("/api/admin/jobs/odds/run")
    assert r.status_code == 202
    jobs = {j["name"]: j for j in admin_client.get("/api/admin/jobs").json()}
    assert jobs["odds"]["requested"] is True


def test_bankroll_calculator(admin_client):
    r = admin_client.post(
        "/api/bankroll/calculate",
        json={"bankroll": 5000, "method": "percentage", "percent": 1, "cap_percent": 0},
    )
    assert r.status_code == 200 and r.json()["stake"] == 50
    r = admin_client.post(
        "/api/bankroll/calculate",
        json={"bankroll": 5000, "method": "half_kelly", "probability": 0.6, "odds": 2.0},
    )
    assert r.json()["capped"] and r.json()["stake"] == 100  # 2% default cap
    r = admin_client.post("/api/bankroll/calculate", json={"bankroll": 5000, "method": "kelly"})
    assert r.status_code == 422


def test_empty_dashboard_reports_missing_configuration(admin_client):
    d = admin_client.get("/api/dashboard").json()
    assert d["matches_today"] == 0 and d["value_opportunities"] == 0
    assert d["data_status"]["football_api_configured"] is False
