#!/bin/sh
# Das Empfehlungsmodell gegen die eigenen Alarme halten.
#
#   ./scripts/backtest.sh                # letzte 7 Tage
#   ./scripts/backtest.sh --days 30
#   ./scripts/backtest.sh --json > pruefung.json
#
# Liest nur - es wird nichts geschrieben und nichts beim Anbieter abgerufen.
# Läuft bevorzugt im API-Container: dort liegen die Abhängigkeiten, und von
# dort ist die Datenbank unter ihrem Docker-Namen erreichbar.
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    echo "Es gibt keine .env. Erst anlegen:" >&2
    echo "  cp .env.example .env" >&2
    exit 1
fi

run_in_docker() {
    # backend/ und scripts/ vom Host hineinreichen, damit immer der aktuelle
    # Stand läuft - sonst gilt der Code aus dem gebauten Image.
    docker compose run --rm --no-deps \
        -e PYTHONDONTWRITEBYTECODE=1 \
        -v "$(pwd)/.env:/app/.env:ro" \
        -v "$(pwd)/backend:/app/backend:ro" \
        -v "$(pwd)/scripts:/app/scripts:ro" \
        api python /app/scripts/backtest.py "$@"
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "[i] Starte im API-Container …"
    run_in_docker "$@"
    exit $?
fi

if [ -x .venv/bin/python ]; then
    echo "[i] Starte in .venv …"
    PYTHONPATH=. .venv/bin/python scripts/backtest.py "$@"
    exit $?
fi

echo "Weder Docker noch .venv gefunden." >&2
echo "  docker compose up -d --build && ./scripts/backtest.sh $*" >&2
exit 1
