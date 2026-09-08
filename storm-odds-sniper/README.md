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

- **Alarme** mit Zeit, Sport, Event, Markt, Buchmacher, Quote, fairer Quote,
  Value, Confidence, Status und **Urteil** — filterbar nach Art und Sportart.
  Ein Klick auf die Zeile klappt die Herleitung auf: verglichene Preise, die
  drei Modelle, die Signale des Error-Scores und, sobald vorhanden, die
  Nachkontrolle mit den Preisen davor und danach.
- **Live-Events** mit Minute, Spielstand bzw. Satz, Games und Punkten
- **Quotenbewegungen**
- **Datenquellen** mit Status und fehlenden Zugangsdaten
- **Buchmacher** nach Alarmhäufigkeit
- **Warum keine Alarme?** — Zähler je Grund, in Klartext
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
| `/bilanz` | Trefferbilanz: was aus den Alarmen wurde |
| `/pause` | Benachrichtigungen pausieren |
| `/resume` | Benachrichtigungen fortsetzen |

Inline-Menü: ⚽ Fußball · 🎾 Tennis · 🔴 Live · 🟢 Pre-Match · 💎 Value ·
🎯 Fixed Error · 📒 Bilanz · 📊 Status · ⚙️ Einstellungen

Jeder Nutzer hat **eigene** Schwellen (Value, Quote, Buchmacheranzahl,
Confidence, Cooldown, Sportarten, Märkte, Live/Pre-Match). Sie wirken zusätzlich
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

Die wichtigsten Werte in der `.env`:

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
| `GET /events/live` | nur laufende Events |
| `GET /events/{id}` | einzelnes Event |
| `GET /odds?event_id=` | aktuelle Quoten aus Redis |
| `GET /alerts` | Alarm-Historie (`?kind=`, `?sport=`, `?min_value=`, `?since_minutes=`), je Alarm mit `verdict` und `clv_percent` |
| `GET /alerts/scorecard` | Trefferbilanz: was aus den Alarmen wurde (`?window_hours=`) |
| `GET /stats` | Kennzahlen |
| `GET /metrics` | Prometheus |
| `WS /ws` | Live-Stream (Alarme, Events, Bewegungen) |

Beispiel:

```bash
curl -s http://localhost:8080/api/alerts?limit=5 | jq
curl -s http://localhost:8080/api/events/live | jq '.[].home'
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
