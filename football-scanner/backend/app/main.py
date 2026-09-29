import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.routes import admin, auth, bankroll, dashboard, history, matches, meta, scanner
from app.config import get_settings

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def create_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO)
    app = FastAPI(
        title="Football Value Scanner API",
        description=(
            "Statistical value analysis of football betting markets. Signals describe "
            "statistical discrepancies between a model and bookmaker prices; they are not "
            "predictions of fixed outcomes and carry no guarantee of profit."
        ),
        version="0.1.0",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )

    @app.middleware("http")
    async def origin_check(request: Request, call_next):
        # Cookie-authenticated state changes are only accepted from our own
        # origin. Browsers always send Origin on these requests; clients that
        # send none (curl, server-side calls) cannot carry a victim's cookie.
        if request.method not in SAFE_METHODS and request.url.path.startswith("/api/"):
            origin = request.headers.get("origin")
            if origin and origin.rstrip("/") not in get_settings().origins:
                return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    for router in (auth, dashboard, matches, scanner, history, bankroll, meta, admin):
        app.include_router(router.router)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    return app


app = create_app()
