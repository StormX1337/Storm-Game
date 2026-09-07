"""Strukturiertes Logging mit Secret-Redaction.

Es wird bewusst ein Redaction-Prozessor eingehängt: Telegram-Token, API-Keys
und Passwörter dürfen niemals in Logs landen - auch nicht versehentlich über
eine URL oder eine Exception-Message.
"""

from __future__ import annotations

import logging
import re
import sys
from typing import Any

import structlog

_SECRET_KEYS = {
    "token",
    "api_key",
    "apikey",
    "password",
    "passwd",
    "secret",
    "authorization",
    "x-authentication",
    "session_token",
    "ssoid",
    "telegram_bot_token",
    "odds_api_key",
    "betfair_app_key",
    "betfair_password",
}

_URL_SECRET_RE = re.compile(r"(?i)\b(apikey|api_key|token|password|passwd|secret|key)=([^&\s\"']+)")
_BASIC_AUTH_RE = re.compile(r"(?i)(?P<scheme>[a-z+]+://)(?P<user>[^:/@\s]+):(?P<pw>[^@/\s]+)@")
_TG_TOKEN_RE = re.compile(r"\b\d{6,12}:[A-Za-z0-9_\-]{30,}\b")

REDACTED = "***redacted***"


def scrub(value: Any) -> Any:
    """Ersetzt Secrets in Strings/Dicts/Listen rekursiv."""
    if isinstance(value, str):
        out = _URL_SECRET_RE.sub(lambda m: f"{m.group(1)}={REDACTED}", value)
        out = _BASIC_AUTH_RE.sub(lambda m: f"{m.group('scheme')}{m.group('user')}:{REDACTED}@", out)
        out = _TG_TOKEN_RE.sub(REDACTED, out)
        return out
    if isinstance(value, dict):
        return {
            k: (REDACTED if str(k).lower() in _SECRET_KEYS else scrub(v)) for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return type(value)(scrub(v) for v in value)
    return value


def _component_processor(_logger: Any, _name: str, event_dict: dict) -> dict:
    """Sicherstellen, dass jeder Eintrag ein ``component``-Feld hat."""
    event_dict.setdefault("component", "-")
    return event_dict


def _redact_processor(_logger: Any, _name: str, event_dict: dict) -> dict:
    for key in list(event_dict.keys()):
        if str(key).lower() in _SECRET_KEYS:
            event_dict[key] = REDACTED
        else:
            event_dict[key] = scrub(event_dict[key])
    return event_dict


class _HumanRenderer:
    """Kompaktes, gut lesbares Format für die Konsole.

    Beispiel::

        2026-09-07 14:31:22.421 INFO  [scanner] LIVE Bayern-Dortmund Over 2.5 ...
    """

    _COLOURS = {
        "debug": "\033[38;5;244m",
        "info": "\033[38;5;39m",
        "warning": "\033[38;5;214m",
        "error": "\033[38;5;203m",
        "critical": "\033[38;5;199m",
    }
    _RESET = "\033[0m"

    def __init__(self, colours: bool) -> None:
        self.colours = colours

    def __call__(self, _logger: Any, _name: str, event_dict: dict) -> str:
        ts = str(event_dict.pop("timestamp", ""))
        if "." in ts:
            ts = ts[: ts.index(".") + 4]  # Millisekunden reichen
        level = str(event_dict.pop("level", "info")).lower()
        component = event_dict.pop("component", None) or "-"
        event_dict.pop("logger", None)
        event = event_dict.pop("event", "")
        rest = " ".join(f"{k}={v}" for k, v in event_dict.items() if v is not None)
        prefix = f"{ts} {level.upper():<7} [{component}] {event}"
        line = f"{prefix} {rest}".rstrip()
        if self.colours:
            colour = self._COLOURS.get(level, "")
            return f"{colour}{line}{self._RESET}"
        return line


def configure_logging(level: str = "INFO", json_logs: bool = True) -> None:
    """Richtet structlog + stdlib-logging ein (idempotent)."""
    numeric = getattr(logging, level.upper(), logging.INFO)

    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="%Y-%m-%d %H:%M:%S.%f", utc=False),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.UnicodeDecoder(),
        _component_processor,
        _redact_processor,
    ]

    renderer: Any
    if json_logs:
        shared.append(structlog.processors.format_exc_info)
        renderer = structlog.processors.JSONRenderer()
    else:
        shared.append(structlog.processors.ExceptionPrettyPrinter())
        renderer = _HumanRenderer(colours=sys.stderr.isatty())

    structlog.configure(
        processors=[*shared, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(numeric),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )

    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=numeric, force=True)
    for noisy in ("httpx", "httpcore", "asyncio", "telegram.ext", "hpack", "aiosqlite"):
        logging.getLogger(noisy).setLevel(max(numeric, logging.WARNING))


def get_logger(component: str) -> Any:
    """Logger für eine Komponente (z. B. ``scanner``, ``api``).

    Gibt bewusst den *lazy* Proxy von structlog zurück: Module legen ihren
    Logger beim Import an, konfiguriert wird aber erst im ``main()`` des
    jeweiligen Workers. Ein früh gebundener Logger würde die Default-
    Konfiguration einfrieren.
    """
    # Initial-Werte als kwargs: der Proxy bleibt lazy und übernimmt die
    # Konfiguration, die beim ersten Log-Aufruf aktiv ist.
    return structlog.get_logger(component=component)
