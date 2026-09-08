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

# Vorhandene Zeile ersetzen, sonst anhängen.
if grep -q '^DASHBOARD_AUTH=' .env; then
    TMP=$(mktemp)
    grep -v '^DASHBOARD_AUTH=' .env > "$TMP"
    mv "$TMP" .env
fi
printf 'DASHBOARD_AUTH=%s:%s\n' "$USER_NAME" "$HASH" >> .env
chmod 600 .env 2>/dev/null || true

echo "Zugangsschutz gesetzt für '$USER_NAME' (Verfahren: $METHOD)."
echo "Aktivieren mit:  docker compose up -d"
