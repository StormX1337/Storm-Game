"""Logging: Secrets dürfen niemals in die Ausgabe gelangen."""

from __future__ import annotations

import io
import json
from contextlib import redirect_stdout

from backend.core.logging import REDACTED, configure_logging, get_logger, scrub


class TestScrubbing:
    def test_query_parameter_secrets(self):
        cleaned = scrub("https://api.example.com/v4/odds?apiKey=abc123def&regions=eu")
        assert "abc123def" not in cleaned
        assert REDACTED in cleaned
        assert "regions=eu" in cleaned

    def test_token_parameter(self):
        assert "s3cr3t" not in scrub("https://x.test/a?token=s3cr3t")

    def test_basic_auth_in_urls(self):
        cleaned = scrub("postgresql+asyncpg://storm:supersecret@postgres:5432/storm")
        assert "supersecret" not in cleaned
        assert "storm:" in cleaned

    def test_telegram_token_pattern(self):
        raw = "Fehler bei 123456789:AAHnHhE-abcdefghijklmnopqrstuvwxyz12345"
        assert "AAHnHhE" not in scrub(raw)

    def test_secret_keys_in_dicts(self):
        cleaned = scrub({"api_key": "abc", "regions": "eu", "password": "x"})
        assert cleaned == {"api_key": REDACTED, "regions": "eu", "password": REDACTED}

    def test_nested_structures(self):
        cleaned = scrub({"outer": [{"token": "abc"}, "https://x.test?apikey=zzz"]})
        assert cleaned["outer"][0]["token"] == REDACTED
        assert "zzz" not in cleaned["outer"][1]

    def test_harmless_values_are_untouched(self):
        assert scrub("Bayern München vs Dortmund") == "Bayern München vs Dortmund"
        assert scrub(42) == 42
        assert scrub(None) is None


class TestLoggerOutput:
    def test_json_logging_redacts_fields(self):
        configure_logging("INFO", json_logs=True)
        log = get_logger("test")
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            log.info("verbindung", url="https://x.test/v4?apiKey=abc123", api_key="abc123")
        payload = json.loads(buffer.getvalue().strip().splitlines()[-1])
        assert payload["api_key"] == REDACTED
        assert "abc123" not in payload["url"]
        assert payload["component"] == "test"
        assert payload["event"] == "verbindung"

    def test_human_format_is_readable(self):
        configure_logging("INFO", json_logs=False)
        log = get_logger("scanner")
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            log.info("ALERT", bookmaker="XYZ", odds=4.20)
        line = buffer.getvalue().strip().splitlines()[-1]
        assert "[scanner]" in line
        assert "ALERT" in line
        assert "odds=4.2" in line
        assert "INFO" in line

    def test_level_filtering(self):
        configure_logging("WARNING", json_logs=True)
        log = get_logger("test")
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            log.debug("unsichtbar")
            log.warning("sichtbar")
        output = buffer.getvalue()
        assert "unsichtbar" not in output
        assert "sichtbar" in output
