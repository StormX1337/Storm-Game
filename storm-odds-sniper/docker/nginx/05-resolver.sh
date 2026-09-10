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
#
# Aussortiert werden ausserdem alle anderen Loopback-Adressen. Das klingt
# nach Erbsenzählerei, ist aber ein realer Ausfall: steht auf dem Host
# systemd-resolved, trägt die resolv.conf dort "nameserver 127.0.0.53" -
# und wenn diese Zeile in den Container durchschlägt, zeigt nginx auf einen
# Auflöser, den es im Netz-Namensraum des Containers gar nicht gibt. Ergebnis
# war eine Stunde Fehlersuche an der falschen Stelle: jede Anfrage 502, im
# Container "bad address 'api:8000'", und alle Dienste scheinbar gleichzeitig
# kaputt. 127.0.0.11 ist die einzige Loopback-Adresse, die hier drin etwas
# bedeutet - alles andere ist im Container wertlos.
#
# "|| true": ist die Datei nicht lesbar, scheitert awk - mit "set -e" würde
# das Skript hier abbrechen und nginx gar nicht erst starten. Der Rückfall
# unten ist die bessere Antwort.
servers=$(awk '
    /^nameserver/ && $2 !~ /:/ {
        if ($2 ~ /^127\./ && $2 != "127.0.0.11") next
        printf "%s ", $2
    }' /etc/resolv.conf 2>/dev/null || true)

if [ -z "$servers" ]; then
    # Docker-eigener DNS als Rückfall - ohne resolver startet nginx nicht.
    servers="127.0.0.11"
    echo "[resolver] keine brauchbaren Nameserver in /etc/resolv.conf - nutze $servers"
fi

printf 'resolver %svalid=10s ipv6=off;\nresolver_timeout 5s;\n' "$servers" > "$CONF"
chmod 644 "$CONF"
echo "[resolver] Namensauflösung zur Laufzeit über: $servers"
