"""Einrichtungshilfe und Kontingent-Drosselung.

Beides ist genau der Teil, der beim Umstieg von der Simulation auf echte
Daten schiefgeht: falscher Key, oder das Kontingent ist nach Stunden leer.
"""

from __future__ import annotations

import importlib.util
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from backend.providers.the_odds_api import TheOddsApiProvider
from backend.tests.test_providers import ODDS_API_PAYLOAD

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "setup_provider.py"


def load_script():
    spec = importlib.util.spec_from_file_location("setup_provider", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def script():
    return load_script()


class TestQuotaPacing:
    def _provider(self, **kwargs) -> TheOddsApiProvider:
        defaults = {
            "api_key": "test",
            "sport_keys": ["soccer_epl", "soccer_germany_bundesliga"],
            "regions": "eu,uk",
            "markets": ["h2h", "totals"],
            "poll_interval": 20.0,
        }
        defaults.update(kwargs)
        return TheOddsApiProvider(**defaults)

    def test_credits_per_cycle(self):
        # 2 Wettbewerbe x 2 Märkte x 2 Regionen
        assert self._provider().credits_per_cycle() == 8

    def test_single_sport_and_market(self):
        provider = self._provider(sport_keys=["soccer_epl"], markets=["h2h"], regions="eu")
        assert provider.credits_per_cycle() == 1

    def test_without_quota_information_the_fixed_interval_applies(self):
        provider = self._provider()
        assert provider.health.rate_limit_remaining is None
        assert provider.next_poll_delay() == 20.0

    def test_small_quota_slows_the_poll_down(self):
        """Der eigentliche Zweck: 500 Credits dürfen nicht in Minuten verglühen."""
        provider = self._provider()
        provider.health.rate_limit_remaining = 500
        delay = provider.next_poll_delay()
        assert delay > 20.0
        # Restkontingent muss bis Monatsende reichen
        seconds_left = provider._seconds_until_month_end()
        used = provider.credits_per_cycle() * seconds_left / delay
        assert used <= 500 - provider.quota_reserve + 1

    def test_large_quota_keeps_the_configured_interval(self):
        provider = self._provider()
        provider.health.rate_limit_remaining = 5_000_000
        assert provider.next_poll_delay() == 20.0

    def test_exhausted_quota_backs_right_off(self):
        provider = self._provider()
        provider.health.rate_limit_remaining = 5
        assert provider.next_poll_delay() >= 3600.0

    def test_pacing_can_be_switched_off(self):
        provider = self._provider(pace_to_quota=False)
        provider.health.rate_limit_remaining = 50
        assert provider.next_poll_delay() == 20.0

    def test_month_end_is_always_in_the_future(self):
        provider = self._provider()
        for month in range(1, 13):
            now = datetime(2026, month, 28, 12, 0, tzinfo=UTC)
            assert provider._seconds_until_month_end(now) > 0

    def test_december_rolls_into_the_new_year(self):
        provider = self._provider()
        now = datetime(2026, 12, 31, 23, 0, tzinfo=UTC)
        assert 3500 < provider._seconds_until_month_end(now) < 3700

    def test_discovery_is_capped(self):
        assert self._provider(max_discovered_sports=2).max_discovered_sports == 2


class TestEnvWriting:
    def test_existing_keys_are_replaced(self, script, tmp_path):
        env = tmp_path / ".env"
        env.write_text("# Kommentar\nPROVIDERS=betfair\nPOSTGRES_PASSWORD=geheim\n")
        script.apply_to_env(env, "PROVIDERS=the_odds_api\nODDS_API_KEY=abc")
        text = env.read_text()
        assert "PROVIDERS=the_odds_api" in text
        assert "PROVIDERS=betfair" not in text
        assert "POSTGRES_PASSWORD=geheim" in text  # fremde Werte bleiben
        assert "# Kommentar" in text  # Kommentare bleiben
        assert "ODDS_API_KEY=abc" in text

    def test_comment_lines_in_the_block_are_ignored(self, script, tmp_path):
        env = tmp_path / ".env"
        env.write_text("PROVIDERS=the_odds_api\n")
        count = script.apply_to_env(env, "# nur ein Hinweis\nPROVIDERS=the_odds_api")
        assert count == 1
        assert "# nur ein Hinweis" not in env.read_text()

    def test_missing_file_is_created(self, script, tmp_path):
        env = tmp_path / "neu.env"
        script.apply_to_env(env, "PROVIDERS=the_odds_api")
        assert env.read_text().strip() == "PROVIDERS=the_odds_api"

    def test_commented_out_keys_are_not_touched(self, script, tmp_path):
        env = tmp_path / ".env"
        env.write_text("# PROVIDERS=alt\n")
        script.apply_to_env(env, "PROVIDERS=the_odds_api")
        text = env.read_text()
        assert "# PROVIDERS=alt" in text
        assert "PROVIDERS=the_odds_api" in text


class TestScriptRun:
    """Kompletter Skriptlauf gegen eine simulierte API."""

    def _install(self, monkeypatch, handler):
        real_client = httpx.AsyncClient

        def factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            kwargs.pop("cert", None)
            return real_client(*args, **kwargs)

        monkeypatch.setattr(httpx, "AsyncClient", factory)

    async def test_valid_key_reports_events_and_quota(self, script, monkeypatch, capsys, tmp_path):
        def handler(request: httpx.Request) -> httpx.Response:
            headers = {"x-requests-remaining": "480", "x-requests-used": "20"}
            if request.url.path.endswith("/sports"):
                return httpx.Response(
                    200,
                    json=[
                        {"key": "soccer_germany_bundesliga", "active": True},
                        {"key": "tennis_atp_paris", "active": True},
                        {"key": "basketball_nba", "active": True},
                    ],
                    headers=headers,
                )
            return httpx.Response(200, json=ODDS_API_PAYLOAD, headers=headers)

        self._install(monkeypatch, handler)
        args = script.build_parser().parse_args(
            ["the_odds_api", "--key", "geheim", "--env", str(tmp_path / ".env")]
        )
        assert await script.check_the_odds_api(args) == 0

        out = capsys.readouterr().out
        assert "Key gültig" in out
        assert "480" in out
        assert "soccer_germany_bundesliga" in out
        assert "basketball_nba" not in out  # andere Sportarten ignorieren
        assert "Bayern Munich vs Borussia Dortmund" in out
        assert "Kosten je Durchlauf" in out
        assert "Restkontingent für einen Abruf alle" in out  # Drosselung erklärt
        assert "ODDS_API_PACE_TO_QUOTA=true" in out
        assert "ODDS_API_POLL_INTERVAL=60" in out  # nur Untergrenze, nicht der Takt
        assert "MAX_ODDS_AGE_SECONDS" in out  # der stille Killer beim Umstieg
        assert "geheim" in out  # .env-Block enthält den Key

    async def test_invalid_key_fails_clearly(self, script, monkeypatch, capsys, tmp_path):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"message": "invalid key"})

        self._install(monkeypatch, handler)
        args = script.build_parser().parse_args(
            ["the_odds_api", "--key", "falsch", "--env", str(tmp_path / ".env")]
        )
        assert await script.check_the_odds_api(args) == 1
        out = capsys.readouterr().out
        assert "FEHL" in out
        assert "the-odds-api.com/account" in out

    async def test_out_of_season_is_explained(self, script, monkeypatch, capsys, tmp_path):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[], headers={"x-requests-remaining": "500"})

        self._install(monkeypatch, handler)
        args = script.build_parser().parse_args(
            ["the_odds_api", "--key", "k", "--env", str(tmp_path / ".env")]
        )
        assert await script.check_the_odds_api(args) == 1
        assert "Spielpausen" in capsys.readouterr().out

    async def test_write_updates_the_env_file(self, script, monkeypatch, capsys, tmp_path):
        def handler(request: httpx.Request) -> httpx.Response:
            headers = {"x-requests-remaining": "480"}
            if request.url.path.endswith("/sports"):
                return httpx.Response(
                    200, json=[{"key": "soccer_epl", "active": True}], headers=headers
                )
            return httpx.Response(200, json=ODDS_API_PAYLOAD, headers=headers)

        env = tmp_path / ".env"
        env.write_text("PROVIDERS=betfair\nPOSTGRES_PASSWORD=geheim\n")
        self._install(monkeypatch, handler)
        args = script.build_parser().parse_args(
            ["the_odds_api", "--key", "abc123", "--env", str(env), "--write"]
        )
        assert await script.check_the_odds_api(args) == 0
        text = env.read_text()
        assert "PROVIDERS=the_odds_api" in text
        assert "ODDS_API_KEY=abc123" in text
        assert "POSTGRES_PASSWORD=geheim" in text
        assert "PROVIDERS=betfair" not in text


