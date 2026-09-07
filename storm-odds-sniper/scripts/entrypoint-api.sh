#!/bin/sh
# API-Start: Migrationen anwenden, dann Uvicorn.
set -e

echo "[entrypoint] warte auf Datenbank…"
python - <<'PY'
import os, socket, time, urllib.parse
dsn = os.getenv("DATABASE_URL") or ""
host = os.getenv("POSTGRES_HOST", "postgres")
port = int(os.getenv("POSTGRES_PORT", "5432"))
if dsn:
    parsed = urllib.parse.urlparse(dsn)
    host, port = parsed.hostname or host, parsed.port or port
for attempt in range(60):
    try:
        with socket.create_connection((host, port), timeout=2):
            print(f"[entrypoint] Datenbank erreichbar ({host}:{port})")
            break
    except OSError:
        time.sleep(1)
else:
    print("[entrypoint] Datenbank nicht erreichbar - starte trotzdem")
PY

echo "[entrypoint] wende Migrationen an…"
alembic upgrade head || echo "[entrypoint] WARNUNG: Migration fehlgeschlagen"

echo "[entrypoint] starte API"
exec python -m backend.api
