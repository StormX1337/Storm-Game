#!/bin/sh
# Einrichtungshilfe starten - egal ob per Docker oder lokal.
#
#   ./scripts/setup-provider.sh the_odds_api --key DEIN_KEY --write
#
# Auf einem normalen Server fehlen dem System-Python die Abhängigkeiten
# (httpx & Co.). Deshalb läuft das Skript bevorzugt im API-Container, in dem
# alles installiert ist. Die .env wird dafür hineingereicht, damit --write
# auf dem Host wirkt.
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    echo "Es gibt keine .env. Erst anlegen:" >&2
    echo "  cp .env.example .env" >&2
    exit 1
fi

run_in_docker() {
    # --user root: die .env auf dem Host gehört meist root, der Container
    # läuft sonst als unprivilegierter Benutzer und darf nicht schreiben.
    #
    # backend/ und scripts/ werden vom Host hineingereicht, damit hier immer
    # der AKTUELLE Stand läuft. Ohne das gilt der Code aus dem gebauten Image:
    # nach einem "git pull" ohne "--build" kannte das Skript im Container
    # neue Provider noch nicht und brach mit "invalid choice" ab - obwohl auf
    # dem Host alles vorhanden war. Die Abhängigkeiten liegen im Image unter
    # /opt/venv und sind davon nicht betroffen.
    docker compose run --rm --user root \
        -e PYTHONDONTWRITEBYTECODE=1 \
        -v "$(pwd)/.env:/app/.env" \
        -v "$(pwd)/backend:/app/backend:ro" \
        -v "$(pwd)/scripts:/app/scripts:ro" \
        api python /app/scripts/setup_provider.py "$@"
}

# "docker compose version" klappt auch ohne laufenden Daemon - deshalb wird
# hier der Daemon selbst geprüft, sonst bricht der Docker-Pfad mit einem
# verwirrenden Socket-Fehler ab, statt auf die lokale Variante zu wechseln.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "[i] Starte im API-Container …"
    run_in_docker "$@"
    exit $?
fi

if [ -x .venv/bin/python ]; then
    echo "[i] Starte in .venv …"
    PYTHONPATH=. .venv/bin/python scripts/setup_provider.py "$@"
    exit $?
fi

echo "[i] Weder Docker noch .venv gefunden - versuche python3 …"
if ! python3 -c "import httpx" >/dev/null 2>&1; then
    echo "Dem System-Python fehlen die Abhängigkeiten. Eine dieser Varianten:" >&2
    echo "  docker compose up -d --build && ./scripts/setup-provider.sh $*" >&2
    echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi
PYTHONPATH=. python3 scripts/setup_provider.py "$@"
