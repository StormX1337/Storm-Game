#!/bin/sh
# Gelieferte Buchmacher auflisten.
#
#   ./scripts/bookmakers.sh                # letzte 7 Tage
#   ./scripts/bookmakers.sh --days 30
#   ./scripts/bookmakers.sh --grep bet     # nur passende Namen
#
# Zeigt jeden Buchmacher so, wie die Quelle ihn liefert. Was hier fehlt,
# führt die Quelle nicht - und lässt sich nicht ergänzen.
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
    # --user root: die .env auf dem Host gehört meist root und ist nur für
    # root lesbar. Der Container läuft sonst als unprivilegierter Benutzer und
    # scheitert schon beim Einlesen der Einstellungen - noch bevor überhaupt
    # eine Datenbankverbindung versucht wird. Geschrieben wird hier nichts,
    # die .env bleibt darum zusätzlich schreibgeschützt eingehängt (:ro).
    #
    # backend/ und scripts/ vom Host hineinreichen, damit immer der aktuelle
    # Stand läuft - sonst gilt der Code aus dem gebauten Image.
    docker compose run --rm --no-deps --user root \
        -e PYTHONDONTWRITEBYTECODE=1 \
        -v "$(pwd)/.env:/app/.env:ro" \
        -v "$(pwd)/backend:/app/backend:ro" \
        -v "$(pwd)/scripts:/app/scripts:ro" \
        api python /app/scripts/bookmakers.py "$@"
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    # Hinweise gehören auf stderr: sonst landen sie bei "--json > datei"
    # mitten in der Datei und machen sie unlesbar.
    echo "[i] Starte im API-Container …" >&2
    run_in_docker "$@"
    exit $?
fi

if [ -x .venv/bin/python ]; then
    echo "[i] Starte in .venv …" >&2
    PYTHONPATH=. .venv/bin/python scripts/bookmakers.py "$@"
    exit $?
fi

echo "Weder Docker noch .venv gefunden." >&2
echo "  docker compose up -d --build && ./scripts/bookmakers.sh $*" >&2
exit 1
