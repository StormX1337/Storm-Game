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

# ---------------------------------------------------------------- Befund
#
# Der Rest dieses Skripts sammelt Material. Das hier beantwortet die Frage,
# die man tatsächlich hat: WAS ist kaputt und WAS mache ich jetzt?
#
# Die Dienste hängen voneinander ab:
#
#   postgres ──> migrate ──> api ──> frontend (Port 8080)
#   redis    ──────────────┘
#
# Reißt die Kette irgendwo, ist am Ende Port 8080 tot - der Browser meldet
# dann "refused", und zwar völlig unabhängig davon, wo es wirklich klemmt.
# Darum wird hier das ERSTE kaputte Glied genannt, nicht das letzte.

#: Zustand eines Dienstes als "status|gesundheit|exitcode".
dienst_zustand() {
    cid=$(docker compose ps -aq "$1" 2>/dev/null | head -n1)
    if [ -z "$cid" ]; then
        echo "fehlt|-|-"
        return 0
    fi
    # Über docker inspect statt "compose ps --format", weil das Format je
    # nach Compose-Version anders aussieht - die Vorlage hier nicht.
    docker inspect \
        -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}|{{.State.ExitCode}}' \
        "$cid" 2>/dev/null || echo "unbekannt|-|-"
}

#: Aus dem Zustand einen deutschen Satz machen.
zustand_text() {
    case "$1|$2" in
        "fehlt|"*)        echo "existiert nicht" ;;
        "running|healthy")   echo "läuft, gesund" ;;
        "running|starting")  echo "startet gerade" ;;
        "running|unhealthy") echo "läuft, aber UNGESUND" ;;
        "running|"*)      echo "läuft" ;;
        "restarting|"*)   echo "startet immer wieder neu (Absturzschleife)" ;;
        "created|"*)      echo "angelegt, aber nie gestartet" ;;
        "exited|"*)
            case "$3" in
                0)   echo "sauber beendet" ;;
                # 137 = vom Kernel per SIGKILL beendet. Auf einem kleinen
                # Server heißt das fast immer: der Arbeitsspeicher war alle.
                137) echo "ABGESCHOSSEN (Code 137 - meist zu wenig Arbeitsspeicher)" ;;
                *)   echo "ABGEBROCHEN (Code $3)" ;;
            esac ;;
        *)                echo "$1" ;;
    esac
}

#: Ist der Dienst für die Kette in Ordnung?
dienst_ok() {
    case "$1" in
        migrate) [ "$2" = "exited" ] && [ "$4" = "0" ] ;;
        frontend) [ "$2" = "running" ] ;;
        *) [ "$2" = "running" ] && { [ "$3" = "healthy" ] || [ "$3" = "-" ]; } ;;
    esac
}

#: Was am Dashboard vorbei kaputt ist. Ein stilles Loch im Scanner sieht
#: von außen aus wie "keine Alarme, ist wohl gerade nichts los".
nebenbefund() {
    [ -z "${nebenbei:-}" ] && return 0
    echo
    for dienst in $nebenbei; do
        case "$dienst" in
            scanner)
                echo "  Nebenbei: der Scanner läuft nicht. Das Dashboard geht"
                echo "  davon zwar auf, es kommen aber KEINE neuen Alarme mehr."
                echo "    docker compose logs scanner | tail -40" ;;
            telegram-bot)
                echo "  Nebenbei: der Telegram-Bot läuft nicht. Alarme entstehen"
                echo "  weiter, sie werden nur nicht verschickt."
                echo "    docker compose logs telegram-bot | tail -40" ;;
        esac
    done
}

