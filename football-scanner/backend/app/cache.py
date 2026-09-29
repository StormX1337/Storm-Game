"""Redis helpers. Redis is an accelerator here, never a source of truth:
if it is down, reads miss and the caller goes to the database or the API."""

import contextlib
import json
import logging
from typing import Any

import redis

from app.config import get_settings

log = logging.getLogger(__name__)
_client: redis.Redis | None = None


def client() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(
            get_settings().redis_url, socket_timeout=2, decode_responses=True
        )
    return _client


def get_json(key: str) -> Any | None:
    try:
        raw = client().get(key)
    except redis.RedisError as exc:
        log.warning("redis get failed: %s", exc)
        return None
    return json.loads(raw) if raw else None


def set_json(key: str, value: Any, ttl_seconds: int) -> None:
    try:
        client().set(key, json.dumps(value, default=str), ex=ttl_seconds)
    except redis.RedisError as exc:
        log.warning("redis set failed: %s", exc)


def delete_prefix(prefix: str) -> None:
    try:
        c = client()
        for key in c.scan_iter(f"{prefix}*"):
            c.delete(key)
    except redis.RedisError as exc:
        log.warning("redis delete failed: %s", exc)


def acquire_lock(name: str, ttl_seconds: int) -> bool:
    try:
        return bool(client().set(f"lock:{name}", "1", nx=True, ex=ttl_seconds))
    except redis.RedisError as exc:
        # Without Redis there is no cross-process lock; a single worker is
        # still safe, so proceed rather than stall the pipeline.
        log.warning("redis lock unavailable (%s); continuing without it", exc)
        return True


def release_lock(name: str) -> None:
    with contextlib.suppress(redis.RedisError):
        client().delete(f"lock:{name}")


def rate_limited(key: str, limit: int, window_seconds: int) -> bool:
    """Fixed-window counter. Fails open when Redis is unavailable."""
    try:
        c = client()
        count = c.incr(f"rl:{key}")
        if count == 1:
            c.expire(f"rl:{key}", window_seconds)
        return count > limit
    except redis.RedisError:
        return False
