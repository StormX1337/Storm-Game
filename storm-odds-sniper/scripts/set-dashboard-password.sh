#!/bin/sh
# Zugangsschutz fürs Dashboard einrichten.
#
#   ./scripts/set-dashboard-password.sh                 # fragt nach Benutzer und Passwort
#   ./scripts/set-dashboard-password.sh admin geheim    # nicht interaktiv
#
# Schreibt DASHBOARD_AUTH in die .env. Danach: docker compose up -d
set -eu

cd "$(dirname "$0")/.."

USER_NAME="${1:-}"
PASSWORD="${2:-}"

# Zugangsschutz wieder abschalten. Bewusst als eigener Weg statt "einfach die
# Zeile löschen": von Hand editiert wird die .env sonst schnell kaputt.
case "$USER_NAME" in
    --off|--aus|off|aus)
        [ -f .env ] || { echo "Keine .env vorhanden - nichts zu tun."; exit 0; }
        if grep -q '^DASHBOARD_AUTH=' .env; then
            TMP=$(mktemp)
            grep -v '^DASHBOARD_AUTH=' .env > "$TMP"
            cat "$TMP" > .env
            rm -f "$TMP"
        fi
        printf 'DASHBOARD_AUTH=\n' >> .env
        echo "Zugangsschutz ABGESCHALTET."
        echo "Das Dashboard ist danach für jeden erreichbar, der die Adresse kennt."
        echo "Übernehmen mit:  docker compose up -d"
        exit 0
        ;;
esac

if [ -z "$USER_NAME" ]; then
    printf 'Benutzername [admin]: '
    read -r USER_NAME
    USER_NAME="${USER_NAME:-admin}"
fi

if [ -z "$PASSWORD" ]; then
    # stty -echo, damit das Passwort nicht in der Konsole steht.
    printf 'Passwort: '
    stty -echo 2>/dev/null || true
    read -r PASSWORD
    stty echo 2>/dev/null || true
    printf '\n'
fi

if [ -z "$PASSWORD" ]; then
    echo "Kein Passwort angegeben - abgebrochen." >&2
    exit 1
fi

case "$USER_NAME" in
    *:*) echo "Der Benutzername darf keinen Doppelpunkt enthalten." >&2; exit 1 ;;
esac

# apr1 (gesalzen) ist deutlich stärker als das SHA-Format und wird von nginx
# unterstützt. Nur wenn openssl fehlt, wird auf {SHA} ausgewichen - das ist
# ungesalzen und damit offline angreifbar, falls die Datei je abhandenkommt.
if command -v openssl >/dev/null 2>&1 && openssl passwd -apr1 test >/dev/null 2>&1; then
    HASH=$(openssl passwd -apr1 "$PASSWORD")
    METHOD="apr1 (gesalzen)"
else
    HASH=$(printf '%s' "$PASSWORD" | python3 -c '
import base64, hashlib, sys
print("{SHA}" + base64.b64encode(hashlib.sha1(sys.stdin.buffer.read()).digest()).decode())
')
    METHOD="SHA (ungesalzen - openssl wäre besser)"
fi

[ -f .env ] || cp .env.example .env

# Docker Compose ersetzt in der .env jedes $NAME durch eine Variable. Ein
# apr1-Hash ($apr1$salt$hash) besteht fast nur aus solchen Stellen und würde
# dabei spurlos verschwinden - übrig bliebe "benutzer:", und jede korrekte
# Anmeldung endete mit 401. Verdoppelte $ sind Compose' Schreibweise für ein
# literales $; der Container macht daraus wieder einfache.
ESCAPED=$(printf '%s:%s' "$USER_NAME" "$HASH" | sed 's/\$/$$/g')

# Vorhandene Zeile ersetzen, sonst anhängen.
if grep -q '^DASHBOARD_AUTH=' .env; then
    TMP=$(mktemp)
    grep -v '^DASHBOARD_AUTH=' .env > "$TMP"
    cat "$TMP" > .env
    rm -f "$TMP"
fi
printf 'DASHBOARD_AUTH=%s\n' "$ESCAPED" >> .env
chmod 600 .env 2>/dev/null || true

echo "Zugangsschutz gesetzt für '$USER_NAME' (Verfahren: $METHOD)."

# Gegenprobe statt Hoffnung: überlebt der Hash den Weg durch Compose? Genau
# hier ging es vorher schief - der Hash verschwand spurlos, und die einzige
# Spur war eine Warnung, die niemand mit dem Login in Verbindung brachte.
#
# "docker compose config" gibt eine Compose-Datei aus, dort steht ein
# literales $ wieder als $$. Für den Vergleich wird deshalb zurückgesetzt.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    RESOLVED=$(docker compose config 2>/dev/null \
        | grep -m1 'DASHBOARD_AUTH:' | sed 's/^ *DASHBOARD_AUTH: *//')
    # Compose setzt je nach Wert Anführungszeichen - die gehören nicht zum Hash.
    RESOLVED=${RESOLVED#\'}; RESOLVED=${RESOLVED%\'}
    RESOLVED=${RESOLVED#\"}; RESOLVED=${RESOLVED%\"}
    RESOLVED=$(printf '%s' "$RESOLVED" | sed 's/\$\$/$/g')
    if [ -z "$RESOLVED" ]; then
        echo "Hinweis: Gegenprobe übersprungen (docker compose config lieferte nichts)."
    elif [ "$RESOLVED" = "$USER_NAME:$HASH" ]; then
        echo "Gegenprobe: Compose reicht den Hash unverändert durch. ✓"
    else
        echo "FEHLER: Compose macht aus dem Wert '$RESOLVED'." >&2
        echo "Erwartet war '$USER_NAME:$HASH'." >&2
        echo "So würde der Zugangsschutz jede korrekte Anmeldung abweisen -" >&2
        echo "die .env wurde geschrieben, aber bitte nicht so starten." >&2
        exit 1
    fi
fi

echo "Aktivieren mit:  docker compose up -d"