befund() {
    line "BEFUND"

    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
        echo "  Docker läuft nicht. Damit ist nichts erreichbar."
        echo
        echo "  Nächster Schritt:"
        echo "    systemctl start docker && docker compose up -d"
        return 0
    fi

    # Speicherplatz zuerst. Eine volle Platte sieht aus wie zehn
    # verschiedene Fehler und ist doch nur einer - Container sterben,
    # Postgres verweigert Schreibzugriffe, Builds brechen ab.
    for pfad in /var/lib/docker .; do
        frei=$(df -Pm "$pfad" 2>/dev/null | awk 'NR==2 {print $4}')
        [ -z "${frei:-}" ] && continue
        if [ "$frei" -lt 1024 ]; then
            printf '  %-26s %6s MB frei  <-- ZU WENIG\n' "Speicherplatz $pfad" "$frei"
            eng=1
        else
            printf '  %-26s %6s MB frei\n' "Speicherplatz $pfad" "$frei"
        fi
    done
    ram=$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')
    [ -n "${ram:-}" ] && printf '  %-26s %6s MB frei\n' "Arbeitsspeicher" "$ram"
    echo

    schuld=""
    nebenbei=""
    fehlend=0
    gesamt=0
    for dienst in postgres redis migrate api scanner telegram-bot frontend; do
        zustand=$(dienst_zustand "$dienst")
        status=${zustand%%|*}
        rest=${zustand#*|}
        health=${rest%%|*}
        exitcode=${rest##*|}
        printf '  %-14s %s\n' "$dienst" "$(zustand_text "$status" "$health" "$exitcode")"

        gesamt=$((gesamt + 1))
        [ "$status" = "fehlt" ] && fehlend=$((fehlend + 1))

        # scanner und telegram-bot hängen NICHT am Dashboard - ein toter
        # Telegram-Bot (etwa ohne Token) darf hier nicht als Ursache für
        # eine unerreichbare Seite dastehen. Verschwiegen wird er trotzdem
        # nicht: ein stiller Scanner heißt keine Alarme, und das ist der
        # Fehler, den man am längsten nicht bemerkt.
        case "$dienst" in
            scanner|telegram-bot)
                # "existiert nicht" beim Bot ist kein Fehler - ohne Token
                # ist er schlicht nicht eingerichtet.
                if ! dienst_ok "$dienst" "$status" "$health" "$exitcode" \
                   && [ "$status" != "fehlt" ]; then
                    nebenbei="$nebenbei $dienst"
                fi
                continue ;;
        esac
        if [ -z "$schuld" ] && ! dienst_ok "$dienst" "$status" "$health" "$exitcode"; then
            schuld="$dienst"
        fi
    done

    echo
    if [ "$fehlend" -eq "$gesamt" ]; then
        echo "  Es existiert kein einziger Container. Der Stack wurde gestoppt"
        echo "  oder nie gestartet - deshalb nimmt Port ${dashboard_port} nichts an."
        echo
        echo "  Nächster Schritt:"
        echo "    docker compose up -d"
        return 0
    fi

    case "$schuld" in
        "")
            ;;
        postgres|redis)
            echo "  Die Datenbank bzw. Redis läuft nicht. Alles andere wartet"
            echo "  auf sie und startet gar nicht erst."
            echo
            echo "  Nächster Schritt:"
            echo "    docker compose logs $schuld | tail -40"
            nebenbefund; return 0 ;;
        migrate)
            echo "  Die Datenbank-Migration ist nicht durchgelaufen. Ohne sie"
            echo "  startet die API nicht, und ohne API kein Dashboard."
            echo
            echo "  Nächster Schritt:"
            echo "    docker compose logs migrate | tail -40"
            nebenbefund; return 0 ;;
        api)
            echo "  Die API ist nicht gesund. Das Dashboard startet erst, wenn"
            echo "  sie es ist - darum nimmt Port ${dashboard_port} nichts an."
            echo
            echo "  Nächster Schritt:"
            echo "    docker compose logs api | tail -40"
            nebenbefund; return 0 ;;
        frontend)
            echo "  Der Dashboard-Container läuft nicht. Genau er hält Port"
            echo "  ${dashboard_port} offen - deshalb kommt \"refused\"."
            echo
            echo "  Nächster Schritt:"
            echo "    docker compose logs frontend | tail -40"
            nebenbefund; return 0 ;;
    esac

    # Alle Glieder heil - dann liegt es zwischen Server und Browser.
    antwort=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
        "http://127.0.0.1:${dashboard_port}/healthz" 2>/dev/null)
    if [ "${antwort:-000}" = "200" ]; then
        echo "  Die Kette zum Dashboard ist vollständig, und auf dem Server"
        echo "  selbst antwortet Port ${dashboard_port}. Meldet der Browser trotzdem"
        echo "  \"refused\", sitzt es dazwischen: Firewall, Portfreigabe beim"
        echo "  Anbieter, oder es wird die falsche Adresse aufgerufen."
        echo
        echo "  Prüfen mit:"
        echo "    ss -tlnp | grep ${dashboard_port}   # lauscht überhaupt etwas?"
        echo "    ufw status                # blockt die Firewall?"
    else
        echo "  Die Kette zum Dashboard ist vollständig, aber auf dem Server"
        echo "  selbst antwortet Port ${dashboard_port} nicht (${antwort:-keine Antwort})."
        echo
        echo "  Nächster Schritt:"
        echo "    docker compose logs frontend | tail -40"
    fi

    nebenbefund
    if [ -n "${eng:-}" ]; then
        echo
        echo "  Und der Speicherplatz oben ist knapp. Alte Images aufräumen:"
        echo "    docker image prune -af"
    fi
}

# Der Port steht in der .env - ohne sie gilt der Standard.
dashboard_port=$(grep -E '^DASHBOARD_PORT=' .env 2>/dev/null | cut -d= -f2)
dashboard_port=${dashboard_port:-8080}

befund

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
    # Doppelte Schlüssel sind eine Falle: es gilt der LETZTE Wert. Wer den
    # ersten ändert, wundert sich, dass nichts passiert.
    dupes=$(grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' .env \
        | tr -d ' ' | sed 's/=$//' | sort | uniq -d)
    if [ -n "$dupes" ]; then
        echo
        echo "ACHTUNG: diese Schlüssel stehen MEHRFACH in der .env."
        echo "Es gilt jeweils der zuletzt genannte Wert:"
        printf '%s\n' "$dupes" | sed 's/^/  /'
    fi
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
port=$dashboard_port
for path in /healthz /api/health /api/stats /api/health/providers; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}${path}" 2>/dev/null)
    printf '  %-24s %s\n' "$path" "${code:-keine Antwort}"
done

line "Fertig"
echo "Diese Ausgabe enthält keine Geheimnisse und kann verschickt werden."