class TestHumanInterval:
    @pytest.mark.parametrize(
        ("seconds", "expected"),
        [(30, "Sekunden"), (600, "Minuten"), (7200, "Stunden"), (200000, "Tage")],
    )
    def test_units(self, script, seconds, expected):
        assert expected in script.human_interval(seconds)


class TestSportsGameOddsEinrichtung:
    """Die Einrichtungshilfe für die Live-Quelle.

    Ihr wichtigster Zweck ist nicht der Key-Test, sondern die Anzeige des
    umgerechneten Preises: ob "-110" amerikanisch gemeint ist, entscheidet
    über jeden Preis im System, und das lässt sich nur am echten Konto prüfen.
    """

    def _args(self, script, **overrides):
        from types import SimpleNamespace

        base = {
            "provider": "sportsgameodds",
            "key": "k" * 20,
            "leagues": "",
            "sports": "SOCCER",
            "live": False,
            "limit": 25,
            "env": "/dev/null",
            "write": False,
            "base_url": "https://api.sportsgameodds.com/v2",
            "plan": "free",
        }
        base.update(overrides)
        return SimpleNamespace(**base)

    def _patch(self, script, monkeypatch, handler):
        from backend.providers import sportsgameodds as sgo

        original = sgo.SportsGameOddsProvider.connect

        async def connect(self):
            await original(self)
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                transport=httpx.MockTransport(handler),
                headers={"x-api-key": self._api_key},
            )

        monkeypatch.setattr(sgo.SportsGameOddsProvider, "connect", connect)

    async def test_a_valid_key_shows_converted_prices(self, script, monkeypatch, capsys):
        from backend.tests.test_sportsgameodds import event, page

        self._patch(script, monkeypatch, lambda r: httpx.Response(200, json=page([event()])))
        code = await script.check_sportsgameodds(self._args(script))
        out = capsys.readouterr().out
        assert code == 0
        assert "Key akzeptiert" in out
        assert "Quotenformat prüfen" in out
        assert "2.500" in out, "die umgerechnete Quote muss sichtbar sein"
        assert "bet365" in out

    async def test_an_invalid_key_is_named_as_such(self, script, monkeypatch, capsys):
        self._patch(script, monkeypatch, lambda r: httpx.Response(401, json={}))
        code = await script.check_sportsgameodds(self._args(script))
        assert code == 2
        assert "abgelehnt" in capsys.readouterr().out

    async def test_events_without_odds_fail_loudly(self, script, monkeypatch, capsys):
        """Ein abweichendes Schema darf nicht als leerer Markt durchgehen."""
        from backend.tests.test_sportsgameodds import event, market, page

        raw = event(odds={"x": market(betTypeID="voellig_anders")})
        self._patch(script, monkeypatch, lambda r: httpx.Response(200, json=page([raw])))
        code = await script.check_sportsgameodds(self._args(script))
        out = capsys.readouterr().out
        assert code == 3
        assert "keine einzige verwertbare Quote" in out
        assert "abweichendes Antwortschema" in out

    async def test_skipped_markets_are_listed(self, script, monkeypatch, capsys):
        from backend.tests.test_sportsgameodds import event, market, page

        raw = event(
            odds={
                "a": market(),
                "b": market(sideID="PLAYER_9"),
            }
        )
        self._patch(script, monkeypatch, lambda r: httpx.Response(200, json=page([raw])))
        await script.check_sportsgameodds(self._args(script))
        out = capsys.readouterr().out
        assert "Übersprungen" in out
        assert "seite:PLAYER_9" in out

    async def test_live_flag_reaches_the_api(self, script, monkeypatch, capsys):
        from backend.tests.test_sportsgameodds import page

        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(dict(request.url.params))
            return httpx.Response(200, json=page([]))

        self._patch(script, monkeypatch, handler)
        await script.check_sportsgameodds(self._args(script, live=True))
        assert seen.get("live") == "true"

    async def test_the_env_block_is_printed(self, script, monkeypatch, capsys):
        from backend.tests.test_sportsgameodds import event, page

        self._patch(script, monkeypatch, lambda r: httpx.Response(200, json=page([event()])))
        await script.check_sportsgameodds(self._args(script, live=True))
        out = capsys.readouterr().out
        assert "PROVIDERS=sportsgameodds" in out
        assert "SGO_LIVE_ONLY=true" in out
        assert "SGO_API_KEY=" in out


