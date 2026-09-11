#!/bin/sh
# Daten eines Buchmachers entfernen - mit Sicherung davor.
#
#   ./scripts/purge-bookmaker.sh 'Mock%'              # Trockenlauf
#   ./scripts/purge-bookmaker.sh 'Mock%' --wirklich   # löschen
#
# Ohne --wirklich wird nur gezählt. Mit --wirklich läuft ZUERST
# ./scripts/backup.sh - ohne gültige Sicherung wird nichts gelöscht.
set -eu

cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
    echo "Aufruf: ./scripts/purge-bookmaker.sh 'Muster' [--wirklich]" >&2
    echo "  Welche Buchmacher es gibt: ./scripts/bookmakers.sh" >&2
    exit 2
fi

if [ ! -f .env ]; then
    echo "Es gibt keine .env. Erst anlegen: cp .env.example .env" >&2
    exit 1
fi

# Wird wirklich gelöscht, muss vorher eine Sicherung stehen. Scheitert sie,
# bricht das Skript hier ab - Löschen ohne Sicherung gibt es nicht.
for arg in "$@"; do
    if [ "$arg" = "--wirklich" ]; then
        echo "[i] Lege zuerst eine Sicherung an …"
        ./scripts/backup.sh
        echo
        break
    fi
done

run_in_docker() {
    # --user root: die .env auf dem Host gehört meist root (siehe backtest.sh).
    docker compose run --rm --no-deps --user root \
        -e PYTHONDONTWRITEBYTECODE=1 \
        -v "$(pwd)/.env:/app/.env:ro" \
        -v "$(pwd)/backend:/app/backend:ro" \
        -v "$(pwd)/scripts:/app/scripts:ro" \
        api python /app/scripts/purge_bookmaker.py "$@"
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "[i] Starte im API-Container …" >&2
    run_in_docker "$@"
    exit $?
fi

if [ -x .venv/bin/python ]; then
    echo "[i] Starte in .venv …" >&2
    PYTHONPATH=. .venv/bin/python scripts/purge_bookmaker.py "$@"
    exit $?
fi

echo "Weder Docker noch .venv gefunden." >&2
exit 1
