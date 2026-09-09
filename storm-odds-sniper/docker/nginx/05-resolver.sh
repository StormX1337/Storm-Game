#!/bin/sh
# Läuft vor nginx (/docker-entrypoint.d/, alphabetisch vor 10-dashboard-auth).
#
# Schreibt die Nameserver des Containers in eine Konfigurationsdatei. nginx
# braucht sie, um den Namen "api" bei jeder Anfrage neu aufzulösen - ohne das
# behält es die IP vom Start und antwortet nach einem Neuaufbau des
# api-Containers dauerhaft mit 502.
set -eu

CONF=/etc/nginx/resolver.conf

# Nur IPv4: eine IPv6-Adresse müsste in nginx geklammert werden, und im
# Docker-Netz steht ohnehin 127.0.0.11 in der resolv.conf.
# "|| true": ist die Datei nicht lesbar, scheitert awk - mit "set -e" würde
# das Skript hier abbrechen und nginx gar nicht erst starten. Der Rückfall
# unten ist die bessere Antwort.
servers=$(awk '/^nameserver/ && $2 !~ /:/ { printf "%s ", $2 }' /etc/resolv.conf 2>/dev/null || true)

if [ -z "$servers" ]; then
    # Docker-eigener DNS als Rückfall - ohne resolver startet nginx nicht.
    servers="127.0.0.11"
    echo "[resolver] keine Nameserver in /etc/resolv.conf - nutze $servers"
fi

printf 'resolver %svalid=10s ipv6=off;\nresolver_timeout 5s;\n' "$servers" > "$CONF"
chmod 644 "$CONF"
echo "[resolver] Namensauflösung zur Laufzeit über: $servers"
