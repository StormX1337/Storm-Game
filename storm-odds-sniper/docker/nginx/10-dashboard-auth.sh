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

# Docker Compose ersetzt in der .env jedes $NAME durch eine Variable. Ein
# apr1-Hash besteht fast nur aus solchen Stellen ($apr1$salt$hash), deshalb
# steht er dort verdoppelt ($$) und kommt hier einfach an. Erreicht uns doch
# einmal die verdoppelte Form (etwa über env_file statt Interpolation), wird
# sie hier zurückgesetzt - ein echter Hash enthält nie zwei $ am Stück.
AUTH=$(printf '%s' "$DASHBOARD_AUTH" | sed 's/\$\$/$/g')

USER_PART="${AUTH%%:*}"
HASH_PART="${AUTH#*:}"

fail() {
    echo "[dashboard-auth] FEHLER: $1" >&2
    echo "[dashboard-auth] nginx startet nicht - ein Dashboard, das sich für" >&2
    echo "[dashboard-auth] geschützt hält, es aber nicht ist, wäre schlimmer." >&2
    echo "[dashboard-auth] Reparieren mit: ./scripts/set-dashboard-password.sh" >&2
    exit 1
}

case "$AUTH" in
    *:*) ;;
    *) fail "DASHBOARD_AUTH muss 'benutzer:hash' sein, ist aber '$AUTH'." ;;
esac

[ -n "$USER_PART" ] || fail "kein Benutzername vor dem Doppelpunkt."

# Der häufigste Fehler: der Hash ist unterwegs verloren gegangen, weil die
# $-Zeichen in der .env nicht verdoppelt waren. Dann steht hier "benutzer:"
# und jede korrekte Anmeldung würde mit 401 abgewiesen - ohne erkennbaren
# Grund. Deshalb wird die Form geprüft, nicht nur der Doppelpunkt.
[ -n "$HASH_PART" ] || fail \
    "der Hash fehlt. Meist sind in der .env die \$-Zeichen nicht verdoppelt; Compose warnt dann beim Start mit 'The \"apr1\" variable is not set'."

case "$HASH_PART" in
    '$'*|'{SHA}'*) ;;
    *) fail "'$HASH_PART' sieht nicht wie ein Hash aus (erwartet: \$apr1\$..., \$2y\$... oder {SHA}...)." ;;
esac

printf '%s:%s\n' "$USER_PART" "$HASH_PART" > "$HTPASSWD"
# 644, nicht 600: nginx liest die Datei im Worker-Prozess, und der läuft
# unprivilegiert. Mit 600 antwortet der Server auf jede korrekte Anmeldung
# mit 500 statt 200. Die Datei enthält nur den Hash, nicht das Passwort.
chmod 644 "$HTPASSWD"

cat > "$AUTH_CONF" <<CONF
auth_basic "Storm Odds Sniper";
auth_basic_user_file $HTPASSWD;
CONF

echo "[dashboard-auth] Basic Auth aktiv für Benutzer '$USER_PART'."