class TestTarifvoreinstellung:
    """``--plan`` setzt Poll-Takt und Limit passend zum gebuchten Tarif."""

    def test_every_plan_stays_within_its_own_limit(self, script):
        for name, plan in script.PLANS.items():
            per_minute = 60.0 / plan["poll"] * plan["pages"]
            assert per_minute <= plan["rpm"], (name, per_minute, plan["rpm"])

    def test_pro_polls_faster_than_free(self, script):
        assert script.PLANS["pro"]["poll"] < script.PLANS["free"]["poll"]
        assert script.PLANS["pro"]["rpm"] > script.PLANS["free"]["rpm"]

    def test_the_max_age_follows_the_poll_rate(self, script):
        """Ein Quotenalter unter dem Poll-Takt ließe nie einen Alarm zu."""
        for name, plan in script.PLANS.items():
            assert plan["max_age"] >= 2 * plan["poll"], name

    async def test_the_plan_lands_in_the_env_block(self, script, monkeypatch, capsys):
        from backend.tests.test_sportsgameodds import event, page

        klass = TestSportsGameOddsEinrichtung()
        klass._patch(script, monkeypatch, lambda r: httpx.Response(200, json=page([event()])))
        args = klass._args(script, plan="pro")
        await script.check_sportsgameodds(args)
        out = capsys.readouterr().out
        assert "SGO_RATE_LIMIT_PER_MINUTE=300" in out
        assert "SGO_POLL_INTERVAL=5" in out
        assert "36 Anfragen/Minute von 300" in out
