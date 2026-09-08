#!/bin/sh
# Läuft beim Start des nginx-Containers (/docker-entrypoint.d/).
#
# Ohne DASHBOARD_AUTH bleibt alles wie bisher offen - das Verhalten ändert
# sich also für bestehende Installationen nicht. Ist die Variable gesetzt
# ("benutzer:hash"), gilt Basic Auth für Dashboard, API und WebSocket.
set -eu

AUTH_CONF=/etc/nginx/dashboard-auth.conf
HTPASSWD=/etc/nginx/.htpasswd

if [ -z "${DASHBOARD_AUTH:-}" ]; then
    echo "auth_basic off;" > "$AUTH_CONF"
    echo "[dashboard-auth] kein DASHBOARD_AUTH gesetzt - Dashboard ist OFFEN erreichbar."
    echo "[dashboard-auth] Passwort setzen: ./scripts/set-dashboard-password.sh"
    exit 0
fi

case "$DASHBOARD_AUTH" in
    *:*) ;;
    *)
        echo "[dashboard-auth] FEHLER: DASHBOARD_AUTH muss 'benutzer:hash' sein." >&2
        echo "[dashboard-auth] Erzeugen mit: ./scripts/set-dashboard-password.sh" >&2
        exit 1
        ;;
esac

printf '%s\n' "$DASHBOARD_AUTH" > "$HTPASSWD"
# 644, nicht 600: nginx liest die Datei im Worker-Prozess, und der läuft
# unprivilegiert. Mit 600 antwortet der Server auf jede korrekte Anmeldung
# mit 500 statt 200. Die Datei enthält nur den Hash, nicht das Passwort.
chmod 644 "$HTPASSWD"

cat > "$AUTH_CONF" <<CONF
auth_basic "Storm Odds Sniper";
auth_basic_user_file $HTPASSWD;
CONF

echo "[dashboard-auth] Basic Auth aktiv für Benutzer '${DASHBOARD_AUTH%%:*}'."
