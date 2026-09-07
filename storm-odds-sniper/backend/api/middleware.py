"""HTTP-Middleware: Request-ID, Zugriffslog, Rate-Limiting, Security-Header."""

from __future__ import annotations

import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from backend.core.logging import get_logger

log = get_logger("api.http")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Request-ID vergeben und Zugriffe strukturiert loggen."""

    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        request.state.request_id = request_id
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as exc:  # noqa: BLE001 - keine Stacktraces an Clients
            log.error(
                "unbehandelter fehler",
                path=request.url.path,
                method=request.method,
                request_id=request_id,
                error=str(exc),
                exc_info=True,
            )
            return JSONResponse(
                {"detail": "Interner Fehler", "request_id": request_id}, status_code=500
            )
        duration_ms = (time.perf_counter() - started) * 1000
        response.headers["x-request-id"] = request_id
        if request.url.path not in ("/health", "/metrics"):
            log.debug(
                "request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                duration_ms=round(duration_ms, 2),
                request_id=request_id,
            )
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Einfaches Fenster-Rate-Limit je Client-IP.

    Bevorzugt Redis (prozessübergreifend), fällt sonst auf einen lokalen
    Zähler zurück. Health- und Metrics-Endpunkte bleiben ausgenommen, damit
    Monitoring nie ausgesperrt wird.
    """

    EXEMPT = {"/health", "/metrics", "/health/providers"}

    def __init__(self, app, *, limit_per_minute: int = 240) -> None:
        super().__init__(app)
        self.limit = max(1, limit_per_minute)
        self._local: dict[tuple[str, int], int] = {}

    async def dispatch(self, request: Request, call_next):
        if request.url.path in self.EXEMPT or request.scope.get("type") == "websocket":
            return await call_next(request)

        client = request.client.host if request.client else "unknown"
        window = int(time.time() // 60)
        count = await self._increment(request, client, window)
        if count > self.limit:
            log.warning("rate-limit überschritten", client=client, count=count)
            return JSONResponse(
                {"detail": "Zu viele Anfragen"},
                status_code=429,
                headers={"Retry-After": "60"},
            )
        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(self.limit)
        response.headers["X-RateLimit-Remaining"] = str(max(0, self.limit - count))
        return response

    async def _increment(self, request: Request, client: str, window: int) -> int:
        state = getattr(request.app.state, "redis", None)
        if state is not None:
            try:
                key = f"rl:{client}:{window}"
                count = await state.client.incr(key)
                if count == 1:
                    await state.client.expire(key, 120)
                return int(count)
            except Exception as exc:  # noqa: BLE001 - Rate-Limit darf die API nie killen
                log.debug("rate-limit über redis fehlgeschlagen", error=str(exc))
        # Lokaler Fallback
        self._local = {k: v for k, v in self._local.items() if k[1] >= window - 1}
        key_local = (client, window)
        self._local[key_local] = self._local.get(key_local, 0) + 1
        return self._local[key_local]
