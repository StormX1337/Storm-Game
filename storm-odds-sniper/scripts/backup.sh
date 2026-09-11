#!/bin/sh
# Datensicherung der PostgreSQL-Datenbank.
#
#   ./scripts/backup.sh                 # sichern nach ./backups/
#   ./scripts/backup.sh --keep 20       # mehr Stände aufheben
#   ./scripts/backup.sh --list          # vorhandene Sicherungen zeigen
#
# Gesichert wird alles: Alarme, Nachkontrollen, Quotenverlauf - und vor allem
# das Wett-Tagebuch. Das ist der einzige Ort, an dem steht, was tatsächlich
# gespielt wurde und was es gebracht hat. Alles andere kann der Scanner neu
# sammeln; diese Zeilen kann niemand rekonstruieren.
#
# ZURÜCKSPIELEN (Vorsicht, überschreibt den aktuellen Stand):
#
#   gunzip -c backups/storm-20260911-0730.sql.gz \
#     | docker compose exec -T postgres psql -U storm -d storm
#
set -eu

cd "$(dirname "$0")/.."

ZIEL=backups
KEEP=10
LISTE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --keep) KEEP=$2; shift 2 ;;
        --dir)  ZIEL=$2; shift 2 ;;
        --list) LISTE=1; shift ;;
        *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
    esac
done

if [ "$LISTE" = "1" ]; then
    if [ -d "$ZIEL" ]; then
        ls -lh "$ZIEL" | tail -n +2
    else
        echo "Noch keine Sicherungen in $ZIEL/"
    fi
    exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "Docker läuft nicht - ohne die Datenbank gibt es nichts zu sichern." >&2
    exit 1
fi

# Benutzer und Datenbank stehen in der .env; ohne Angabe gelten die
# Standardwerte aus docker-compose.yml.
DB_USER=$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2)
DB_NAME=$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2)
DB_USER=${DB_USER:-storm}
DB_NAME=${DB_NAME:-storm}

mkdir -p "$ZIEL"
STAND="$ZIEL/storm-$(date +%Y%m%d-%H%M%S).sql.gz"

echo "[i] Sichere $DB_NAME nach $STAND …"
# --clean: die Sicherung räumt beim Zurückspielen selbst auf, sonst
# scheitert sie an bestehenden Tabellen.
if ! docker compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
        2>/tmp/backup-err.$$ | gzip -9 > "$STAND"; then
    echo "Sicherung fehlgeschlagen:" >&2
    cat /tmp/backup-err.$$ >&2
    rm -f "$STAND" /tmp/backup-err.$$
    exit 1
fi
rm -f /tmp/backup-err.$$

# Eine Sicherung, die nur aus Kopfzeilen besteht, ist keine. Lieber jetzt
# merken als beim Zurückspielen.
GROESSE=$(wc -c < "$STAND")
if [ "$GROESSE" -lt 1000 ]; then
    echo "Sicherung ist nur $GROESSE Bytes groß - das kann nicht stimmen." >&2
    echo "Datei bleibt zur Ansicht liegen: $STAND" >&2
    exit 1
fi

echo "[✓] $(du -h "$STAND" | cut -f1) geschrieben"

# Alte Stände aufräumen, aber nie den letzten.
ANZAHL=$(ls -1 "$ZIEL"/storm-*.sql.gz 2>/dev/null | wc -l)
if [ "$ANZAHL" -gt "$KEEP" ]; then
    ls -1t "$ZIEL"/storm-*.sql.gz | tail -n +$((KEEP + 1)) | while read -r alt; do
        echo "[i] entferne alten Stand: $(basename "$alt")"
        rm -f "$alt"
    done
fi

echo
echo "Zurückspielen (überschreibt den aktuellen Stand):"
echo "  gunzip -c $STAND | docker compose exec -T postgres psql -U $DB_USER -d $DB_NAME"
