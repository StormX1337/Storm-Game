"""HTTP client shared by provider adapters: retries, caching, usage accounting."""

import hashlib
import json
import logging
import time
from collections.abc import Callable
from typing import Any

import httpx

from app import cache
from app.providers.base import ProviderError

log = logging.getLogger(__name__)

UsageHook = Callable[[str, str, bool, int | None], None]


class ApiClient:
    def __init__(
        self,
        provider: str,
        base_url: str,
        *,
        headers: dict[str, str] | None = None,
        params: dict[str, str] | None = None,
        timeout: float = 20.0,
        usage_hook: UsageHook | None = None,
        remaining_header: str | None = None,
        transport: httpx.BaseTransport | None = None,
        max_retries: int = 3,
    ):
        self.provider = provider
        self._params = params or {}
        self._usage_hook = usage_hook
        self._remaining_header = remaining_header
        self._max_retries = max_retries
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers=headers or {},
            timeout=timeout,
            transport=transport,
        )

    def get(self, path: str, params: dict[str, Any] | None = None, *, cache_ttl: int = 0) -> Any:
        merged = {**self._params, **(params or {})}
        cache_key = None
        if cache_ttl > 0:
            # The auth params are part of the request but must not be part of
            # a key that could be listed from Redis.
            visible = {k: v for k, v in (params or {}).items()}
            digest = hashlib.sha256(
                json.dumps([path, visible], sort_keys=True).encode()
            ).hexdigest()
            cache_key = f"http:{self.provider}:{digest}"
            hit = cache.get_json(cache_key)
            if hit is not None:
                return hit

        delay = 1.0
        last_exc: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                resp = self._http.get(path, params=merged)
            except httpx.HTTPError as exc:
                last_exc = exc
                self._record(path, ok=False, remaining=None)
                time.sleep(delay)
                delay *= 2
                continue
            remaining = self._remaining(resp)
            if resp.status_code == 429 or resp.status_code >= 500:
                self._record(path, ok=False, remaining=remaining)
                last_exc = ProviderError(f"{self.provider} {path}: HTTP {resp.status_code}")
                if attempt + 1 < self._max_retries:
                    time.sleep(delay)
                    delay *= 2
                continue
            self._record(path, ok=resp.is_success, remaining=remaining)
            if not resp.is_success:
                raise ProviderError(
                    f"{self.provider} {path}: HTTP {resp.status_code} {resp.text[:200]}"
                )
            data = resp.json()
            if cache_key:
                cache.set_json(cache_key, data, cache_ttl)
            return data
        raise ProviderError(f"{self.provider} {path}: request failed ({last_exc})")

    def _remaining(self, resp: httpx.Response) -> int | None:
        if not self._remaining_header:
            return None
        raw = resp.headers.get(self._remaining_header)
        try:
            return int(float(raw)) if raw is not None else None
        except ValueError:
            return None

    def _record(self, path: str, ok: bool, remaining: int | None) -> None:
        if self._usage_hook is None:
            return
        try:
            self._usage_hook(self.provider, path, ok, remaining)
        except Exception as exc:  # accounting must never break a data sync
            log.warning("usage hook failed: %s", exc)

    def close(self) -> None:
        self._http.close()
