#!/bin/sh
# Zustand der Installation einsammeln - alles, was zur Fehlersuche nötig ist.
#
#   ./scripts/diagnose.sh
#   ./scripts/diagnose.sh > bericht.txt      # zum Verschicken
#
# Zeigt KEINE Passwörter, Schlüssel oder Tokens: Werte solcher Variablen
# werden durch ihre Länge ersetzt.
set -u

cd "$(dirname "$0")/.."

line() { printf '\n== %s ==\n' "$1"; }

echo "Storm Odds Sniper - Diagnose  ($(date '+%F %T'))"

line "Codestand"
if [ -d .git ]; then
    printf 'Commit:  %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
    printf 'Branch:  %s\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    changed=$(git status --porcelain 2>/dev/null | wc -l)
    printf 'Geändert gegenüber Commit: %s Datei(en)\n' "$changed"
else
    echo "kein Git-Verzeichnis"
fi

line "Konfiguration (.env, ohne Geheimnisse)"
if [ -f .env ]; then
    # Werte von Schlüsseln/Passwörtern/Tokens durch ihre Länge ersetzen.
    awk -F= '
        /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
        {
            key = $1
            val = substr($0, index($0, "=") + 1)
            if (key ~ /KEY|PASSWORD|TOKEN|SECRET|AUTH|DSN|URL/ && length(val) > 0) {
                printf "%s=<%d Zeichen>\n", key, length(val)
            } else {
                print key "=" val
            }
        }' .env
else
    echo "KEINE .env vorhanden - das ist die Ursache."
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    line "Docker"
    echo "Docker-Daemon nicht erreichbar - läuft er?"
    exit 0
fi

line "Container"
docker compose ps 2>&1

line "Zuletzt gestartet / Image-Alter"
docker compose images 2>&1 | head -12

for service in api scanner telegram-bot frontend migrate; do
    line "Log: $service (letzte Zeilen)"
    docker compose logs --no-color --tail 25 "$service" 2>&1 | tail -25
done

line "Fehler in allen Logs (letzte 500 Zeilen je Dienst)"
docker compose logs --no-color --tail 500 2>&1 \
    | grep -iE "error|traceback|exception|fatal|refused|KEINE DATENQUELLE|nicht erreichbar" \
    | tail -25 || echo "keine gefunden"

line "Antwortet die API im Container?"
docker compose exec -T api sh -c \
    'python -c "import urllib.request,sys; print(urllib.request.urlopen(\"http://127.0.0.1:8000/health\", timeout=5).status)"' \
    2>&1 | tail -3

line "Kommt nginx an die API?"
docker compose exec -T frontend sh -c \
    'wget -qO- --timeout=5 http://api:8000/health >/dev/null && echo "erreichbar" || echo "NICHT erreichbar"' \
    2>&1 | tail -3

line "Antwortet das Dashboard von außen?"
port=$(grep -E '^DASHBOARD_PORT=' .env 2>/dev/null | cut -d= -f2)
port=${port:-8080}
for path in /healthz /api/health /api/stats /api/health/providers; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}${path}" 2>/dev/null)
    printf '  %-24s %s\n' "$path" "${code:-keine Antwort}"
done

line "Fertig"
echo "Diese Ausgabe enthält keine Geheimnisse und kann verschickt werden."
