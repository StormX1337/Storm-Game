# Storm Odds Sniper

Ein Low-Latency-Scanner für Fußball- und Tennisquoten mit Telegram-Alarmen und
Web-Dashboard.

Der Dienst überwacht Quoten mehrerer Anbieter parallel, rechnet aus dem
Marktkonsens eine **faire Quote** und meldet, wenn ein Buchmacher davon
deutlich abweicht — inklusive Bewertung, wie belastbar das Signal ist.

> **Der Bot analysiert ausschließlich.** Er platziert keine Wetten, meldet sich
> bei keinem Buchmacher an und verändert nichts auf fremden Webseiten. Es
> werden nur Quellen genutzt, deren automatisierter Abruf ausdrücklich erlaubt
> ist. Kein CAPTCHA-, Cloudflare- oder Anti-Bot-Bypass.

> ### 🔑 Ohne Zugangsdaten läuft nichts
>
> Das System zeigt **ausschließlich echte Quoten**. Es gibt keine Simulation
> und keine Ersatzquelle: fehlen die Zugangsdaten der in `PROVIDERS`
> genannten Quelle, bleibt der Scanner stumm und schreibt den Grund ins Log.
> Erfundene Daten in einem Werkzeug, das echte Fehlpreise finden soll, wären
> schlimmer als gar keine.
>
> Erster Schritt ist deshalb immer eine Datenquelle →
> [Abschnitt 9](#9-datenquellen-konfigurieren).

---

## Inhalt

1. [Was das System kann](#1-was-das-system-kann)
2. [Architektur](#2-architektur)
3. [Ubuntu vorbereiten](#3-ubuntu-vorbereiten)
4. [Docker installieren](#4-docker-installieren)
5. [Projekt installieren](#5-projekt-installieren)
6. [.env erstellen](#6-env-erstellen)
7. [Telegram-Bot erstellen](#7-telegram-bot-erstellen)
8. [Chat-ID herausfinden](#8-chat-id-herausfinden)
9. [Datenquellen konfigurieren](#9-datenquellen-konfigurieren)
10. [Starten](#10-starten)
11. [Dashboard öffnen](#11-dashboard-öffnen)
12. [Logs ansehen](#12-logs-ansehen)
13. [Telegram bedienen](#13-telegram-bedienen)
14. [Schwellen einstellen](#14-schwellen-einstellen)
15. [Wie die Erkennung funktioniert](#15-wie-die-erkennung-funktioniert)
16. [API](#16-api)
17. [Tests](#17-tests)
18. [Entwicklung ohne Docker](#18-entwicklung-ohne-docker)
19. [Fehlerbehebung](#19-fehlerbehebung)
20. [Updates](#20-updates)
21. [Sicherheit](#21-sicherheit)
22. [Projektstruktur](#22-projektstruktur)
23. [Bekannte Einschränkungen](#23-bekannte-einschränkungen)
24. [Rechtliches](#24-rechtliches)

---

## 1. Was das System kann

| Funktion | Beschreibung |
|---|---|
| 🎯 **Fixed-Odds-Fehler** | Quoten, die deutlich vom Marktkonsens abweichen — inklusive `error_score` 0–100 |
| 💎 **Value** | Positiver Erwartungswert gegenüber der fairen Quote, mit Confidence 0–100 |
| 📈 **Bewegungen** | Plötzliche Quotensprünge und Live-Bewegungen |
| 🔴 **Live** | Fußball mit Minute, Spielstand, Halbzeit und roten Karten; Tennis mit Satz, Games, Punkten und Aufschlag |
| 🤖 **Telegram** | Alarme in Echtzeit, persönliche Filter je Nutzer, Inline-Menü |
| 📊 **Dashboard** | Dark-Mode-Oberfläche mit Live-WebSocket |
| 🎯 **Empfehlung** | Aus jedem Alarm wird eine Handlungsempfehlung: spielen, kleiner Einsatz, beobachten oder sein lassen — mit Einsatzgröße nach fraktionalem Kelly |
| 🔒 **Sichere Wetten** | Widersprechen sich die Bücher, ist der Gewinn Arithmetik statt Schätzung — inklusive Einsatzverteilung je Ausgang |
| 📓 **Wett-Tagebuch** | Was du wirklich gespielt hast: Einsatz, Quote, Ausgang — daraus Gewinn/Verlust, Trefferquote und der Vergleich gegen das, was die Empfehlung versprach |
| 📒 **Trefferbilanz** | Jeder Alarm wird nachkontrolliert: hat der Buchmacher korrigiert, oder ist nur der Markt nachgezogen? Ohne zusätzlichen API-Aufruf |
| 🔌 **Austauschbare Quellen** | Drei Adapter hinter einer gemeinsamen Schnittstelle: SportsGameOdds (Live-Filter), The Odds API, Betfair Exchange |

**Unterstützte Märkte**

- Fußball: 1X2, Double Chance, Draw No Bet, Over/Under, Both Teams To Score,
  Asian Handicap, Handicap, Correct Score, Corners, Cards
- Tennis: Match Winner, Set Winner, Game Handicap, Set Handicap,
  Over/Under Games, Correct Set Score

Sportarten und Märkte werden generisch behandelt: neue Marktarten benötigen nur
einen Eintrag in `backend/models/enums.py` und eine Zuordnung im jeweiligen
Provider-Adapter — die Engine selbst kennt keine Sonderfälle.

---

## 2. Architektur

```
                       Browser (Dashboard)
                               │
                     ┌─────────▼─────────┐
                     │  nginx  :8080     │   ein Origin, kein CORS nötig
                     │  /  → statisch    │
                     │  /api, /ws → API  │
                     └─────────┬─────────┘
                               │
                     ┌─────────▼─────────┐
        ┌───────────▶│  FastAPI (api)    │◀──────── Prometheus /metrics
        │            │  REST + WebSocket │
        │            └────┬─────────┬────┘
        │                 │         │
        │            ┌────▼───┐ ┌───▼──────────┐
        │            │ Redis  │ │ PostgreSQL   │
        │            │ State  │ │ Historie     │
        │            │ Pub/Sub│ └───▲──────────┘
        │            └────▲───┘     │
        │                 │         │ gebündelte Writes
        │            ┌────┴─────────┴────┐
        │            │  scanner          │
        │            │  ├ Supervisor     │  Reconnect + Backoff
        │            │  ├ Normalisierung │  kanonische Event-IDs
        │            │  ├ Value Engine   │  Modelle A/B/C
        │            │  ├ Error-Detector │  error_score 0–100
        │            │  └ Filterkette    │  Stale/Cooldown/Duplikate
        │            └────▲──────────────┘
        │                 │
        │        ┌────────┴────────┬──────────────┐
        │   SportsGameOdds   The Odds API      Betfair
        │      (Push)           (REST)       (JSON-RPC)
        │
   ┌────┴──────────┐
   │ telegram-bot  │  eigener Prozess, hört auf Redis Pub/Sub
   └───────────────┘
```

**Drei getrennte Prozesse.** Scanner, API und Telegram-Bot blockieren sich
nicht gegenseitig: der Scanner schreibt in Redis und veröffentlicht Alarme über
Pub/Sub, API und Telegram-Bot lesen davon. Ein Telegram-Ausfall bremst die
Quotenanalyse nicht, ein API-Neustart unterbricht den Scan nicht.

Details: [`docs/ARCHITEKTUR.md`](docs/ARCHITEKTUR.md).

---

## 3. Ubuntu vorbereiten

Getestet mit Ubuntu 22.04 und 24.04.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ca-certificates
```

**Empfohlene Mindestausstattung**

| | Minimal | Produktivbetrieb |
|---|---|---|
| CPU | 2 Kerne | 4 Kerne |
| RAM | 2 GB | 4 GB |
| Platte | 10 GB | 40 GB (Zeitreihen wachsen) |

Optional Firewall — nach außen wird nur das Dashboard benötigt:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 8080/tcp
sudo ufw enable
```

---

## 4. Docker installieren

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker            # oder ab- und wieder anmelden
```

Prüfen:

```bash
docker --version
docker compose version
```

---

## 5. Projekt installieren

```bash
git clone <REPOSITORY-URL>
cd storm-odds-sniper
```

---

## 6. .env erstellen

```bash
cp .env.example .env
```

Ein sicheres Datenbankpasswort erzeugen und eintragen:

```bash
openssl rand -base64 24
nano .env
```

**Pflichtfeld:** `POSTGRES_PASSWORD`. Ohne diesen Wert startet Docker Compose
absichtlich nicht.

Damit überhaupt Daten fließen, braucht es zusätzlich eine Datenquelle in
`PROVIDERS` samt deren Zugangsdaten — siehe
[Abschnitt 9](#9-datenquellen-konfigurieren).

---

## 7. Telegram-Bot erstellen

1. In Telegram [@BotFather](https://t.me/BotFather) öffnen
2. `/newbot` senden
3. Anzeigenamen wählen, z. B. `Storm Odds Sniper`
4. Benutzernamen wählen, muss auf `bot` enden, z. B. `storm_odds_sniper_bot`
5. Der BotFather antwortet mit einem Token der Form `123456789:AA...`

Token in die `.env` eintragen:

```env
TELEGRAM_BOT_TOKEN=123456789:AAHnHhE-dein-echter-token
```

> Der Token darf **nie** ins Git und erscheint auch nicht im Log — das Logging
> filtert ihn automatisch heraus.

---

## 8. Chat-ID herausfinden

**Persönlicher Chat**

1. [@userinfobot](https://t.me/userinfobot) anschreiben
2. Die angezeigte Zahl ist die Chat-ID

**Gruppe**

1. Bot in die Gruppe einladen
2. Eine Nachricht in der Gruppe schreiben
3. Aufrufen: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Unter `"chat":{"id":-100...}` steht die ID — Gruppen-IDs sind negativ

```env
TELEGRAM_CHAT_ID=123456789
TELEGRAM_ADMIN_IDS=123456789
```

Mehrere Chats sind kommagetrennt möglich. Alternativ genügt es, dem Bot
`/start` zu schreiben: er legt den Nutzer dann selbst an, samt eigener
Filtereinstellungen.

---

## 9. Datenquellen konfigurieren

**Welche Quelle taugt für Live?** Kurz zusammengefasst, bevor es ins Detail geht:

| Quelle | Live geeignet | Kosten | Womit |
|---|---|---|---|
| The Odds API | erst ab bezahltem Tarif | Gratis-Tarif reicht nicht (~17 Abrufe/Tag) | derselbe Endpunkt, nur mit Kontingent |
| **SportsGameOdds** | **ja**, eigener `live=true`-Filter | Gratis-Einstieg; Pro (300 Anfragen/min) für dichte Live-Abdeckung | ein Abruf liefert alle Buchmacher |
| **Betfair Exchange** | **ja**, echte Börsenpreise mit Liquidität | Konto nötig, Daten kostenlos | bereits implementiert, nur nicht eingerichtet |

Für echtes Live-Scanning sind **SportsGameOdds** und **Betfair** die beiden
sinnvollen Wege. Betfair ist dabei schon fertig eingebaut — es fehlt nur der
App-Key.



Die Provider werden über `PROVIDERS` gewählt (kommagetrennt, mehrere parallel).

### The Odds API — echte Quoten, API-Key nötig

1. Key holen: <https://the-odds-api.com> (kostenloses Einstiegskontingent)
2. Key prüfen und übernehmen:

```bash
./scripts/setup-provider.sh the_odds_api --key DEIN_KEY --write
docker compose up -d
```

Das Skript sagt dir in einem Durchlauf, ob der Key gültig ist, welche
Wettbewerbe gerade laufen, wie viele Buchmacher tatsächlich zurückkommen,
wie viel Kontingent übrig ist und welchen Takt es hergibt. Ohne `--write`
ändert es nichts und zeigt nur das Ergebnis.

> Der Wrapper wählt selbst den passenden Weg: läuft Docker, startet er im
> API-Container (dort sind alle Abhängigkeiten installiert), sonst nutzt er
> `.venv` oder `python3`. **Auf einem frischen Server hat das
> System-Python die Abhängigkeiten nicht** — ein direktes
> `python3 scripts/setup_provider.py` scheitert dort an fehlenden Modulen.
> Und `python` gibt es auf Ubuntu gar nicht, nur `python3`.

Explizit im Container, falls du den Wrapper umgehen willst:

```bash
docker compose run --rm --user root -v "$PWD/.env:/app/.env" \
  api python /app/scripts/setup_provider.py the_odds_api --key DEIN_KEY --write
```

Manuell entspricht das:

```env
PROVIDERS=the_odds_api
ODDS_API_KEY=dein_key
ODDS_API_REGIONS=eu,uk
ODDS_API_MARKETS=h2h,totals
ODDS_API_POLL_INTERVAL=60
ODDS_API_PACE_TO_QUOTA=true
MIN_BOOKMAKERS=3
MAX_ODDS_AGE_SECONDS=600
```

#### ⚠️ Was das kostenlose Kontingent wirklich hergibt

Ein Abruf kostet `Märkte × Regionen` Credits, und es wird **je Wettbewerb
einmal** abgefragt:

| Konfiguration | Credits/Durchlauf | 500 Credits reichen für |
|---|---|---|
| 4 Wettbewerbe × 2 Märkte × 2 Regionen | 16 | ~31 Durchläufe |
| 2 Wettbewerbe × 1 Markt × 1 Region | 2 | ~250 Durchläufe |
| 1 Wettbewerb × 1 Markt × 1 Region | 1 | ~500 Durchläufe |

Selbst im günstigsten Fall sind das etwa **17 Abrufe pro Tag** — für
Live-Erkennung, die Sekunden zählt, ist das nicht genug. **Das kostenlose
Kontingent ist zum Ausprobieren da, nicht für den Dauerbetrieb.** Für echtes
Live-Scanning braucht es einen bezahlten Tarif oder ein Betfair-Konto.

Damit das Kontingent nicht in der ersten halben Stunde verglüht, drosselt sich
der Adapter selbst: er liest `x-requests-remaining` aus jeder Antwort und
wählt den Takt so, dass der Rest bis Monatsende reicht
(`ODDS_API_PACE_TO_QUOTA=true`). `ODDS_API_POLL_INTERVAL` ist dabei nur die
Untergrenze. Unterhalb von `ODDS_API_MIN_REMAINING` pausiert er ganz.

#### Zwei Werte, die zum Poll-Takt passen müssen

Sonst entsteht **kein einziger Alarm**:

- `MAX_ODDS_AGE_SECONDS` — bei einem Poll-Takt von Minuten gelten Quoten
  sonst schon beim Eintreffen als veraltet. Faustregel: mindestens das
  Doppelte des Takts. Der Scanner warnt beim Start, wenn das nicht passt.
- `MIN_BOOKMAKERS` — wie viele Buchmacher je Markt tatsächlich ankommen,
  sagt das Einrichtungsskript.

Diese Quelle liefert **keine** Spielminute, keine Karten und keine
Tennis-Punktdetails. Diese Felder bleiben leer — sie werden nicht geschätzt.

### SportsGameOdds — echter Live-Filter

```env
PROVIDERS=sportsgameodds
SGO_API_KEY=dein_key
SGO_LIVE_ONLY=true
```

Einrichten und in einem Rutsch prüfen — `--plan` setzt Poll-Takt und
Anfragelimit passend zum gebuchten Tarif:

```bash
./scripts/setup-provider.sh sportsgameodds --key DEIN_KEY --live --plan pro
./scripts/setup-provider.sh sportsgameodds --key DEIN_KEY --live --plan pro --write
```

| `--plan` | Anfragen/Minute | Poll-Takt | Seiten | ergibt |
|---|---|---|---|---|
| `free` | 10 | 30 s | 1 | 2 Anfragen/min |
| `allstar` | 60 | 10 s | 2 | 12 Anfragen/min |
| `pro` | 300 | 5 s | 3 | **36 Anfragen/min** |

Der Adapter rechnet zusätzlich selbst nach: ein Durchlauf kostet
`SGO_MAX_PAGES` Anfragen, und der Takt wird notfalls hochgesetzt, damit
`SGO_RATE_LIMIT_PER_MINUTE` eingehalten wird. Ein zu beherzt gesetztes
`SGO_POLL_INTERVAL` kann sich damit nicht selbst in 429er schicken.

Der Unterschied zu The Odds API: diese Quelle kennt einen **Live-Filter**
(`live=true`) und liefert je Markt die Preise **aller** Buchmacher in *einem*
Aufruf. Für Live-Erkennung ist das die günstigere Bauform — ein Abruf statt
einer pro Region und Markt.

Unterstützt werden 1X2, Draw No Bet, Doppelte Chance, Both Teams To Score,
Handicap und Over/Under (Fußball) sowie Match Winner, Game Handicap und
Over/Under Games (Tennis) — jeweils für Vollzeit, Halbzeiten und Tennissätze.

Was übersprungen wird, zählt das Einrichtungsskript mit `statID` und
Marktnamen auf. Fehlt dir dort etwas, schick die Zeilen — aus dem Namen lässt
sich die Zuordnung belegen, statt sie zu raten.

**Quotenformat:** die API liefert Quoten als Zeichenkette im amerikanischen
Format (`"-110"`, `"+150"`); der Adapter rechnet sie in Dezimalquoten um. Das
ist **gegen echte Daten bestätigt** (`+1775 → 18.75`, `-3476 → 1.029`). Genau deshalb zeigt das Einrichtungsskript Rohwert und
umgerechneten Wert nebeneinander:

```
--- Quotenformat prüfen (Rohwert -> umgerechnet) ---
      bet365         home         +110  ->  2.100
      pinnacle       away         -125  ->  1.800
```

Weicht die rechte Spalte von der Anzeige des Buchmachers ab, stimmt die
Annahme nicht — dann bitte melden, denn dann wäre **jeder** Preis falsch.

Was diese Quelle **nicht** liefert: Spielminute, Karten, Tennis-Punktdetails.
Diese Felder bleiben leer statt geschätzt zu werden. Spielerwetten und
unbekannte Marktarten werden übersprungen und gezählt (im Log und im
Einrichtungsskript sichtbar), nicht auf gut Glück zugeordnet.

Der Anbieter hat zusätzlich einen **WebSocket-Stream** (Pusher). Er ist hier
bewusst *nicht* implementiert: er setzt den teuersten Tarif voraus und ließe
sich ohne Konto nicht testen — ungetesteter Code im Low-Latency-Pfad ist ein
Risiko. Der REST-Adapter mit kurzem Poll-Takt deckt dieselben Daten ab.

### Betfair Exchange — Börsenpreise mit echter Liquidität

Registrierung: <https://developer.betfair.com> (Konto + App-Key erforderlich).

```env
PROVIDERS=betfair
BETFAIR_APP_KEY=dein_app_key
BETFAIR_USERNAME=dein_login
BETFAIR_PASSWORD=dein_passwort
# Empfohlen: zertifikatsbasierter Login (längere Sessions)
BETFAIR_CERT_FILE=/pfad/client.crt
BETFAIR_KEY_FILE=/pfad/client.key
```

Börsenpreise sind als Referenz besonders wertvoll: praktisch keine Marge, und
die verfügbaren Beträge sind ein echter Liquiditätsindikator. Die Engine
gewichtet Börsen deshalb höher.

### Kombination

```env
PROVIDERS=the_odds_api,betfair
```

Der Scanner führt Events beider Quellen automatisch zusammen (siehe
[Abschnitt 15](#15-wie-die-erkennung-funktioniert)).

Fehlt einem konfigurierten Provider ein Zugangsdatum, wird er übersprungen und
der Grund geloggt — die übrigen laufen weiter. Bleibt **keiner** übrig, bleibt
der Scanner stumm und schreibt den Grund ins Log. Es gibt bewusst keine
Ersatzquelle. Welche Quelle gerade läuft und was fehlt, zeigen das Dashboard und
`GET /health/providers`.

Ausführlich: [`docs/PROVIDER.md`](docs/PROVIDER.md).

---

## 10. Starten

```bash
docker compose up -d --build
```

Status prüfen:

```bash
docker compose ps
```

Erwartetes Bild:

```
NAME                            STATUS
storm-odds-sniper-api-1         Up (healthy)
storm-odds-sniper-frontend-1    Up (healthy)
storm-odds-sniper-postgres-1    Up (healthy)
storm-odds-sniper-redis-1       Up (healthy)
storm-odds-sniper-scanner-1     Up (healthy)
storm-odds-sniper-telegram-1    Up (healthy)
storm-odds-sniper-migrate-1     Exited (0)
```

`migrate` ist ein einmaliger Job: er wendet die Datenbankmigrationen an und
beendet sich. `Exited (0)` ist der Erfolgsfall.

Rauchtest:

```bash
docker compose exec api python /app/scripts/smoke_test.py http://127.0.0.1:8000
```

---

## 11. Dashboard öffnen

<http://localhost:8080> — oder `http://<server-ip>:8080`.

Das Dashboard zeigt:

- **Empfehlungen — was jetzt spielen?** ganz oben, mit der einen Leitzahl des
  Dashboards: wie viele Wetten gerade spielbar sind. Darunter Wette,
  Buchmacher, Quote und ein Einsatzvorschlag in Prozent der Bankroll. Bleibt
  die Liste leer, steht dort **warum**
  (siehe [Abschnitt 15, Schritt 10](#15-wie-die-erkennung-funktioniert)).
- **Alarme** mit Zeit, Sport, Event, Markt, Buchmacher, Quote, fairer Quote,
  Value, Confidence, **Tipp**, Status und **Urteil** — filterbar nach Art und
  Sportart.
  Ein Klick auf die Zeile klappt die Herleitung auf: der **Preis im Feld**
  (wo die gemeldete Quote zwischen allen Vergleichsquoten liegt, mit der
  fairen Quote als Bezugslinie), der **Verlauf** der letzten 30 Minuten als
  Kurve, die Empfehlung mit ausgeschriebener Rechnung, die verglichenen
  Preise, die drei Modelle, die Signale des Error-Scores und, sobald
  vorhanden, die Nachkontrolle mit den Preisen davor und danach. Der Verlauf
  wird erst beim Aufklappen geholt — für achtzig Alarme im Voraus wäre er
  Ballast.
- Filter **🟢 Spielbar** zeigt nur Alarme mit Einsatzvorschlag — die Frage
  „was davon lohnt sich?" in einem Klick.
- Antwortet ein einzelner Endpunkt nicht, sagt **seine** Kachel das
  („Nicht abrufbar"). Vorher blieb sie auf „Lade…" stehen und sah aus wie
  beschäftigt statt wie kaputt.

**Auf dem Handy** steht die Empfehlungskarte ganz oben und die Kennzahlen
ganz unten: acht Kacheln vor allem Nützlichen bedeuteten, dass man an einer
Wand aus Zahlen vorbeiscrollt, um zu sehen, was zu spielen ist. Die Kacheln
sind dort flach — Bezeichnung links, Wert rechts, halbe Höhe.

Aus der Alarmtabelle wird eine Karte je Alarm. Eine Tabelle
mit zwölf Spalten bricht auf 390 px jedes Wort einzeln um — „Ben Shelton vs
Carlos Alcaraz" wird dort zu sieben Zeilen. Dieselben Daten, dieselbe
Reihenfolge, nur eine Form, die auf den Bildschirm passt; die Herleitung
klappt in die Karte selbst auf.
- **Live-Events** mit Minute, Spielstand bzw. Satz, Games und Punkten. Ein
  Event ohne frische Daten fliegt hier raus (siehe
  [Abschnitt 15, Schritt 11](#15-wie-die-erkennung-funktioniert)); in der
  Alarmtabelle steht bei jedem Alarm sein Alter, alte Zeilen sind
  zurückgenommen — sie sind Historie, kein Angebot.
- **Quotenbewegungen**
- **Datenquellen** mit Status und fehlenden Zugangsdaten
- **Buchmacher** nach Alarmhäufigkeit
- **Warum keine Alarme?** — Zähler je Grund, in Klartext
- **Sichere Wetten** — Widersprüche zwischen Büchern, mit Einsatzverteilung.
  Die Karte erscheint nur, wenn es etwas gibt
  (siehe [Abschnitt 15, Schritt 12](#15-wie-die-erkennung-funktioniert))
- **Wett-Tagebuch** — was du wirklich gespielt hast und was dabei herauskam
  (siehe [Abschnitt 15, Schritt 13](#15-wie-die-erkennung-funktioniert))
- **Trefferbilanz** — was aus den Alarmen wurde, mit dem Abstand zum späteren
  Markt (siehe [Abschnitt 15, Schritt 9](#15-wie-die-erkennung-funktioniert))
- **Systemstatus** (Redis, Datenbank, Laufzeit, Snapshots)

Aktualisiert wird per WebSocket; REST dient als Rückfallebene, falls die
Verbindung abreißt.

---

## 12. Logs ansehen

```bash
docker compose logs -f scanner          # Quotenanalyse und Alarme
docker compose logs -f api              # HTTP und WebSocket
docker compose logs -f telegram-bot     # Nachrichtenversand
docker compose logs -f --tail=200       # alles zusammen
```

Nur Alarme:

```bash
docker compose logs -f scanner | grep ALERT
```

Beispielzeile (`LOG_JSON=false`):

```
2026-09-07 14:31:22.421 INFO    [scanner] ALERT kind=fixed_error status=LIVE
  title='Bayern München vs Borussia Dortmund' market='Over/Under 2.5'
  selection=Over bookmaker=ExampleBookie odds=4.2 fair=2.68 value=+56.7%
  confidence=94 error_score=91
```

Im Produktivbetrieb ist `LOG_JSON=true` voreingestellt (maschinenlesbar für
Loki/ELK). Tokens, API-Keys und Passwörter werden in beiden Formaten
automatisch entfernt.

---

## 13. Telegram bedienen

Dem Bot `/start` schreiben.

| Befehl | Wirkung |
|---|---|
| `/start` | Bot starten, Menü öffnen |
| `/help` | Hilfe |
| `/status` | Systemstatus und Datenquellen |
| `/settings` | Filter anzeigen und ändern |
| `/sports` | Sportarten wählen |
| `/live` | laufende Events |
| `/value` | beste aktuelle Value-Alarme |
| `/alerts` | letzte Alarme |
| `/tipps` | Was man jetzt spielen würde — mit Einsatzvorschlag |
| `/wetten` | Gespielte Wetten, abrechnen per Knopf |
| `/kasse` | Was dabei herausgekommen ist |
| `/arb` | Sichere Wetten: Widersprüche zwischen Büchern |
| `/bericht` | Tagesbericht: Wetten, Alarme, Trefferbilanz in einer Nachricht |
| `/bilanz` | Trefferbilanz: was aus den Alarmen wurde |
| `/pause` | Benachrichtigungen pausieren |
| `/resume` | Benachrichtigungen fortsetzen |

Inline-Menü: ⚽ Fußball · 🎾 Tennis · 🔴 Live · 🟢 Pre-Match · 💎 Value ·
🎯 Fixed Error · 📒 Bilanz · 💰 Kasse · 🔒 Sicher · 📅 Bericht · ⚙️ Einstellungen

### Der wirksamste Filter: „Nur ab Grad"

Ein laufender Scanner meldet viel. Im Betrieb kommen leicht **über tausend
Alarme am Tag** zusammen — und die meisten davon sind zwar echt auffällig,
aber nichts, was man spielen würde (siehe
[Abschnitt 15, Schritt 10](#15-wie-die-erkennung-funktioniert)). In dieser
Menge geht der eine gute Fund unter.

In `/settings` steht deshalb ein Knopf, der genau das abstellt:

| Einstellung | Was durchkommt | Anteil (Beispiellauf) |
|---|---|---:|
| 📢 Alle Alarme | alles — Standard, wie bisher | 100 % |
| ⚪ Ab beobachten | alles mit irgendeinem Rest-Vorteil | 35 % |
| 🟡 Ab kleiner Einsatz | nur mit Einsatzvorschlag | 24 % |
| 🟢 Nur spielen | nur die klaren Fälle | 12 % |

Der Standard bleibt **„Alle Alarme"**: nach einem Update soll niemand
plötzlich weniger bekommen, ohne es umgestellt zu haben. Ein Alarm **ohne**
Bewertung kommt immer durch — fehlende Information ist kein schlechtes
Urteil.

Wer es ruhiger mag, kombiniert das mit `/bericht`: eine Nachricht mit
Kasse, Alarmzahlen und Trefferbilanz statt hunderter Einzelmeldungen.

Jeder Nutzer hat **eigene** Schwellen (Value, Quote, Buchmacheranzahl,
Confidence, Cooldown, Sportarten, Märkte, Live/Pre-Match, Mindestgrad). Sie wirken zusätzlich
zu den globalen Schwellen des Scanners: der Scanner filtert grob vor, jeder
Nutzer verfeinert für sich.

**Beispielalarm Fußball**

```
🚨 STORM ODDS SNIPER
🔴 LIVE — FOOTBALL
🎯 FIXED ODDS ERROR

⚽ Bayern München
vs
⚽ Borussia Dortmund
🏆 Bundesliga
⏱ 67' (2H)
📊 Score: 1:1

📋 Markt: Over/Under 2.5
🎲 Auswahl: Over
🏦 Buchmacher: ExampleBookie

💰 Quote: 4.20
📊 Faire Quote: 2.68
💎 Value: +56.7%
📈 Abweichung: +56.7%
🏦 Referenz: 7 Buchmacher

🧠 Confidence: █████████░ 94/100
🎯 Error-Score: █████████░ 91/100
⚡ Erkannt: 14:32:18.421
```

**Beispielalarm Tennis**

```
🚨 STORM ODDS SNIPER
🔴 LIVE — TENNIS
💎 VALUE

🎾 Jannik Sinner
vs
🎾 Carlos Alcaraz
📊 Sätze: 1:1
🎾 Satz: 2
🎮 Games: 4-3
⚡ Punkte: 30-15
🎯 Aufschlag: Jannik Sinner

📋 Markt: Match Winner
🎲 Auswahl: Jannik Sinner
💰 Quote: 3.80
📊 Faire Quote: 2.35
💎 Value: +61.7%
🧠 Confidence: █████████░ 92/100
```

---

## 14. Schwellen einstellen

### Live und vor dem Anpfiff sind zwei Märkte

Das Dashboard hat oben zwei Ansichten: **Live** und **Vor dem Anpfiff**. Das
ist kein Filter auf denselben Daten, sondern eine echte Trennung — vor dem
Anpfiff sind mehr Buchmacher da, alle hatten Tage Zeit, und die Preise stehen
dichter beieinander. Mit den Live-Schwellen käme dort fast nichts durch, und
was durchkäme, wäre eher ein Datenfehler als ein Vorteil.

Einschalten:

```bash
PREMATCH_ENABLED=true
```

Standardmäßig **aus**, weil es zusätzliches API-Kontingent kostet — nach einem
Update soll sich niemandes Rechnung ändern, ohne dass er es eingeschaltet hat.

Prematch bekommt einen **eigenen, langsamen Abruf** mit eigenem Seitenbudget.
Der Grund ist nicht Ordnungsliebe: bei einem gemeinsamen Abruf würden die
vielen kommenden Spiele die wenigen laufenden aus dem Kontingent verdrängen —
der Live-Teil liefe leer, ohne dass irgendwo ein Fehler stünde.

| Variable | Standard | Bedeutung |
|---|---|---|
| `PREMATCH_ENABLED` | `false` | zweiter Abruf für Spiele vor dem Anpfiff |
| `PREMATCH_POLL_INTERVAL` | `60` | eigener Takt (live: 5 s) |
| `PREMATCH_MAX_PAGES` | `2` | eigenes Seitenbudget |
| `PREMATCH_MIN_VALUE_PERCENT` | `4` | leer = wie live |
| `PREMATCH_MIN_OUTLIER_PERCENT` | `6` | leer = wie live |
| `PREMATCH_MIN_BOOKMAKERS` | `5` | vor dem Anpfiff sind mehr Bücher da |
| `PREMATCH_ALERT_COOLDOWN` | `1800` | Sperre je Quotenzeile (live: `60`) |
| `PREMATCH_MAX_ALERT_AGE` | `3600` | so lange bleibt ein Alarm eine Empfehlung (live: `180`) |
| `PREMATCH_FOLLOWUP_AT_KICKOFF` | `true` | Nachkontrolle am Anpfiff statt nach 5 Minuten |
| `PREMATCH_HORIZON_HOURS` | `24` | nur Spiele, die heute anfangen (`0` = ohne Grenze) |

### „Guck nach den Spielen von heute"

Das ist kein Komfortwunsch, sondern behebt einen stillen Fehler. Der
Prematch-Abruf fragt bei der Quelle *alles ab, was nicht beendet ist* — das
schließt Spiele in zwei Wochen ein. Bei einem Seitenbudget von zwei Seiten à
100 Events können die Spiele von **heute** dabei schlicht nie ankommen, und
man merkt es nicht: die Liste ist ja voll.

`PREMATCH_HORIZON_HOURS=24` begrenzt das auf heute und heute Nacht. Ein Preis
für übernächsten Samstag ist ohnehin wertlos — er steht bis dahin zehnmal
anders.

Zwei Dinge fallen dabei ausdrücklich **nicht** weg:

* **Events ohne gelieferte Anstoßzeit.** Ein Spiel wegen einer fehlenden
  Angabe zu verwerfen wäre schlimmer, als es mitzunehmen.
* **Laufende Spiele.** Ihr Anpfiff liegt hinter ihnen; eine Zukunftsgrenze
  darf sie nicht treffen.

Was die Grenze aussortiert, wird gezählt und taucht in der Anbieter-Statistik
auf (`Anpfiff weiter als 24h entfernt`) — verschwiegen wird nichts.

### Warum die Nachkontrolle vor dem Anpfiff am Anpfiff stattfindet

Live sind fünf Minuten Wartezeit richtig: in der Zeit bewegt sich der Markt,
und der Vergleich sagt etwas. Vor dem Anpfiff bewegt sich in fünf Minuten
praktisch nichts — und das ist nicht nur wenig, es ist **null Information**.
Gegen die echte Urteilslogik gemessen:

```
Alarm: Quote 2.30 gegen faire Quote 2.10   (gemeldet +9.52 %)

  gar nichts bewegt        -> held    CLV +9.52 %
  Markt 0.5 % gewandert    -> held    CLV +9.00 %
  Buchmacher 1 Cent runter -> held    CLV +9.52 %
```

Der CLV ist **der gemeldete Vorteil nochmal**, und das Urteil ist immer
`held`. Im Backtest sähe das hinterher aus wie ein Beleg — es ist ein
Zirkelschluss, und die Spalte `korrigiert`, die genau davor schützen soll,
stünde für Prematch konstant auf 0 %.

Deshalb wird vor dem Anpfiff gegen die Linie **kurz vor Anpfiff** gemessen.
Das ist ohnehin, was „Closing Line Value" bedeutet: die Linie, bei der der
Markt schließt. Ein Alarm zwei Minuten vor Anpfiff bekommt trotzdem die
normale Wartezeit (sonst läge der Termin in der Vergangenheit), und ein Spiel
in fünf Tagen wird nach 23 Stunden geprüft — die Vormerkung in Redis lebt
24 Stunden.

Und die **Empfehlungskarte** vor dem Anpfiff: dort galt bis eben die
Live-Frist von drei Minuten. Eine Live-Quote steht keine drei Minuten — vor
dem Anpfiff steht dieselbe Quote stundenlang, und so verschwand jede
Prematch-Empfehlung nach drei Minuten wieder, obwohl der Preis noch da war.
Die Karte war praktisch immer leer.

Die längere Frist verlangt aber einen Riegel: **ist angepfiffen, ist der
Vorab-Preis weg** — egal wie frisch der Alarm noch wirkt. Solche Picks
fliegen jetzt mit eigener Begründung raus („Spiel läuft bereits"). Liefert
die Quelle keine Anstoßzeit, wird nichts angenommen; dann bleibt die Frist
die einzige Schranke.

Die lange Sperre ist kein Geschmack, sondern gemessen. Eine Fehlquote, die
stundenlang steht, **zappelt** dabei um ein, zwei Cent. Jede dieser
Winzigkeiten ist eine Preisänderung, also eine neue Bewertung — und sobald
die Sperre abgelaufen ist, ein neuer Alarm. Mit den Live-Werten (60 s) und
einem Prematch-Takt von 60 s wären das rund **180 Telegram-Nachrichten für
eine einzige Wette**, die drei Stunden gültig ist. Live ist das kein Thema:
dort ändern sich Preise wirklich, und ein Spiel dauert 90 Minuten statt zwei
Tagen.

Diese Zahlen sind ein **Startpunkt, kein Naturgesetz**. Prüf sie mit
`./scripts/backtest.sh` an deinen eigenen Daten — der Bericht trennt die
beiden Welten von selbst, sobald jede genug nachkontrollierte Alarme hat:

```bash
./scripts/backtest.sh --days 30                  # beide, getrennt
./scripts/backtest.sh --days 30 --phase prematch # nur vor dem Anpfiff
```

Reicht es in einer Welt noch nicht, steht ein **gemeinsamer** Bericht da —
mit einem Hinweis darauf, dass hier zwei Märkte in einem Topf stecken. Eine
Welt mit sieben ausgewerteten Alarmen als eigenen Bericht hinzustellen sähe
nach Aussage aus und wäre keine.

**Im Alarm selbst** steht vor dem Anpfiff die verbleibende Zeit —
`⏱ Anpfiff in 3 Std 11 Min (10.09. 19:59)`, in Telegram wie im Dashboard.
Nach der Quote ist das die wichtigste Zahl: in zwanzig Minuten muss man sich
jetzt entscheiden, in zwei Tagen ist der Preis bis dahin ohnehin ein anderer.
Liefert die Quelle keine Anstoßzeit, steht dort nichts.

Jeder Alarm trägt seitdem seine Welt mit (`phase`: `live` oder `prematch`) —
in der Datenbank als eigene Spalte, in der API als Filter
(`/alerts?phase=prematch`) und im WebSocket. Alarme aus der Zeit davor tragen
`unknown`: welcher davon zu einem laufenden Spiel gehörte, steht nirgends
verlässlich, und Raten wäre hier Erfinden.

### Die wichtigsten Werte in der `.env`

| Variable | Standard | Bedeutung |
|---|---|---|
| `MIN_VALUE_PERCENT` | `10` | Mindest-Erwartungswert für Value-Alarme |
| `MIN_OUTLIER_PERCENT` | `15` | Mindestabweichung für Fehlpreis-Alarme |
| `MIN_BOOKMAKERS` | `3` | Mindestzahl Referenz-Buchmacher |
| `MIN_ODDS` / `MAX_ODDS` | `1.50` / `51.0` | Quotenband |
| `MAX_ODDS_AGE_SECONDS` | `10` | älter = veraltet, wird ignoriert |
| `ALERT_COOLDOWN_SECONDS` | `60` | Sperre je Quotenzeile und Buchmacher |
| `MIN_CONFIDENCE` | `60` | Mindest-Confidence (gilt für beide Alarmarten) |
| `MIN_ERROR_SCORE` | `60` | Mindest-Error-Score für Fehlpreis-Alarme |
| `SCAN_LIVE` / `SCAN_PREMATCH` | `true` | Betriebsarten |
| `SPORTS_ENABLED` | `football,tennis` | aktive Sportarten |

**Zu viele Alarme?** `MIN_VALUE_PERCENT`, `MIN_CONFIDENCE` und
`MIN_BOOKMAKERS` erhöhen.
**Zu wenige?** `MIN_OUTLIER_PERCENT` senken und `MAX_ODDS_AGE_SECONDS`
erhöhen — Letzteres nur, wenn die Quelle langsam pollt.

Nach Änderungen:

```bash
docker compose up -d
```

---

## 15. Wie die Erkennung funktioniert

### Schritt 1 — Events zusammenführen

Anbieter schreiben Namen unterschiedlich („FC Bayern München", „Bayern
Munich", „Bayern"). Ohne Normalisierung vergleicht der Scanner Quoten
verschiedener Events — die häufigste Ursache für Fehlalarme.

Der `EventMatcher` bildet aus Sportart, normalisierten Teilnehmern und Datum
eine stabile, providerübergreifende ID und erkennt zusätzlich vertauschte
Heim-/Auswärtsreihenfolge. In dem Fall werden Selektion und Handicap-Linie
gespiegelt, damit nie ein Heim- gegen einen Auswärtspreis verglichen wird.

### Schritt 2 — faire Quote aus drei Modellen

| Modell | Verfahren |
|---|---|
| **A** | Median der implizierten Wahrscheinlichkeiten; bei vollständigem Buch über alle Selektionen normalisiert |
| **B** | Overround je Buchmacher entfernen (proportional oder equal-margin), dann mitteln |
| **C** | Wie B, aber gewichtet: Börsen und Low-Margin-Bücher zählen mehr, alte und illiquide Quoten weniger |

Der gewichtete Mix ergibt die faire Wahrscheinlichkeit. **Die Quote des
geprüften Buchmachers fließt nie in ihre eigene Referenz ein** — sonst zöge ein
Fehlpreis seine eigene Bewertung mit.

```
implied_probability = 1 / odds
value               = (odds × fair_probability) − 1
```

### Schritt 3 — Confidence 0–100

Marktbreite (32), Einigkeit der Bücher (24), Übereinstimmung der drei Modelle
(18), Aktualität (16), Datenqualität (10), abzüglich eines Live-Abschlags.

### Schritt 4 — Error-Score 0–100

```
Markt:  2.40  2.45  2.50  2.42  2.48
Bookie: 3.80

Faire Quote: 2.45
Abweichung:  +55.1 %
```

Acht gewichtete Signale (Summe 100): Abweichungsgröße (34), Marktbreite (16),
Bewegungsgeschwindigkeit (12), eigene Historie (8), Live/Pre-Match (8),
Liquidität (8), Datenqualität (10), Aktualität (4).

Nur eine **positive** Abweichung ist spielbar — eine zu niedrige Quote bekommt
Score 0.

### Schritt 5 — Vorreiter von Nachzügler unterscheiden

Das ist der Kern der Live-Erkennung:

- **Springt ein Buch als erstes**, während der Markt noch steht, *führt* es die
  Bewegung an (Tor, rote Karte, Verletzung). Es ist das aktuellste Buch, nicht
  das falsche → **kein Alarm**.
- **Bleibt ein Buch stehen**, während der Markt fällt, ist genau das der
  klassische vergessene Fehlpreis → **Alarm**.

Weil eine vergessene Quote sich definitionsgemäß nie ändert, prüft der Scanner
bei jeder Marktbewegung auch alle **unveränderten** Bücher der betroffenen
Quotenzeile. Zusätzlich werden zwei Zeitstempel getrennt geführt: wann ein
Preis zuletzt *bestätigt* wurde (Datenaktualität) und seit wann er *gilt*
(Standzeit). Ohne diese Trennung fiele der interessanteste Fall aus dem
Stale-Filter heraus.

### Schritt 6 — jeder Alarm ist nachprüfbar

Ein Alarm nennt nicht nur das Ergebnis, sondern die Grundlage: gegen welche
Preise verglichen wurde, was jedes der drei Modelle ergab und welche Signale
den Error-Score getragen haben. Im Dashboard klappt ein Klick auf die
Alarmzeile die Herleitung auf, Telegram schickt sie kompakt mit.

### Schritt 7 — und wenn nichts kommt?

Jede verworfene Quote wird nach Grund gezählt und im Dashboard unter
**„Warum keine Alarme?"** angezeigt — mit Klartext statt Codes:

```
Abweichung unter MIN_OUTLIER_PERCENT     42.090
Quote unter MIN_ODDS                     11.699
Buch führt die Bewegung an                8.850
Duplikat (gleicher Preis)                 6.859
```

Ein korrekt arbeitendes, aber zu streng eingestelltes System sieht sonst
genauso aus wie ein kaputtes. Dieselben Zahlen liefert
`GET /stats` im Feld `suppressed` und Prometheus unter
`storm_alerts_suppressed_total`.

### Schritt 8 — False-Positive-Schutz

Mindestanzahl Buchmacher · Mindest-Value · Mindestabweichung · maximales
Quotenalter · Cooldown je Quotenzeile · Duplikaterkennung über Preis-Buckets ·
Suspendierungs-Erkennung · Marktdrift-Unterdrückung · Ausschluss praktisch
entschiedener Märkte.

### Schritt 9 — die Gegenprobe: was ist aus dem Alarm geworden?

Ein Alarm ist eine Behauptung: *dieser Preis ist besser als der Markt*. Ohne
Nachkontrolle bleibt sie unüberprüft — das System meldet, und niemand weiß, ob
die Meldungen etwas taugen.

Deshalb wird jeder Alarm vorgemerkt und nach `FOLLOWUP_AFTER_SECONDS`
(Standard: 5 Minuten) **erneut gegen den Markt gehalten**. Das kostet
**keinen einzigen zusätzlichen API-Aufruf** — es wird nur noch einmal
angesehen, was ohnehin schon in Redis liegt. Gerade beim knappen
Gratis-Kontingent ist das der Punkt: die Bilanz ist umsonst.

Entscheidend ist die Frage, **wer** die Lücke geschlossen hat:

```
Alarm:   Bookie 3.80   fair 2.45   (+55 %)
Später:  Bookie 2.50   fair 2.47

  → der Buchmacher ist gefallen, der Markt stand.
    Urteil: ✅ korrigiert — der Fehlpreis war echt und ist weg.
```

```
Alarm:   Bookie 3.80   fair 2.45   (+55 %)
Später:  Bookie 3.85   fair 3.70

  → der Markt ist gestiegen, nicht der Buchmacher.
    Urteil: ↗️ Markt gefolgt — das Buch war nur schneller, kein Vorteil.
```

Diese Unterscheidung ist der ganze Punkt. Ein System ohne sie zählt beide
Fälle als Treffer und sieht damit deutlich besser aus, als es ist.

| Urteil | Bedeutung |
| --- | --- |
| ✅ **korrigiert** | Der Buchmacher hat den Preis selbst gesenkt. Stärkster Beleg für einen echten Fehlpreis. |
| 🚫 **verschwunden** | Die Quote wurde zurückgezogen oder gesperrt — typisch für echte Eingabefehler. |
| ↗️ **Markt gefolgt** | Der Markt ist zum gemeldeten Preis gestiegen. Kein Fehler des Buchmachers, kein Vorteil. |
| ⏸ **unverändert** | Der Preis steht noch. Entweder ein dauerhaft weiches Buch oder eine Schieflage im eigenen Modell. |
| ↩️ **zurückgelaufen** | Nur bei Bewegungsalarmen: der Sprung hielt nicht. |
| 🔄 **überholt** | Zwischen Alarm und Nachkontrolle fiel ein Tor bzw. endete ein Satz. Die wahre Wahrscheinlichkeit ist eine andere geworden — ein Preisvergleich wäre sinnlos. |
| ❔ **offen** | Keine Folgedaten. Wird **nie** als Erfolg gezählt. |

Dazu kommt der **Closing Line Value (CLV)**: um wie viel Prozent der
gemeldete Preis über der zuletzt beobachteten fairen Quote lag.

Unter zehn ausgewerteten Alarmen zeigen Dashboard und Telegram **keinen**
Durchschnitt, sondern den Zählerstand. Ein Mittelwert aus einem Alarm ist ein
Einzelfall — im Testlauf stand dort kurzzeitig „−88,7 %", gebildet aus genau
einer Zeile.

> **Wichtig, und bitte nicht überlesen:** CLV ist **kein Gewinn**. Er misst
> nur, dass ein Preis besser war als der Marktkonsens kurz danach — nicht,
> ob eine Wette gewonnen hätte. Und der „Schlusskurs" ist hier immer nur der
> *zuletzt beobachtete* Kurs; wer selten pollt, misst gegen eine grobe
> Referenz. Bei einem Poll-Takt von einer Stunde ist die Bilanz eher ein
> Indiz als eine Messung.

Zu sehen ist das an vier Stellen:

* **Dashboard** — Panel „Trefferbilanz" und die Spalte *Urteil* in der
  Alarmtabelle. Ein Klick auf die Zeile zeigt die Preise davor und danach.
* **Telegram** — `/bilanz`
* **API** — `GET /alerts/scorecard`, dazu `verdict` und `clv_percent` an
  jedem Alarm in `GET /alerts`
* **Prometheus** — `storm_alert_verdicts_total{verdict="…"}` und
  `storm_followups_pending`

**Im Live-Betrieb bleibt vieles „überholt".** Fällt zwischen Alarm und
Nachkontrolle ein Tor, ist der Vergleich hinfällig — im Testlauf traf
das auf mehr als die Hälfte der Live-Alarme zu. Das ist kein Defekt, sondern
die ehrliche Antwort: über ein Tor hinweg lässt sich nichts messen. Bei
Pre-Match-Alarmen (der Normalfall mit The Odds API) ändert sich der Spielstand
nicht, dort bekommt fast jeder Alarm ein echtes Urteil. Wer eine aussagekräftige
Bilanz für Live-Wetten will, muss `FOLLOWUP_AFTER_SECONDS` kurz halten.

Stellschrauben in der `.env`:

```env
FOLLOWUP_ENABLED=true          # ganz abschaltbar
FOLLOWUP_AFTER_SECONDS=300     # Wartezeit bis zur Nachkontrolle
FOLLOWUP_INTERVAL_SECONDS=30   # Takt der Auswertung
FOLLOWUP_MOVE_PERCENT=2.0      # ab wann ein Preis als bewegt gilt
```

`FOLLOWUP_AFTER_SECONDS` muss **unter** `ODDS_STATE_TTL_SECONDS` (Standard
900) liegen — sonst ist der Vergleichsmarkt beim Auswerten schon abgelaufen
und jedes Urteil lautet „offen". Der Scanner warnt beim Start, wenn das
passiert.

### Schritt 10 — was soll man davon spielen?

Ein Alarm ist eine Beobachtung, keine Anweisung. Die Frage danach lautet:
**spielen oder nicht — und mit wie viel?** Diese Rechnung macht
`backend/core/recommendation.py`, und zwar bewusst nicht so, wie es
naheliegt.

Naheliegend wäre: nach Value absteigend sortieren, oben steht die beste
Wette. Genau das ist der teuerste Fehler, den dieses Modul machen könnte.
Eine Quote, die **250 % über dem Markt** liegt, ist so gut wie nie ein
Vorteil, sondern ein Datenfehler: eine andere Linie, ein stehengebliebener
Preis, ein Markt, der nur so heißt wie unserer. Wer nach Value sortiert,
sortiert die Datenfehler nach oben.

Deshalb gilt hier: **je größer die gemeldete Abweichung, desto stärker der
Verdacht auf einen Fehler statt auf einen Vorteil.** Der *glaubwürdige*
Vorteil steigt zuerst mit der Abweichung, hat ein Maximum und fällt danach
wieder gegen null:

| gemeldeter Value | Plausibilität | glaubwürdiger Vorteil | Empfehlung |
|---:|---:|---:|---|
| +5 % | 0,82 | +3,2 % | spielen |
| +10 % | 0,46 | +3,6 % | spielen |
| +15 % | 0,17 | +2,0 % | kleiner Einsatz |
| +20 % | 0,04 | +0,7 % | nur beobachten |
| +30 % | 0,00 | +0,0 % | nicht spielen |
| +250 % | — | — | abgelehnt: Datenfehler |

<sub>Werte für 20 Vergleichsquoten, Confidence 80 und eine frische Quote. Weniger Bücher, geringere Confidence oder ein älterer Preis drücken jede Zeile weiter nach unten.</sub>

Das ist keine Willkür, sondern das übliche Verhalten robuster Schätzer bei
schwerschwänzigen Fehlern (redeszendierende Einflussfunktion): ab einem
gewissen Abstand ist ein weiterer Schritt weg vom Markt kein Argument
mehr *für* die Wette, sondern eines *dagegen*. Bei einem belegten Fehlpreis
(hoher Error-Score) darf der Abstand größer sein — dort ist die Behauptung ja
gerade, dass dieses eine Buch danebenliegt.

Der Rechenweg je Alarm:

1. **Rohvorteil** — `value_percent`, was das Modell behauptet.
2. **Verlässlichkeit** — Buchmacheranzahl, Confidence und Quotenalter,
   jeweils gedeckelt. Wer die harten Mindestwerte reißt, fliegt vorher raus.
3. **Plausibilität** — die Kurve oben.
4. **Glaubwürdiger Vorteil** = 1 × 2 × 3. **Danach** wird sortiert.
5. **Einsatz** — fraktionaler Kelly auf genau diesen Vorteil, nie auf den
   Rohwert: `Einsatz = KELLY_FRACTION × Vorteil / (Quote − 1)`, gedeckelt
   durch `MAX_STAKE_PERCENT`.
6. **Die Rechnung ausschreiben.** Prozentwerte beantworten die Frage nicht,
   die man sich vor dem Setzen stellt. Also steht sie da:

   | | |
   |---|---:|
   | Einsatz | 6,80 |
   | bei Gewinn zurück | 15,10 |
   | davon Gewinn | +8,30 |
   | Erwartungswert | +0,23 |
   | Trefferquote nötig | 45,0 % |
   | geschätzt | 46,5 % |

   Alles folgt exakt aus Quote, Einsatz und dem glaubwürdigen Vorteil:
   Auszahlung `= Einsatz × Quote`, nötige Trefferquote `= 1 / Quote`,
   geschätzte `= (1 + Vorteil) / Quote`. **Ohne `BANKROLL` bleiben die
   Beträge weg** — einen Einsatz in Euro zu nennen, den niemand festgelegt
   hat, wäre eine erfundene Zahl. Die Verhältnisse gelten trotzdem und
   stehen dann allein da.

Die Liste selbst ist zusätzlich entdoppelt, weil Alarme **nicht unabhängig**
sind:

* **Gleiche Wette nur einmal**, zum höchsten Preis. Für dieselbe Selektion
  ist das keine Schätzung, sondern Arithmetik: 2.20 schlägt 2.10.
* **Höchstens eine Wette je Event** (`RECOMMEND_MAX_PICKS_PER_EVENT`). Zwei
  Selektionen desselben Spiels hängen zusammen; ohne diese Regel könnte die
  Liste Über *und* Unter empfehlen.
* **Gesamtbudget** (`MAX_TOTAL_STAKE_PERCENT`). Zehn gute Wetten sind nicht
  zehnmal so sicher wie eine — sie sind zehnmal so viel Einsatz.

**Bleibt nichts übrig, steht dort warum.** Eine leere Liste ohne Begründung
ist der Zustand, in dem man an der Anlage zweifelt statt am Markt — deshalb
zählt `dropped` jeden Ablehnungsgrund mit, im Dashboard, in `/tipps` und in
`GET /alerts/recommendations`.

Zu sehen ist das an vier Stellen:

* **Dashboard** — Karte „Empfehlungen — was jetzt spielen?" (mit der
  ausgeschriebenen Rechnung je Vorschlag) und die Spalte *Tipp* in der
  Alarmtabelle
* **Telegram** — `/tipps`, dazu ein Empfehlungsblock in jeder Alarmnachricht
* **API** — `GET /alerts/recommendations`, `GET /alerts?grade=strong`, sowie
  `recommendation` an jedem Alarm
* **Datenbank** — `alerts.recommendation_grade`, `alerts.stake_percent`,
  `alerts.credible_edge_percent`

> **Wichtig, und bitte nicht überlesen:** das ist eine Schätzung aus
> öffentlich abrufbaren Quoten — **keine Wettberatung und keine
> Gewinngarantie**. Der Einsatzvorschlag ist eine Kelly-Rechnung auf eine
> *geschätzte* Wahrscheinlichkeit, kein Versprechen. Das System setzt nichts
> und verändert nichts bei Buchmachern; ob und was gespielt wird, entscheidet
> der Mensch. Preise vor dem Setzen selbst prüfen — die Quote kann längst weg
> sein.

Stellschrauben in der `.env`:

```env
RECOMMEND_ENABLED=true         # ganz abschaltbar
BANKROLL=0                     # 0 = nur Prozentwerte, kein erfundener Betrag
KELLY_FRACTION=0.25            # Viertel-Kelly
MAX_STAKE_PERCENT=2.0          # Deckel je Wette
MAX_TOTAL_STAKE_PERCENT=6.0    # Deckel über die ganze Liste
PLAUSIBLE_EDGE_PERCENT=8.0     # größer = mehr Datenfehler in der Liste
ABSURD_EDGE_PERCENT=60.0       # darüber ohne Rechnung abgelehnt
```

### Schritt 11 — wann ein Event aufhört, live zu sein

Ein beendetes Spiel meldet bei den üblichen Quellen **kein „beendet"**. Es
verschwindet einfach aus der Antwort: SportsGameOdds wird mit
`finalized=false` (und im Live-Modus `live=true`) abgefragt, ein fertiges
Match fällt damit aus dem Ergebnis heraus. Es kommt also nie ein Snapshot mit
`ended: true` an, aus dem sich der Status ableiten ließe.

Ohne Gegenmaßnahme bleibt die Event-ID deshalb in der Live-Menge stehen, bis
ihr Schlüssel abläuft — und das Dashboard zeigt ein fertiges Spiel **bis zu
einer Stunde** als laufend. Genau das ist passiert.

Die Lösung ist bewusst zurückhaltend: Ein Event, dessen Daten seit
`EVENT_STALE_SECONDS` (Standard 180) nicht mehr bestätigt wurden, gilt nicht
mehr als live. Der Status wird **nicht** auf `FINISHED` gesetzt — dass keine
Daten mehr kommen, heißt nicht zwingend, dass das Spiel vorbei ist; es kann
auch die Quelle sein. Behauptet wird nur das, was stimmt:

* `GET /events` liefert je Event `seconds_since_update` und `stale`
* `GET /events/live` lässt veraltete Events weg
* der Scanner räumt sie im Health-Takt aus `ev:live` (Log: „events ohne
  frische daten")
* das Dashboard nimmt sie aus der Live-Liste und nennt in der leeren Kachel
  die Anzahl — „beendet oder Quelle still"

Dieselbe Frist gilt für die Empfehlungsliste: ein Alarm, der älter ist, wird
mit dem Grund „Alarm zu alt — der Preis steht so nicht mehr" verworfen. Ohne
das stünde die Wette auf ein längst beendetes Spiel weiter ganz oben.

Die Alarmtabelle ist davon unberührt: sie ist eine **Historie**, alte Alarme
gehören dazu. Sie dürfen nur nicht aussehen wie aktuelle Angebote, deshalb
steht bei jeder Zeile das Alter („vor 16 Min") und alte Zeilen sind
ausgegraut. Der Preis von vor einer Viertelstunde ist ohnehin weg.

### Schritt 12 — wenn die Bücher sich widersprechen

Der Rest dieses Projekts **schätzt**. Die faire Quote ist ein Modell, der
Vorteil eine Annahme, die Empfehlung eine Rechnung auf beides. Hier nicht:

```
Über 2.5  bei A zu 2.10   ->  1/2.10 = 47,6 %
Unter 2.5 bei B zu 2.15   ->  1/2.15 = 46,5 %
                              ------------
                                       94,1 %
```

Zusammen unter 100 %. Also lässt sich jeder Ausgang so kaufen, dass mehr
zurückkommt als eingesetzt wurde — **egal wie das Spiel ausgeht**. Bei 1000
Einsatz: 505,90 auf Über, 494,10 auf Unter, Rückfluss 1062,39 in beiden
Fällen. Das ist keine Prognose, sondern Arithmetik.

Der Haken liegt nicht in der Rechnung, sondern in der Wirklichkeit, und das
System sagt das an drei Stellen offen:

* **Ein einziger Buchmacher ist keine Arbitrage.** Widerspricht sich ein
  Buch in sich selbst, ist das fast immer eine falsche Linie oder ein
  veralteter Preis — kein Geschenk. Solche Funde fallen raus.
* **Zu schön ist verdächtig.** Reale Widersprüche liegen bei 0,5–3 %. Alles
  jenseits von `ARBITRAGE_MAX_PROFIT_PERCENT` wird als Datenfehlerverdacht
  markiert und standardmäßig gar nicht erst angezeigt.
* **Preise sind flüchtig.** Beide Seiten müssen frisch sein, und selbst dann
  kann eine davon weg sein, bevor die zweite Wette steht. Wer nur eine Seite
  bekommt, hat eine ungewollte Einzelwette. Das Alter der ältesten
  beteiligten Quote steht überall dabei.
* **Börsen nehmen Kommission.** Betfair & Co. behalten 2–5 % des
  *Nettogewinns*. Reale Arbitragen liegen bei 0,5–3 % — also regelmäßig
  **unterhalb** dieser Gebühr. Gerechnet wird deshalb mit der effektiven
  Quote `1 + (Quote − 1) × (1 − Kommission)`; angezeigt und gespielt wird
  die echte. Ein Fund mit Börsenbein wird zusätzlich gekennzeichnet, weil
  dein Konto eine andere Gebühr haben kann als `ARBITRAGE_EXCHANGE_COMMISSION`.

Weil der Einsatz nicht wirklich risikofrei ist (es füllt vielleicht nur ein
Bein), gilt auch hier `MAX_TOTAL_STAKE_PERCENT` als Deckel — nicht die ganze
Bankroll auf einen Fund.

Zusätzliche API-Aufrufe kostet das **keine**: der Markt liegt beim Prüfen
ohnehin schon vollständig vor. Dasselbe gilt für den **Quotenverlauf** in
der Alarm-Herleitung: er kommt aus den ohnehin gespeicherten Snapshots.
Eine Quote, die seit zehn Minuten unverändert dasteht, während der Markt
abrutscht, ist der klassische vergessene Preis — und das sieht man in einer
Kurve sofort, in einer einzelnen Zahl nie. Gefunden wird selten — die Dashboard-Karte
bleibt verborgen, solange es nichts gibt, statt eine dauerhaft leere Kachel
zu zeigen.

---

### Schritt 13 — hat es Geld gebracht?

Die Trefferbilanz aus Schritt 9 misst, ob die **Alarme** etwas taugten. Das
ist eine andere Frage als die, um die es am Ende geht. Ein Alarm kann sauber
gewesen sein, und der Preis war trotzdem weg, als du geklickt hast.
Umgekehrt sagt ein positiver Closing Line Value nichts darüber, ob die Wette
gewonnen hat.

Das **Wett-Tagebuch** rechnet deshalb nur mit dem, was wirklich passiert
ist: Einsatz, genommene Quote, Ausgang. Eintragen geht über den Knopf
`✅ Gespielt` — im Telegram-Bot an jedem Alarm mit Einsatzvorschlag, im
Dashboard an jeder Empfehlung. Abgerechnet wird per Knopf (`/wetten`) oder
über die API.

Was dabei herauskommt (`/kasse`, Panel „Wett-Tagebuch"):

| | |
|---|---|
| Wetten | 24 (3 offen) |
| Ergebnis | +38,40 auf 141,00 Einsatz |
| Trefferquote | 47,6 % |
| Rendite | +27,2 % |
| Erwartet war | +5,1 % |

Drei Dinge, die dieses Modul bewusst *nicht* tut:

* **Es setzt nichts** und kennt keine Ergebnisse. Der Mensch trägt ein, wie
  es ausgegangen ist. Automatisch abzurechnen ginge nur über Resultatdaten,
  die diese Quellen für beendete Spiele gar nicht mehr liefern (siehe
  Schritt 11) — geraten wird hier nichts.
* **Annullierte Wetten verzerren nichts.** Sie zählen weder als Treffer noch
  als Fehlschlag und nicht in den riskierten Einsatz. Würde man sie
  mitzählen, sähe jede Rendite besser aus, als sie war.
* **Eine Rendite aus fünf Wetten wird nicht als Rendite ausgegeben.**
  Unterhalb von 20 abgerechneten Wetten steht dort der Zählerstand und der
  Hinweis, dass die Prozentzahl Zufall wäre — dieselbe Haltung wie bei der
  Trefferbilanz.

Ohne `BANKROLL` sind Einsätze **Prozentpunkte der Bankroll**, keine Beträge.
Die Einheit steht nicht nur in der Anzeige, sondern **an jeder Zeile**: wer
`BANKROLL` mittendrin setzt, hätte sonst Anteile und Beträge in einer Summe
— eine Zahl ohne Bedeutung. Kommt beides vor, sagt die Bilanz es.

**Wem gehört welche Zeile?** Über Telegram ist der Absender bekannt, über
HTTP nicht — dort gibt es keine Anmeldung. Daraus folgen zwei Regeln:
Ändern und Löschen über HTTP betrifft **nur Zeilen ohne Nutzer** (also was
auch über HTTP entstand); gelesen wird das ganze Buch, damit im Dashboard
auftaucht, was über Telegram eingetragen wurde — die Telegram-ID steht dabei
**nicht** in der Antwort.

> **Zum Schreibzugriff über die API:** `BETLOG_API_WRITES` ist standardmäßig
> **aus**. Die API ist genau so geschützt wie das Dashboard davor — steht das
> offen im Netz, könnte jeder Fremde Wetten in dein Tagebuch eintragen. Erst
> `./scripts/set-dashboard-password.sh` laufen lassen, dann einschalten. Über
> Telegram geht es auch ohne: dort ist der Absender bekannt, und jeder sieht
> nur seine eigenen Wetten.

### Schritt 14 — stimmt das Modell überhaupt?

Das Empfehlungsmodul trifft eine starke Behauptung: eine sehr große
gemeldete Abweichung sei **kein** Vorteil, sondern ein Datenfehler — und ein
Alarm mit +11 % darum die bessere Wette als einer mit +45 %. Das ist
begründet (Schritt 10), aber es ist eine Behauptung.

Prüfbar ist sie mit Daten, die längst in deiner Datenbank liegen: jeder
Alarm bekommt aus der Nachkontrolle einen Closing Line Value.

```bash
./scripts/backtest.sh              # letzte 7 Tage
./scripts/backtest.sh --days 30
./scripts/backtest.sh --json > pruefung.json
```

Zwei Fragen:

```
1) Trennt der Grad?
  Grad                Alarme  davon   Median    Mittel  korrigiert  kaputt
  Spielen                 34     34   +6.3 %    +6.8 %        61 %       0
  Kleiner Einsatz         58     58   +6.5 %    +7.1 %        58 %       0
  Nur beobachten          28     28   +5.5 %    +5.9 %        44 %       1
  Nicht spielen          120    120   -4.9 %   +92.1 %         9 %      27

2) Hilft die Schrumpfung?
    glaubwürdigem Vorteil : Median-CLV   +6.7 %   selbst korrigiert 60 %
    gemeldetem Value      : Median-CLV  +88.0 %   selbst korrigiert  0 %
```

### „Kann man das nicht auf 85 % Trefferquote bringen?"

Nein — und zwar nicht, weil es zu aufwendig wäre, sondern weil die Frage
selbst in die Irre führt. Zwei Gründe:

**Die Trefferquote kommt aus dem Markt, nicht aus dem Code.** Kein Programm
macht eine Prognose richtiger. Code kann nur *strenger auswählen* — und das
kostet Gelegenheiten.

**Eine Trefferquote ohne die Quote daneben ist keine Zahl.** Wer nur auf
Favoriten zu 1.15 setzt, trifft 87 % und verliert trotzdem Geld: bei dieser
Quote wären 87 % nötig, nur um bei null zu landen. Umgekehrt sind 40 % bei
Quote 3.00 ein solider Vorteil, denn nötig wären dort 33 %.

Deshalb beantwortet die Modellprüfung die Frage mit einer Kurve statt einer
Zusage — Abschnitt 3 des Berichts:

```
3) Wie streng lohnt sich?
   ab Vorteil  Alarme  davon  schlägt Markt  korrigiert  Ø Quote   nötig
          0 %     130    117           97 %        18 %     3.17    31 %
          1 %      24     19           95 %        58 %     2.84    35 %
          2 %      14     12           92 %        75 %     2.75    36 %
          3 %       5      4           75 %        50 %     2.55    39 %
```

Links steht, wie streng gefiltert wird, rechts was es bringt — und in der
Mitte, wie viel davon übrig bleibt. **Eine Schwelle mit 90 % und zwei
Alarmen im Monat ist keine Einstellung, sondern Stillstand.** Die Spalte
`nötig` ist der eigentliche Maßstab: nur der Abstand zwischen *erreicht* und
*nötig* ist ein Vorteil.

Und auch das hier ist CLV, nicht Gewinn. **Was wirklich Geld gebracht hat,
steht ausschließlich im Wett-Tagebuch** (Schritt 13) — und erst ab 20
abgerechneten Wetten ist das mehr als Zufall.

### Nur bei den eigenen Buchmachern melden

Ein Fehlpreis bei einem Buchmacher, bei dem man kein Konto hat, ist keine
Gelegenheit — er ist Zeitverschwendung. `ALERT_BOOKMAKERS` beschränkt die
Meldungen auf die eigenen Bücher:

```bash
ALERT_BOOKMAKERS=efbet,winbet,palmsbet
```

**Der Filter greift am Alarm, nicht am Abruf** — und das ist der ganze Punkt.
Der naheliegende Weg wäre `SGO_BOOKMAKERS`, also die Quelle selbst
einzuschränken. Das ist der falsche Hebel: die faire Quote lebt davon,
möglichst viele Bücher zu vergleichen. Wer die Referenz schrumpft, findet
**weniger** Fehlpreise statt mehr — und die gefundenen sind schlechter belegt.
Hier bleibt die Referenz vollständig; gefiltert wird erst die Meldung.

### Quellen ohne Namen: `unknown`

In der Buchmacherliste steht ein Eintrag namens **`unknown`** — auf einem
echten Server 213.761 Preise und **394 Alarme**. Dieser Name kommt nicht aus
diesem Projekt; die Datenquelle liefert ihn so. Was dahintersteckt, steht
nirgends: ein Buchmacher, dessen Kennung nicht aufgelöst wurde, oder ein
zusammengefasster Wert.

Beides taugt nicht:

* **Als Alarm ist er unspielbar.** Man kann bei „unknown" kein Konto haben.
  394 Meldungen, auf die niemand reagieren konnte.
* **Als Vergleichsquote wäre er gefährlich.** Wäre es ein Durchschnitt, zöge
  er den Median zur Mitte und verdeckte genau die Ausreißer, die gesucht
  werden. Außerdem zählte er als „Vergleichsquote" mit und ließ die Referenz
  breiter aussehen, als sie ist.

`EXCLUDED_BOOKMAKERS=unknown` (Standard) sortiert solche Quoten **ganz vorn**
aus — vor dem Buch, vor der fairen Quote, vor der Zählung. Später zu filtern
hieße, sie an allen früheren Stellen doch zu verwenden. Was wegfällt, wird als
Unterdrückungsgrund gezählt und ist im Dashboard sichtbar.

> Auf etwas zu bauen, das man nicht benennen kann, ist hier die falsche
> Richtung. Wer es doch will: `EXCLUDED_BOOKMAKERS=` leer lassen.

### Börsen erkennen — sonst meldet die Arbitrage Verluste als Gewinne

Eine Wettbörse zieht **Kommission vom Gewinn** ab. Eine Quote von 2.03 zahlt
dort effektiv 1.98. Nur der Betfair-Adapter kennzeichnet das selbst; über
SportsGameOdds kommen Börsen als ganz normale Buchmacher herein.

Was das kostet, nachgerechnet:

```
Buchmacher 2.00  gegen  Börse 2.03

  Börse NICHT erkannt:  Gewinn +0.74 %   ← über der Meldeschwelle (0.5 %)
  Börse erkannt:        Gewinn −0.54 %   ← tatsächlich ein Verlust
```

Als „sichere Wette" gemeldet, in Wahrheit ein Minusgeschäft. Dazu zwei
leisere Folgen: die kommissionsfreie Börsenquote wird in der fairen Quote zu
schwach gewichtet (Börsen sind die schärferen Preise), und das
Liquiditätssignal im Fehlpreis-Score fehlt.

`EXCHANGE_BOOKMAKERS` behebt das. Die Vorgabe enthält nur Namen, bei denen es
keine zwei Meinungen gibt:

```
betfairexchange, betfair_ex_eu, betfair_ex_uk, betfair_ex_au,
matchbook, smarkets, prophetexchange
```

**Prognosemärkte wie `polymarket` und `kalshi` stehen bewusst nicht darin.**
Sie rechnen anders ab; ihnen eine Betfair-Kommission zu unterstellen wäre
derselbe Fehler mit umgekehrtem Vorzeichen. Ob sie überhaupt in deinen
fairen Konsens gehören, ist eine eigene Frage — `prizepicks` etwa ist
Daily Fantasy, keine Quote im üblichen Sinn.

> Diese Liste ist ein Vorschlag, keine Behauptung über deinen Tarif. Prüf sie
> gegen das, was du wirklich bekommst: `./scripts/bookmakers.sh`

### Welche Buchmacher liefert meine Quelle überhaupt?

Das beantwortet keine Liste, sondern nur ein Blick in die eigenen Daten:

```bash
./scripts/bookmakers.sh --days 30
./scripts/bookmakers.sh --grep bet
```

```
Buchmacher in deinen Daten (30 Tage)
  Name (für ALERT_BOOKMAKERS)     Preise   Anteil   Alarme
  pinnacle                          4210   22.1 %       12
  bet365                            4188   22.0 %        9
  ...
  ALERT_BOOKMAKERS ist gesetzt: efbet, winbet
  NICHT in den Daten gefunden: efbet
```

Die Spalte **zuletzt** trennt lebende Quellen von Altlasten. Eine Zeile aus
der Datenbank, die seit Wochen nichts mehr liefert, sieht in einer reinen
Zählung genauso lebendig aus wie eine aktive — und wer danach filtert,
filtert auf etwas, das nie wieder einen Alarm auslöst:

```
  draftkings      4192401   25.5 %     2860       gerade
  MockBookA        195325    1.2 %      776  vor 21 Tagen   ← Altlast
```

Die letzte Zeile ist die wichtigste: steht ein Name in der `.env`, den die
Quelle nicht führt (Schreibfehler oder schlicht nicht im Angebot), kommt von
dort **nie** ein Alarm — und ohne diesen Hinweis wartet man ewig darauf.

### Altlasten entfernen — mit Sicherung und Trockenlauf

Steht in der Liste ein Buchmacher, der seit Wochen nichts mehr liefert
(typisch: Reste der längst entfernten Simulation, `MockBookA` & Co.), dann
verfälschen seine Zeilen jede Auswertung — Trefferbilanz, Buchmacherliste und
vor allem die **Modellprüfung**, die dann auf erfundenen Preisen rechnet.

```bash
./scripts/purge-bookmaker.sh 'Mock%'              # Trockenlauf: nur zählen
./scripts/purge-bookmaker.sh 'Mock%' --wirklich   # löschen
```

Drei Sicherungen, weil Löschen nicht rückgängig zu machen ist:

* **Trockenlauf ist die Vorgabe.** Ohne `--wirklich` wird nichts verändert.
* **Vorher läuft `./scripts/backup.sh`.** Scheitert die Sicherung, wird nicht
  gelöscht — das ist keine Warnung, sondern ein Abbruch.
* **Das Wett-Tagebuch wird nie angefasst.** Alles andere kann der Scanner neu
  sammeln; was ein Mensch gespielt hat, kann niemand rekonstruieren. Betreffen
  die Daten auch Wetten, sagt das Skript es und lässt die Zeilen stehen.

Muster wie `%`, die alles treffen würden, werden abgelehnt.

### Datensicherung

```bash
./scripts/backup.sh              # nach ./backups/
./scripts/backup.sh --list       # vorhandene Stände
./scripts/backup.sh --keep 20    # mehr aufheben (Standard 10)
```

Gesichert wird die ganze Datenbank. Am wichtigsten ist das **Wett-Tagebuch**:
Alarme und Quotenverlauf sammelt der Scanner neu, aber was gespielt wurde und
was es gebracht hat, steht nur dort. Eine Sicherung unter 1 KB wird als
kaputt abgelehnt statt stillschweigend abgelegt.

Zurückspielen (überschreibt den aktuellen Stand):

```bash
gunzip -c backups/storm-20260911-0730.sql.gz \
  | docker compose exec -T postgres psql -U storm -d storm
```

> **Was nicht geht.** Buchmacher, die die Datenquelle nicht führt, lassen sich
> nicht ergänzen. Ihre Webseiten abzugreifen ist in diesem Projekt
> ausgeschlossen — siehe *Recht und Grenzen*. Eine Liste von Anbietern
> aufzuschreiben, die es in den Daten gar nicht gibt, wäre genau die Sorte
> erfundener Information, die dieses System überall sonst vermeidet.

### Telegram: was der Standard-Chat bekommt

Zwei Arten von Empfängern, und sie werden verschieden behandelt:

* **Wer den Bot mit `/start` eingerichtet hat** hat eigene Filter (Sportart,
  Markt, Quotenband, Mindestgrad) und wird hiervon nicht berührt.
* **Der Chat aus `TELEGRAM_CHAT_ID`** hat keine — er bekam bisher *jeden*
  Alarm, den der Scanner durchließ.

Auf einem echten Server waren das **166 Alarme in 30 Minuten, von denen das
System selbst keinen einzigen als spielbar einstufte**. Eine Push-Nachricht
für etwas zu schicken, das man gleichzeitig „nicht spielen" nennt, ist ein
Widerspruch. `TELEGRAM_MIN_GRADE` (Standard `weak`) wirft diese raus:

| Einstellung | aus 166 Alarmen je 30 Min |
|---|---|
| `any` (altes Verhalten) | 166 |
| `weak` (Standard) | 10 |
| `moderate` | 4 |
| `strong` | 1 |

Alarme **ohne** Bewertung kommen weiterhin durch — fehlende Information ist
kein schlechtes Urteil. Bewegungsmeldungen hängen unverändert an
`TELEGRAM_SEND_MOVES`.

### Wenn nie etwas spielbar ist: das Band zwischen den Stufen

Es gibt **zwei** Schwellensätze, und sie tun Verschiedenes:

* der **Alarmfilter** (`MIN_*`) entscheidet, was überhaupt gemeldet wird —
  „sieh dir das an"
* die **Empfehlung** (`RECOMMEND_*`) entscheidet, was davon spielbar ist —
  „das würde ich setzen"

Dass die zweite Stufe strenger ist, ist Absicht. Gefährlich ist nicht das
Band, sondern seine **Breite**. Ein echter Fall von diesem Server:

```
MAX_ODDS_AGE_SECONDS   = 60     (in der .env gelockert)
RECOMMEND_MAX_ODDS_AGE = 15     (Standard, unverändert)
```

Ergebnis: **166 Alarme in 30 Minuten, null Empfehlungen** — 80 davon allein
wegen „Quote zu alt". Alles zwischen 15 und 60 Sekunden wurde gemeldet und
konnte nie gespielt werden. Ohne eine einzige Fehlermeldung.

Seitdem beziffert `/health` diese Bänder (`threshold_bands`), und die
Tipp-Karte nennt bei leerem Ergebnis den **Regler zum häufigsten Grund**:

```
WARUM NICHTS ÜBRIG BLIEB
  Quote zu alt - Preis womöglich nicht mehr da        12

  Der häufigste Grund lässt sich einstellen:
  RECOMMEND_MAX_ODDS_AGE in der .env.
  Lockerer heißt mehr Vorschläge und schwächere.
```

Die Liste urteilt nicht, sie beziffert. Ob ein Band zu breit ist,
beantworten die Verwerfungsgründe — die zählen, was tatsächlich hängenbleibt.

**Und bei „Quote zu alt" reicht der Reglername nicht.** Die eigentliche Frage
ist dann: ist die *Schwelle* zu streng, oder der *Abruf* zu langsam? Deshalb
misst die Antwort das Quotenalter gleich mit (`odds_age_median`,
`odds_age_p90`) und die Karte schreibt es hin:

> Gemessen sind deine Quoten im Median **35 s** alt (9 von 10 unter 35 s) —
> liegt das weit über der Grenze, ist nicht die Schwelle das Problem, sondern
> der Abruf.

Eine Schwelle hochzudrehen, weil der Abruf hinterherhinkt, verschiebt nur das
Symptom: du bekommst Vorschläge zu Preisen, die es nicht mehr gibt.

**Vor dem Anpfiff gilt eine eigene Grenze** (`PREMATCH_RECOMMEND_MAX_ODDS_AGE`,
Standard 300 s). Mit der Live-Grenze von 15 Sekunden käme dort nie etwas
durch — der Prematch-Abruf läuft im Minutentakt, jede Quote ist also älter.

### Die Tipp-Karte — und was an den Vorbildern nicht stimmt

Ganz oben im Empfehlungsbereich steht der beste Fund als große Karte: Liga,
Teams, Quote, Auswahl, Buchmacher, Einsatz. Die Form ist von den
Tipp-Apps geborgt, weil sie auf dem Handy schlicht funktioniert.

Der Unterschied steckt im Balken. Solche Apps zeigen dort ein „Confidence
Rating" — eine Prozentzahl ohne Bezugsgröße. Die sagt nichts: 67 % sind bei
Quote 1.15 ein sicherer Verlust und bei Quote 5.50 der größte Vorteil der
Wettgeschichte. Ohne die Quote daneben ist die Zahl Dekoration.

Hier zeigt derselbe Balken **drei** Dinge:

```
Geschätzte Trefferquote                    45,0 %
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▌███
37 %                                        51 %
Nötig bei Quote 2.30: 43,5 % — Vorsprung +1,5 Punkte
```

* der **graue Sockel**: was diese Quote verlangt (43,5 %) — kein Verdienst,
  sondern die Hürde
* die **Marke**: genau dort liegt die Hürde
* das **farbige Stück**: der Vorsprung — und das ist der ganze Vorteil

Dass dieses Stück schmal aussieht, ist keine Schwäche der Darstellung. So
schmal *ist* ein echter Vorteil. Ein Balken, der zu zwei Dritteln gefüllt
ist, behauptet etwas, das es beim Wetten nicht gibt.

Die Skala ist gezoomt (hier 37–51 %), sonst lägen beide Werte auf demselben
Pixel — beide Enden stehen deshalb als Zahl darunter. Und die Begründung
darunter ist **nicht verwischt**: glaubwürdiger Vorteil, gemeldeter Wert,
Zahl der Vergleichsquoten, Confidence, dazu jede Warnung.

### Warum hier Median statt Mittelwert steht

Der erste Lauf gegen echte Daten meldete für die **verworfenen** Alarme einen
mittleren CLV von **+92 %** und für die nach Value sortierte Auswahl **+768 %**.
Das sieht nach einer vernichtenden Widerlegung des Modells aus. Es ist keine.

Ein CLV von +768 % hieße, der Preis war fast neunmal besser als der
Marktkonsens. So etwas gibt es nicht. CLV ist

```
CLV = Alarmquote / spätere faire Quote − 1
```

Bricht der **Nenner** zusammen, explodiert der Bruch. Solche Zeilen messen
keinen Vorteil, sondern eine kaputte Referenz — und ein Mittelwert über 300
Zeilen kippt von einer Handvoll davon. Der Median tut das nicht; dieselbe
Überlegung, aus der schon die faire Quote als Median gebildet wird. Die
Ausreißer werden deshalb **nicht weggeworfen**, sondern gezählt und in der
Spalte `kaputt` ausgewiesen: ihre Zahl ist selbst ein Befund.

### Warum der CLV die Streitfrage nicht allein entscheiden kann

```
gemeldeter Value = Alarmquote / faire Quote         − 1
CLV              = Alarmquote / spätere faire Quote − 1
```

Zweimal dieselbe Formel, nur eine spätere Referenz. Wer nach dem gemeldeten
Value sortiert und mit dem CLV benotet, lässt eine Größe **über sich selbst**
urteilen. Diese Auswahl gewinnt fast zwangsläufig — besonders dann, wenn die
faire Quote kaputt war, denn derselbe Fehler steckt in beiden Zahlen.

Deshalb steht daneben ein zweiter Schiedsrichter: **hat der Buchmacher seinen
Preis am Ende selbst zurückgezogen?** Das ist keine Umskalierung derselben
Größe, sondern eine unabhängige Beobachtung (`verdict.py`) — und damit die
belastbarere Antwort auf „war der Fehlpreis echt?". Im Beispiel oben: 61 %
bei „Spielen" gegen 9 % bei „Nicht spielen". Genau das ist die Spalte, auf
die es ankommt.

Besteht die Value-Auswahl überwiegend aus kaputten Referenzen, fällt die
Auswertung **gar kein** Urteil, sondern sagt „nicht auswertbar". Ein Vergleich
zweier Zahlenhaufen, von denen einer Unsinn ist, ist kein Ergebnis.

**Die Prüfung kann auch nein sagen** — und das ist ihr Sinn. Fällt sie
andersherum aus, steht dort „Der Grad sortiert nichts" und der Hinweis auf
`PLAUSIBLE_EDGE_PERCENT`. Ein Test, der nur bestätigen kann, prüft nichts.
Bei zu wenigen ausgewerteten Alarmen (unter 20 je Gruppe) sagt sie
ausdrücklich „noch keine Aussage", statt eine Zahl hinzustellen.

Das Skript liest nur — es schreibt nichts und ruft nichts beim Anbieter ab.
Alarme aus der Zeit vor dem Empfehlungsmodul werden mit den *heutigen*
Einstellungen nachgerechnet; genau darum geht es ja: wie hätte das Modell
entschieden?

> Und noch einmal, weil es hier besonders leicht zu überlesen ist: **CLV ist
> kein Gewinn.** Ein Modell kann jeden Vergleich in dieser Auswertung
> gewinnen und trotzdem kein Geld verdienen. Was Geld gebracht hat, steht im
> Wett-Tagebuch (Schritt 13) — und nur dort.

---

## 16. API

Swagger UI: <http://localhost:8080/docs> · OpenAPI: `/openapi.json`

> Swagger UI lädt sein JavaScript von `cdn.jsdelivr.net`. Auf einem Server
> **ohne ausgehenden Internetzugang** bleibt die Seite deshalb leer —
> `/openapi.json` liefert das Schema davon unabhängig und lässt sich mit jedem
> lokalen OpenAPI-Viewer öffnen. Für genau diese drei Pfade lockert nginx die
> Content-Security-Policy; das Dashboard behält die strenge Policy.

| Endpunkt | Zweck |
|---|---|
| `GET /health` | Gesamtstatus inkl. Redis und Datenbank |
| `GET /health/providers` | Status jeder Datenquelle, fehlende Zugangsdaten |
| `GET /providers` | Katalog aller Adapter |
| `GET /events` | beobachtete Events (`?sport=`, `?limit=`, `?offset=`) |
| `GET /events/live` | nur laufende Events — ohne die, deren Daten veraltet sind |
| `GET /events/{id}` | einzelnes Event |
| `GET /odds?event_id=` | aktuelle Quoten aus Redis |
| `GET /odds/history` | Preisverlauf einer Quotenzeile (`?event_id=`, `?market=`, `?selection=`, `?bookmaker=`, `?minutes=`) |
| `GET /alerts` | Alarm-Historie (`?kind=`, `?sport=`, `?min_value=`, `?since_minutes=`, `?grade=`), je Alarm mit `recommendation`, `verdict` und `clv_percent` |
| `GET /alerts/scorecard` | Trefferbilanz: was aus den Alarmen wurde (`?window_hours=`) |
| `GET /alerts/recommendations` | Was man jetzt spielen würde (`?window_minutes=`, `?limit=`, `?sport=`) — entdoppelt, mit Einsatz und Gesamtbudget |
| `GET /arbitrage` | Sichere Wetten (`?include_suspicious=`) |
| `GET /bets` | Gespielte Wetten (`?status=`, `?since_hours=`) |
| `GET /bets/ledger` | Bilanz: Gewinn/Verlust, Trefferquote, erwartet vs. eingetreten |
| `POST /bets` · `POST /bets/{id}/settle` · `DELETE /bets/{id}` | Eintragen, abrechnen, löschen — **nur mit `BETLOG_API_WRITES=true`** |
| `GET /stats` | Kennzahlen |
| `GET /metrics` | Prometheus |
| `WS /ws` | Live-Stream (Alarme, Events, Bewegungen) |

Beispiel:

```bash
curl -s http://localhost:8080/api/alerts?limit=5 | jq
curl -s http://localhost:8080/api/events/live | jq '.[].home'
curl -s 'http://localhost:8080/api/alerts/recommendations' | jq '.picks[].recommendation.play'
```

---

## 17. Tests

```bash
docker compose run --rm --user root --entrypoint "" api sh -c \
  "pip install -q -r /app/requirements-dev.txt && cd /app && pytest"
```

`--user root` ist nötig, weil das Image sonst als unprivilegierter Benutzer
läuft und nicht ins virtuelle Environment schreiben darf.

Oder lokal (siehe [Abschnitt 18](#18-entwicklung-ohne-docker)):

```bash
pytest
```

Die Tests brauchen **keine** laufende Infrastruktur: Redis wird durch
`fakeredis` ersetzt, PostgreSQL durch SQLite mit demselben ORM-Schema.

Abgedeckt sind unter anderem:

| Bereich | Datei |
|---|---|
| Normalisierung, Event-Matching, Spiegelung | `test_normalization.py` |
| Faire Quoten, Margin-Modelle, Confidence | `test_value_engine.py` |
| Fixed-Odds-Error-Detector | `test_outlier.py` |
| Stale, Cooldown, Duplikate, Schwellen | `test_filters.py` |
| Supervisor/Reconnect, Registry, Parser der echten Quellen | `test_providers.py` |
| SportsGameOdds: Schema, Quotenformat, Pagination | `test_sportsgameodds.py` |
| Scanner-Pipeline, Vorreiter/Nachzügler | `test_scanner.py` |
| Redis-Zustand und Pub/Sub | `test_redis_state.py` |
| Repository und Migrationsschema | `test_database.py` |
| HTTP-API, CORS, Rate-Limit | `test_api.py` |
| Telegram-Formatierung und Empfängerfilter | `test_telegram.py` |
| Urteil und Closing Line Value | `test_verdict.py` |
| Nachkontrolle vom Alarm bis zur Bilanz | `test_followup.py` |
| Empfehlung: Grad, Kelly-Einsatz, Entdopplung | `test_recommendation.py` |
| Wett-Tagebuch: Abrechnung und Bilanz | `test_betlog.py` |
| Sichere Wetten: Erkennung und Einsatzverteilung | `test_arbitrage.py` |
| Modellprüfung gegen echte Alarme | `test_backtest.py` |
| Secret-Redaction im Logging | `test_logging.py` |

Linting:

```bash
ruff check backend && ruff format --check backend
```

---

## 18. Entwicklung ohne Docker

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

export PYTHONPATH=.
export DATABASE_URL="postgresql+asyncpg://storm:passwort@localhost:5432/storm"
export REDIS_URL="redis://localhost:6379/0"
export LOG_JSON=false

alembic upgrade head
python -m backend.scanner     # Terminal 1
python -m backend.api         # Terminal 2
python -m backend.telegram    # Terminal 3
```

Hilfsskript:

```bash
scripts/dev.sh scanner|api|telegram|migrate|test|lint
```

Das Dashboard kann statisch ausgeliefert werden; im Entwicklungsbetrieb lassen
sich API- und WebSocket-Adresse über zwei globale Variablen umbiegen:

```html
<script>
  window.STORM_API_BASE = "http://localhost:8000";
  window.STORM_WS_URL   = "ws://localhost:8000/ws";
</script>
```

---

## 19. Fehlerbehebung

### `POSTGRES_PASSWORD muss in .env gesetzt sein`

Das ist Absicht — es gibt kein Standardpasswort.

```bash
openssl rand -base64 24
nano .env
```

### `migrate` endet mit Fehler

```bash
docker compose logs migrate
docker compose up -d postgres
docker compose run --rm migrate
```

Meist ist PostgreSQL noch nicht bereit; der Job kann gefahrlos wiederholt
werden (Migrationen sind idempotent).

### Keine Alarme

Der Reihe nach prüfen:

```bash
docker compose logs scanner | tail -50          # läuft der Scan?
curl -s localhost:8080/api/health/providers | jq  # ist eine Quelle verbunden?
curl -s localhost:8080/api/events/live | jq length  # gibt es Live-Events?
```

Häufige Ursachen:

1. **Zu strenge Schwellen** — `MIN_VALUE_PERCENT` und `MIN_CONFIDENCE` senken
2. **Zu wenige Buchmacher** — eine einzelne Quelle liefert oft nur wenige
   Bücher je Markt; `MIN_BOOKMAKERS` senken oder zweite Quelle ergänzen
3. **Quoten zu alt** — bei langsamem Polling `MAX_ODDS_AGE_SECONDS` erhöhen
4. **Keine passenden Events** — außerhalb der Saison kann es schlicht nichts
   zu scannen geben; `./scripts/setup-provider.sh sportsgameodds --key … --live`
   zeigt, wie viele Events die Quelle gerade überhaupt hergibt

### Trefferbilanz bleibt leer

```bash
curl -s localhost:8080/api/alerts/scorecard | jq '{resolved, pending, scored}'
docker compose logs scanner | grep -i nachkontrolle | tail
```

| Beobachtung | Ursache |
|---|---|
| `resolved` bleibt 0, `pending` wächst | Die Wartezeit ist noch nicht um — `FOLLOWUP_AFTER_SECONDS` abwarten. |
| Alle Urteile lauten „offen" | `FOLLOWUP_AFTER_SECONDS` liegt über `ODDS_STATE_TTL_SECONDS`; der Vergleichsmarkt ist beim Auswerten schon weg. Der Scanner warnt beim Start. |
| Viele Urteile „überholt" | Zwischen Alarm und Nachkontrolle fielen Tore. Normal im Live-Betrieb — Wartezeit verkürzen. |
| `scored` bleibt klein | Nur Value- und Fixed-Error-Alarme bekommen einen CLV; Bewegungsalarme haben keine faire Quote. |
| Log: `urteile ohne zugehörigen alarm verworfen` | Der DB-Writer kommt nicht hinterher. `DB_WRITER_BATCH` erhöhen oder `SNAPSHOT_PERSIST_EVERY` reduzieren. |
| `FOLLOWUP_ENABLED=false` | Die Nachkontrolle ist abgeschaltet. |

### Trefferbilanz bleibt leer

```bash
curl -s localhost:8080/api/alerts/scorecard | jq '{resolved, pending, scored}'
docker compose logs scanner | grep -i nachkontrolle | tail
```

| Beobachtung | Ursache |
|---|---|
| `resolved` bleibt 0, `pending` wächst | Die Wartezeit ist noch nicht um — `FOLLOWUP_AFTER_SECONDS` abwarten. |
| Alle Urteile lauten „offen" | `FOLLOWUP_AFTER_SECONDS` liegt über `ODDS_STATE_TTL_SECONDS`; der Vergleichsmarkt ist beim Auswerten schon weg. Der Scanner warnt beim Start. |
| Viele Urteile „überholt" | Zwischen Alarm und Nachkontrolle fielen Tore. Normal im Live-Betrieb — Wartezeit verkürzen. |
| `scored` bleibt klein | Nur Value- und Fixed-Error-Alarme bekommen einen CLV; Bewegungsalarme haben keine faire Quote. |
| Log: `urteile ohne zugehörigen alarm verworfen` | Der DB-Writer kommt nicht hinterher. `DB_WRITER_BATCH` erhöhen oder `SNAPSHOT_PERSIST_EVERY` reduzieren. |
| `FOLLOWUP_ENABLED=false` | Die Nachkontrolle ist abgeschaltet. |

### `invalid choice: 'sportsgameodds'` bei der Einrichtungshilfe

```
setup_provider.py: error: argument provider: invalid choice: 'sportsgameodds'
```

Dasselbe Muster wie beim Dashboard: der Host hat den neuen Code, der Container
das alte Image. Seit dieser Version reicht `setup-provider.sh` `backend/` und
`scripts/` vom Host in den Container hinein — der Fehler kann so nicht mehr
auftreten, ein `git pull` genügt:

```bash
git pull
./scripts/setup-provider.sh sportsgameodds --key DEIN_KEY --live
```

Für die **laufenden Dienste** (Scanner, API) bleibt `--build` nötig:

```bash
docker compose up -d --build
```

### 502 auf allen `/api`-Pfaden, obwohl die API läuft

Das Symptom: `docker compose ps` zeigt `api` als `healthy`, im Container
antwortet `/health` mit 200 — aber das Dashboard bekommt auf **jeden**
`/api`-Pfad ein 502, und im nginx-Log steht:

```
connect() failed (111: Connection refused) while connecting to upstream,
upstream: "http://172.20.0.6:8000/health"
```

Die Ursache ist die IP in dieser Meldung. nginx (OSS) löst Namen aus einem
`upstream`-Block **genau einmal beim Start** auf und behält die IP für seine
ganze Laufzeit. Bei jedem `docker compose up -d --build` bekommt der
`api`-Container eine neue IP — nginx läuft aber weiter gegen die alte. Ein
Blick auf `docker compose ps` verrät es: der `frontend`-Container ist Stunden
älter als `api`.

Sofort behoben mit:

```bash
docker compose restart frontend
```

Ab dieser Version kann es nicht mehr auftreten: der Name steht in einer
Variablen, und nginx löst ihn bei jeder Anfrage über den Docker-DNS neu auf.
Der Preis ist die weggefallene Keepalive-Verbindung zum Upstream — im
Docker-Netz vernachlässigbar.

### Doppelte Schlüssel in der `.env`

Steht ein Schlüssel mehrfach drin, gilt der **letzte**. Wer den ersten ändert,
wundert sich, dass nichts passiert. `./scripts/diagnose.sh` meldet solche
Dubletten inzwischen von selbst.

### „This site can't be reached" / ERR_CONNECTION_REFUSED

Die Seite lädt **gar nicht**, der Browser bekommt schon keine Verbindung. Das
ist etwas anderes als eine leere Seite (siehe nächster Abschnitt): dort
antwortet jemand und hat nichts zu sagen — hier antwortet niemand.

Die Dienste hängen in einer Kette, und jedes Glied startet erst, wenn das
davor gesund ist:

```
postgres ──> migrate ──> api ──> frontend (Port 8080)
redis    ──────────────┘
```

Reißt die Kette irgendwo, ist am Ende Port 8080 tot — und der Browser meldet
„refused", völlig unabhängig davon, *wo* es wirklich klemmt. Eine
fehlgeschlagene Datenbank-Migration sieht im Browser exakt so aus wie ein
abgestürzter nginx. Deshalb hilft die Container-Liste allein selten weiter.

`./scripts/diagnose.sh` beginnt darum mit einem **Befund**, der das erste
kaputte Glied nennt — nicht das letzte:

```
== BEFUND ==
  Speicherplatz .             29309 MB frei
  Arbeitsspeicher              1544 MB frei

  postgres       läuft, gesund
  redis          läuft, gesund
  migrate        ABGEBROCHEN (Code 1)
  api            existiert nicht
  frontend       existiert nicht

  Die Datenbank-Migration ist nicht durchgelaufen. Ohne sie
  startet die API nicht, und ohne API kein Dashboard.

  Nächster Schritt:
    docker compose logs migrate | tail -40
```

Der Befund steht **ganz oben** und passt auf einen Bildschirm; der Rest des
Berichts ist Belegmaterial darunter. Vier Dinge, die er nebenbei erledigt:

* **Speicherplatz und Arbeitsspeicher zuerst.** Eine volle Platte sieht aus
  wie zehn verschiedene Fehler und ist doch nur einer. `Code 137` bei einem
  Dienst heißt: vom Kernel abgeschossen, fast immer Speichermangel.
* **Scanner und Telegram-Bot werden nicht mitbeschuldigt.** Sie hängen nicht
  am Dashboard. Verschwiegen werden sie trotzdem nicht — ein stiller Scanner
  heißt „keine Alarme mehr" und ist der Fehler, den man am längsten nicht
  bemerkt.
* **Läuft alles und antwortet Port 8080 auf dem Server selbst**, dann sitzt
  das Problem zwischen Server und Browser: Firewall (`ufw status`) oder
  Portfreigabe beim Anbieter.
* **Ohne Docker-Daemon** steht genau das da, statt sieben Folgefehlern.

Drei Ursachen, die der Befund seit diesem Ausfall ausdrücklich kennt, weil
sie im Browser alle gleich aussehen:

**1. Die Container finden einander nicht beim Namen.** Steht auf dem Host
`systemd-resolved`, kann `nameserver 127.0.0.53` in den Container
durchschlagen — eine Adresse, die es im Netz-Namensraum des Containers nicht
gibt. Dann erreicht die API die Datenbank nicht, der Scanner den Anbieter
nicht, nginx die API nicht: sieben Symptome, eine Ursache. Der Befund prüft
das zuerst und meldet es *statt* der Folgefehler.

```bash
docker compose down          # kein -v: die Daten bleiben
systemctl restart docker
docker compose up -d
```

**2. Der Dashboard-Container läuft, veröffentlicht aber keinen Port.** Wird
der Docker-Dienst neu gestartet, während der Container läuft, überlebt der
Container — seine Portabbildung nicht. In `docker compose ps` sieht er
kerngesund aus, die Spalte `PORTS` ist nur leer, und von aussen ist er
unerreichbar.

```bash
docker compose up -d --force-recreate frontend
```

**3. Zwei Arbeitskopien auf einer Maschine.** Der Projektname steht in der
compose-Datei fest. Liegt das Projekt zweimal auf dem Server, steuern **beide
Verzeichnisse denselben Stack** — wer im falschen `docker compose up -d`
tippt, startet stillschweigend fremden Code mit fremder `.env`, und im
richtigen Verzeichnis sieht alles korrekt aus. Der Bericht vergleicht deshalb
das Verzeichnis, aus dem die Container erzeugt wurden, mit dem aktuellen und
warnt bei Abweichung.

Der schnellste Versuch, wenn gar kein Container existiert:

```bash
docker compose up -d
```

### Alles leer, roter Punkt, „Verbinde…"

Das Dashboard lädt, aber **keine einzige** Kachel füllt sich und oben steht
ein roter Punkt? Dann antwortet die API gar nicht — meist läuft ihr Container
nicht. Seit dieser Version sagt das Dashboard das auch selbst statt stumm auf
„Lade…" zu stehen.

Zustand einsammeln:

```bash
./scripts/diagnose.sh              # auf den Bildschirm
./scripts/diagnose.sh > bericht.txt   # zum Verschicken
```

Der Bericht zeigt Containerzustände, die letzten Fehler aus jedem Log, ob
nginx die API erreicht und welche Einstellungen aktiv sind. **Passwörter,
Schlüssel und Tokens erscheinen nicht** — von ihnen steht nur die Länge da,
der Bericht kann also unbesehen verschickt werden.

Der häufigste Auslöser ist ein fehlgeschlagener Neubau:

```bash
docker compose up -d --build
docker compose ps          # laufen alle Dienste?
docker compose logs api --tail 50
```

### Dashboard bleibt auf „Lade…" nach einem Update

Kacheln leer, aber oben steht „Live verbunden"? Dann läuft eine **API, die
älter ist als das Dashboard**. Die Dashboard-Dateien liegen als Bind-Mount vor
und sind nach `git pull` sofort neu; die API steckt im gebauten Image, und
`docker compose up -d` **ohne `--build`** lässt das alte Image weiterlaufen.
Sie kennt dann einen neuen Endpunkt noch nicht und antwortet mit 404.

```bash
docker compose up -d --build
```

Nach einem `git pull` ist `--build` die Regel, nicht die Ausnahme. Das
Dashboard weist seit dieser Version selbst darauf hin (rotes Banner mit dem
fehlenden Endpunkt) und füllt alle übrigen Kacheln trotzdem.

### Zugangsschutz wieder abschalten

```bash
./scripts/set-dashboard-password.sh --off
docker compose up -d
```

Danach ist das Dashboard wieder für jeden erreichbar, der die Adresse kennt.

### `The "apr1" variable is not set` beim Start

```
WARN[0000] The "apr1" variable is not set. Defaulting to a blank string.
WARN[0000] The "frYtsx1F" variable is not set. Defaulting to a blank string.
```

In der `.env` steht ein Hash mit einfachen `$`. Docker Compose hält die für
Variablennamen und ersetzt sie durch nichts — vom Passwort-Hash bleibt
`admin:` übrig, und **jede korrekte Anmeldung wird mit 401 abgewiesen.**

Reparatur:

```bash
./scripts/set-dashboard-password.sh
docker compose up -d
```

Das Skript schreibt die `$` verdoppelt und prüft anschließend nach. Ab dieser
Version verweigert der nginx-Container den Start, wenn ihn ein kaputter Wert
erreicht — statt ein Dashboard auszuliefern, an dem sich niemand anmelden kann.

### Telegram-Bot antwortet nicht

```bash
docker compose logs telegram-bot | tail -30
```

- `TELEGRAM_BOT_TOKEN fehlt` → Token nachtragen, `docker compose up -d`
- Der Bot muss einmal `/start` bekommen haben
- In Gruppen: Bot muss Mitglied sein, die Chat-ID ist negativ
- Der Bot ist absichtlich nur ein Empfänger — er verschickt nichts an Chats,
  die ihn nicht kennen

### Dashboard bleibt leer

```bash
docker compose ps                       # sind api und frontend healthy?
curl -s localhost:8080/api/health | jq
docker compose logs frontend | tail -20
```

Zeigt der Verbindungspunkt oben rechts „Getrennt", läuft die API nicht oder
Redis ist nicht erreichbar. Das Dashboard versucht mit exponentiellem Backoff
selbstständig weiter.

### `Kontingent fast aufgebraucht`

Der The-Odds-API-Adapter hat das Restkontingent erkannt und pausiert für eine
Stunde. `ODDS_API_POLL_INTERVAL` erhöhen oder weniger Märkte/Regionen abfragen.

### Datenbank wächst zu stark

Der Scanner räumt alle 6 Stunden selbst auf. Aggressiver einstellen:

```env
RETENTION_SNAPSHOT_DAYS=3
SNAPSHOT_PERSIST_EVERY=5     # nur jede 5. Charge speichern
```

Belegung prüfen:

```bash
docker compose exec postgres psql -U storm -d storm -c "\
  select relname, pg_size_pretty(pg_total_relation_size(relid)) \
  from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc;"
```

### Alles zurücksetzen

```bash
docker compose down -v      # ACHTUNG: löscht Datenbank und Redis
docker compose up -d --build
```

---

## 20. Updates

```bash
cd storm-odds-sniper
git pull
docker compose up -d --build
```

**`--build` ist Pflicht, nicht optional.** Das Dashboard liegt als Bind-Mount
im Container und ist nach `git pull` sofort neu; die API steckt im gebauten
Image. Ohne `--build` laufen beide in verschiedenen Ständen — das Dashboard
fragt dann Endpunkte ab, die die alte API noch nicht kennt.

Migrationen laufen beim Start automatisch. Vorher sichern:

```bash
docker compose exec postgres pg_dump -U storm storm | gzip > backup-$(date +%F).sql.gz
```

Zurückspielen:

```bash
gunzip -c backup-2026-09-07.sql.gz | docker compose exec -T postgres psql -U storm -d storm
```

---

## 21. Sicherheit

| Maßnahme | Umsetzung |
|---|---|
| Secrets | ausschließlich über `.env`, nie im Git (`.gitignore`) |
| Logs | Tokens, API-Keys, Passwörter werden automatisch entfernt |
| Container | eigener Benutzer `storm` (UID 10001), kein Root |
| Datenbank/Redis | **keine** Ports auf dem Host — nur im Compose-Netz |
| API | nur auf `127.0.0.1` veröffentlicht |
| CORS | ausschließlich die konfigurierten Origins, keine Wildcard |
| Rate-Limiting | pro IP und Minute, Health-Endpunkte ausgenommen |
| Eingaben | Pydantic-Validierung an jedem Endpunkt |
| CSP | streng, keine externen Skripte oder Schriften |
| Dashboard | optionaler Zugangsschutz über `DASHBOARD_AUTH` |
| Telegram-Token | nur im Backend, niemals im Frontend |
| Wettabgabe | technisch nicht vorhanden |

### Dashboard aus dem Internet erreichbar?

Dann **unbedingt** ein Passwort setzen — sonst sieht jeder mit der Adresse
alle Alarme, Events und Systemdaten:

```bash
./scripts/set-dashboard-password.sh          # setzen
./scripts/set-dashboard-password.sh --off    # wieder abschalten
docker compose up -d
```

Das Skript fragt Benutzername und Passwort ab, erzeugt daraus einen Hash
(`apr1`, gesalzen) und trägt ihn als `DASHBOARD_AUTH` in die `.env` ein. Das
Klartextpasswort wird nirgends gespeichert. Ab dann sind Dashboard, API,
WebSocket und `/docs` geschützt; nur `/healthz` bleibt offen, weil der
Container-Healthcheck kein Passwort kennt.

Ohne `DASHBOARD_AUTH` bleibt alles offen — das ist der Auslieferungszustand
und ändert sich bei einem Update nicht von selbst.

**Wer die Zeile von Hand einträgt, muss jedes `$` verdoppeln.** Docker Compose
liest `$NAME` in der `.env` als Variable, und ein `apr1`-Hash besteht fast nur
aus solchen Stellen:

```env
# falsch - davon bleibt beim Start nur "admin:" übrig
DASHBOARD_AUTH=admin:$apr1$frYtsx1F$gU557er1Q0RlYieQT4Y461

# richtig
DASHBOARD_AUTH=admin:$$apr1$$frYtsx1F$$gU557er1Q0RlYieQT4Y461
```

Das Skript erledigt das selbst und prüft danach mit `docker compose config`
nach, ob der Hash den Weg unbeschadet überstanden hat. Kommt trotzdem ein
unbrauchbarer Wert im Container an, **startet nginx nicht** und schreibt in
den Log, was zu tun ist — ein Dashboard, das sich für geschützt hält und es
nicht ist, wäre der schlechtere Ausgang.

Zusätzlich für den Internetbetrieb: einen TLS-Reverse-Proxy davorsetzen
(Basic Auth ohne HTTPS überträgt das Passwort im Klartext) und
`API_CORS_ORIGINS` auf die echte Domain setzen.

---

## 22. Projektstruktur

```
storm-odds-sniper/
├── backend/
│   ├── api/                  FastAPI
│   │   ├── app.py            Anwendung, Lifespan, WebSocket
│   │   ├── deps.py           Abhängigkeiten
│   │   ├── middleware.py     Request-ID, Rate-Limit, Security-Header
│   │   ├── ws.py             WebSocket-Verteiler
│   │   └── routes/           health, events, odds, alerts, stats
│   ├── core/
│   │   ├── config.py         Settings (Pydantic)
│   │   ├── logging.py        structlog + Secret-Redaction
│   │   ├── normalization.py  Teams, Spieler, Event-Matching
│   │   ├── value_engine.py   Modelle A/B/C, Confidence
│   │   ├── outlier.py        Fixed-Odds-Error-Detector
│   │   ├── filters.py        False-Positive-Schutz
│   │   ├── verdict.py        Nachkontrolle: Urteil und Closing Line Value
│   │   ├── recommendation.py Empfehlung: Grad, Kelly-Einsatz, Bestenliste
│   │   ├── betlog.py         Wett-Tagebuch: Abrechnung und Bilanz
│   │   ├── arbitrage.py      Sichere Wetten: Widersprüche zwischen Büchern
│   │   ├── backtest.py       Modellprüfung: trennt der Grad, hilft die Schrumpfung?
│   │   ├── backoff.py        exponentielles Backoff
│   │   └── metrics.py        Prometheus
│   ├── models/
│   │   ├── domain.py         Dataclasses des Hot-Paths
│   │   ├── enums.py          Sportarten, Märkte, Selektionen
│   │   └── schemas.py        Pydantic-Schemata der API
│   ├── database/
│   │   ├── base.py           Engine und Session
│   │   ├── tables.py         SQLAlchemy-Modelle
│   │   ├── repository.py     Datenzugriff
│   │   └── migrations/       Alembic
│   ├── providers/
│   │   ├── base.py           OddsProvider-Schnittstelle
│   │   ├── the_odds_api.py   The Odds API (REST)
│   ├── sportsgameodds.py SportsGameOdds (REST, Live-Filter)
│   │   ├── betfair_exchange.py  Betfair (JSON-RPC)
│   │   └── registry.py       Auswahl und Zugangsdatenprüfung
│   ├── scanner/
│   │   ├── engine.py         Analyse-Pipeline
│   │   ├── supervisor.py     Reconnect und Backoff
│   │   └── __main__.py       Worker
│   ├── services/
│   │   └── redis_state.py    Zustand, Cooldowns, Pub/Sub
│   ├── telegram/
│   │   ├── bot.py            Worker und Alarmversand
│   │   ├── handlers.py       Befehle und Buttons
│   │   ├── keyboards.py      Inline-Menüs
│   │   └── formatting.py     Nachrichtenaufbereitung
│   └── tests/                pytest
├── frontend/src/             Dashboard (HTML, CSS, JS)
├── docker/nginx/             nginx-Konfiguration
├── scripts/
│   ├── diagnose.sh           Befund + Zustand einsammeln (ohne Geheimnisse)
│   ├── set-dashboard-password.sh  Zugangsschutz fürs Dashboard
│   ├── setup-provider.sh     echte Datenquelle prüfen und übernehmen
│   ├── setup_provider.py     die eigentliche Prüflogik
│   ├── smoke_test.py         Rauchtest der laufenden Installation
│   ├── healthcheck_*.py      Container-Healthchecks
│   └── dev.sh                lokale Entwicklung
├── docs/                     Architektur, Provider, Entscheidungen
├── docker-compose.yml
├── Dockerfile
├── alembic.ini
├── requirements.txt
├── requirements-dev.txt
├── pyproject.toml
└── .env.example
```

**Datenbanktabellen:** `events`, `markets`, `selections`, `bookmakers`,
`odds_snapshots`, `odds_changes`, `alerts`, `users`, `user_settings`,
`provider_health`.

Die Zeitreihen (`odds_snapshots`, `odds_changes`) sind über
`(selection_id, ts)` indiziert; zusätzlich legt die Migration auf PostgreSQL
BRIN-Indizes über `ts` an — bei monoton wachsenden Zeitstempeln kosten die nur
einen Bruchteil eines B-Trees.

---

## 23. Bekannte Einschränkungen

**Datenquellen**

- Es gibt derzeit **keine frei zugängliche WebSocket-Quelle** für
  Buchmacherquoten zum Nulltarif. Die Architektur ist auf Push ausgelegt, die
  drei Adapter arbeiten aber mit asynchronem HTTP-Polling. Ein Push-Adapter
  braucht nur `stream()` zu überschreiben.
- Die Betfair Stream API (TLS-Socket, nicht WebSocket) ist bewusst **nicht**
  implementiert: sie ist ohne Konto nicht testbar, und ungetesteter Code für
  Delta-Merging wäre in einem Low-Latency-Pfad ein Risiko. Der JSON-RPC-Adapter
  deckt dieselben Daten ab, mit etwas höherer Latenz.
- Das kostenlose Kontingent von The Odds API reicht **nicht** für Live-Scans
  (siehe [Abschnitt 9](#9-datenquellen-konfigurieren)).
- **Spielminute, Karten und Tennis-Punktdetails liefert keine der beiden echten
  Quellen.** Diese Felder bleiben leer statt geschätzt zu werden.

**Erkennung**

- Faire Quoten sind nur so gut wie der Markt dahinter. Mit weniger als drei
  bis vier unabhängigen Buchmachern je Markt ist die Confidence entsprechend
  niedrig — das ist gewollt, nicht ein Defekt.
- Die Vorreiter-Unterdrückung ist eine Heuristik. Ein *echter* Tippfehler, der
  zufällig mit einer Marktbewegung zusammenfällt, kann dadurch verloren gehen.
  Die Schwelle ist über `MARKET_SHOCK_PERCENT` einstellbar.
- Der `EventMatcher` arbeitet mit Namensähnlichkeit und Datum. Bei stark
  abweichenden Schreibweisen (etwa Jugend- oder Reservemannschaften) kann er
  danebenliegen; die Alias-Tabelle in `backend/core/normalization.py` ist
  bewusst klein gehalten und erweiterbar.
- Die Alarme sind **Hinweise**, keine Wettempfehlungen. Ob eine Quote
  tatsächlich spielbar ist (Limits, Einsatzhöhe, Stornoregeln des Anbieters),
  entscheidet der Mensch.

**Trefferbilanz**

- Der Closing Line Value ist **kein Gewinn**. Er misst, dass ein Preis besser
  war als der Marktkonsens kurz danach — nicht, ob eine Wette gewonnen hätte.
- Der „Schlusskurs" ist der *zuletzt beobachtete* Kurs, nicht der echte
  Schlusskurs. Bei einem Poll-Takt von einer Stunde ist die Bilanz ein Indiz,
  keine Messung.
- Über einen Spielstandwechsel hinweg wird bewusst **nicht** geurteilt
  (Urteil „überholt"). Im Live-Betrieb betrifft das viele Alarme; die Bilanz
  ist dort entsprechend dünn. Pre-Match ist sie belastbarer.
- Die Referenz ist der Durchschnitt derselben Buchmacher, die auch die Alarme
  auslösen. Ist der beobachtete Markt insgesamt schief, ist es die Bilanz
  auch — ein unabhängiger Maßstab wäre nur mit einer weiteren Datenquelle zu
  haben.

**Betrieb**

- Der Scanner läuft als **eine** Instanz. Mehrere Instanzen teilen sich zwar
  Redis, würden aber dieselben Quellen doppelt abfragen. Für horizontale
  Skalierung müssten die Provider auf Instanzen aufgeteilt werden.
- Der Prozess-Cache für die Änderungserkennung ist prozesslokal: nach einem
  Neustart des Scanners hat die erste Quote je Zeile keinen Vorpreis.
- Das Dashboard ist **im Auslieferungszustand ungeschützt**. Für den Betrieb
  im Internet `./scripts/set-dashboard-password.sh` ausführen — und zusätzlich
  TLS davorsetzen, weil Basic Auth das Passwort sonst im Klartext überträgt.

**SportsGameOdds: was am echten Konto bestätigt ist**

Das Schema stammt aus der offiziellen, aus der OpenAPI-Spezifikation
generierten SDK. Am laufenden Konto bestätigt sind inzwischen: Key und
Verbindung, die **Quotenumrechnung** (amerikanisch → dezimal, geprüft an
zehn echten Werten) und die Marktarten `ml`, `ml3way`, `sp`, `ou`, `yn`, `eo`.

Nicht abgedeckt sind Ja/Nein-Märkte außer Both Teams To Score sowie
Gerade/Ungerade — beide werden übersprungen und gezählt. Was dir dort fehlt,
lässt sich am ausgegebenen Marktnamen belegen und nachrüsten.

**In dieser Umgebung nicht ausgeführt**

Die Docker-Images konnten hier nicht gebaut werden (im Build-Container lief
kein Docker-Daemon). Verifiziert wurde stattdessen alles, was ohne ihn
möglich ist:

- `docker compose config` löst die komplette Datei auf; der Pflicht-Check für
  `POSTGRES_PASSWORD` greift wie vorgesehen
- Migration und Schema gegen ein echtes PostgreSQL 16 (`alembic check` sauber)
- die komplette Pipeline gegen echtes Redis und PostgreSQL
- die API inklusive WebSocket-Handshake
- **die nginx-Konfiguration mit echtem nginx**: alle Routen, das Strippen des
  `/api`-Präfixes, Swagger unter `/docs`, der WebSocket-Upgrade und die
  Security-Header
- das Dashboard in einem echten Chromium **durch nginx**: Live-Updates über
  `/ws`, Filter, Responsiveness, keine JS-Fehler und keine CSP-Verstöße

Ungetestet bleibt damit nur der Image-Build selbst (`pip install` der
gepinnten Abhängigkeiten in `python:3.12-slim`).

---

## 24. Rechtliches

- **Reines Analysewerkzeug.** Keine automatische Wettabgabe, keine
  Manipulation von Buchmacherseiten, keine Umgehung von CAPTCHAs, Cloudflare,
  Logins oder Anti-Bot-Maßnahmen.
- Es werden ausschließlich Quellen genutzt, deren automatisierter Abruf laut
  Anbieter erlaubt ist. Vor dem Einsatz einer Quelle deren Nutzungsbedingungen
  prüfen — sie können sich ändern.
- Glücksspiel kann süchtig machen und ist in vielen Ländern reguliert und
  altersbeschränkt. Dieses Projekt gibt keine Wettempfehlungen.
- Hilfe bei Spielsucht (Deutschland): <https://www.bzga.de> ·
  Telefon 0800 1 372 700 (kostenlos, anonym).
