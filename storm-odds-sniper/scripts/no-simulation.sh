#!/bin/sh
# Simulation abschalten - nur noch echte Datenquellen.
#
#   ./scripts/no-simulation.sh
#
# Entfernt "mock" aus PROVIDERS in der .env. Danach: docker compose up -d
set -eu

cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Keine .env gefunden - erst 'cp .env.example .env'." >&2; exit 1; }

CURRENT=$(grep '^PROVIDERS=' .env | head -1 | cut -d= -f2- || true)
if [ -z "$CURRENT" ]; then
    echo "In der .env steht kein PROVIDERS - nichts zu ändern." >&2
    exit 1
fi

# "mock" aus der Liste streichen, Reihenfolge und Rest bleiben erhalten.
REST=$(printf '%s' "$CURRENT" | tr ',' '\n' | sed 's/^ *//; s/ *$//' \
        | grep -v '^mock$' | grep -v '^$' | paste -sd, -)

if [ "$REST" = "$CURRENT" ]; then
    echo "Die Simulation läuft ohnehin nicht (PROVIDERS=$CURRENT)."
    exit 0
fi

if [ -z "$REST" ]; then
    echo "FEHLER: 'mock' ist die einzige Quelle in PROVIDERS." >&2
    echo "Ohne echte Quelle bliebe das System stumm. Erst eine einrichten:" >&2
    echo "  ./scripts/setup-provider.sh the_odds_api --key <DEIN_KEY> --write" >&2
    exit 1
fi

TMP=$(mktemp)
sed "s/^PROVIDERS=.*/PROVIDERS=$REST/" .env > "$TMP"
cat "$TMP" > .env
rm -f "$TMP"

echo "Simulation abgeschaltet.  PROVIDERS=$REST"
echo
echo "Ehrlicher Hinweis: echte Fehlpreise sind selten, und das Gratis-Kontingent"
echo "erlaubt nur wenige Abrufe am Tag. Rechne mit deutlich weniger Alarmen -"
echo "im Zweifel tagelang keinem. Das ist kein Defekt, sondern der Unterschied"
echo "zwischen erfundenen und echten Daten."
echo
echo "Übernehmen mit:  docker compose up -d"
