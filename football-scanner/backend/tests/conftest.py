import contextlib
import os

os.environ.setdefault("FVS_SECRET_KEY", "test-secret-key-used-only-by-the-test-suite-000")
os.environ["FVS_DATABASE_URL"] = os.environ.get(
    "FVS_TEST_DATABASE_URL", "postgresql+psycopg://scanner:scanner@127.0.0.1:5432/scanner_test"
)
os.environ["FVS_REDIS_URL"] = os.environ.get("FVS_TEST_REDIS_URL", "redis://127.0.0.1:6379/15")
os.environ["FVS_COOKIE_SECURE"] = "false"
os.environ["FVS_ALLOWED_ORIGINS"] = "http://testserver,http://localhost:3000"
os.environ.pop("FVS_API_FOOTBALL_KEY", None)
os.environ.pop("FVS_THE_ODDS_API_KEY", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import cache  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db import Base, engine, session_factory  # noqa: E402

get_settings.cache_clear()


@pytest.fixture(scope="session")
def _schema():
    import app.models  # noqa: F401

    eng = engine()
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    yield
    Base.metadata.drop_all(eng)


@pytest.fixture
def db(_schema):
    eng = engine()
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    with eng.begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    with contextlib.suppress(Exception):
        cache.client().flushdb()
    session = session_factory()()
    yield session
    session.close()


@pytest.fixture
def client(db):
    from app.main import app

    with TestClient(app) as c:
        yield c


def register(client: TestClient, email: str, password: str = "correct horse battery") -> dict:
    r = client.post("/api/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def admin_client(client):
    register(client, "admin@example.com")
    return client


@pytest.fixture
def user_client(db):
    """A second, non-admin user in a separate cookie jar."""
    from app.main import app

    with TestClient(app) as admin, TestClient(app) as user:
        register(admin, "first@example.com")
        register(user, "user@example.com")
        yield user
