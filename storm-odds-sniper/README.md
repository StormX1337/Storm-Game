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

> ### 🧪 Nach der Installation laufen erfundene Daten
>
> Ohne Konfiguration startet das System mit dem **MockProvider** — einer
> Simulation. Spiele wie „Mock München vs Mock Dortmund" **existieren nicht**;
> das Präfix `Mock` kennzeichnet sie. Das ist Absicht: so lässt sich alles
> ausprobieren, bevor Zugangsdaten hinterlegt sind. Dashboard und Telegram
> weisen darauf hin, solange simuliert wird.
>
> Für echte Quoten `PROVIDERS` in der `.env` umstellen →
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
| 🔌 **Austauschbare Quellen** | Provider-Adapter hinter einer gemeinsamen Schnittstelle |

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
        │   MockProvider     The Odds API      Betfair
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

| | Mock/Test | Produktivbetrieb |
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

Alles Weitere ist optional: mit den Standardwerten läuft das System sofort mit
dem `MockProvider` und liefert simulierte Daten — nützlich, um Pipeline,
Dashboard und Telegram-Formatierung zu prüfen, bevor echte Zugangsdaten
hinterlegt werden.

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

Die Provider werden über `PROVIDERS` gewählt (kommagetrennt, mehrere parallel).

### MockProvider — funktioniert sofort

```env
PROVIDERS=mock
```

Vollständige Simulation mit Push-Stream, Live-Spielverlauf (Tore, Karten,
Sätze, Games), mehreren Buchmachern mit eigener Marge und gelegentlichen
Fehlpreisen. **Keine echten Quoten** — Team- und Buchmachernamen tragen
deshalb bewusst das Präfix `Mock`.

### The Odds API — echte Quoten, API-Key nötig

Registrierung: <https://the-odds-api.com> (kostenloses Einstiegskontingent).

```env
PROVIDERS=the_odds_api
ODDS_API_KEY=dein_key
ODDS_API_REGIONS=eu,uk
ODDS_API_MARKETS=h2h,spreads,totals
ODDS_API_POLL_INTERVAL=20
```

⚠️ **Kontingent beachten.** Jede Quotenabfrage kostet
`Anzahl Märkte × Anzahl Regionen` Credits. Mit 3 Märkten und 2 Regionen kostet
ein Abruf 6 Credits; bei 20 Sekunden Takt sind das über 25 000 Credits pro Tag.
Das kostenlose Kontingent (500 Credits/Monat) reicht damit **nicht für den
Live-Betrieb** — es reicht zum Ausprobieren und für Pre-Match-Scans mit langem
Intervall. Der Adapter liest den Header `x-requests-remaining` und pausiert
selbstständig, bevor das Kontingent aufgebraucht ist.

Diese Quelle liefert **keine** Spielminute, keine Karten und keine
Tennis-Punktdetails. Diese Felder bleiben leer — sie werden nicht geschätzt.

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
der Grund geloggt — die übrigen laufen weiter. Bleibt keiner übrig, greift der
MockProvider, damit das System nie stumm läuft. Welche Quelle gerade läuft und
was fehlt, zeigen das Dashboard und `GET /health/providers`.

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
  Value, Confidence und Status — filterbar nach Art und Sportart
- **Live-Events** mit Minute, Spielstand bzw. Satz, Games und Punkten
- **Quotenbewegungen**
- **Datenquellen** mit Status und fehlenden Zugangsdaten
- **Buchmacher** nach Alarmhäufigkeit
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
| `/pause` | Benachrichtigungen pausieren |
| `/resume` | Benachrichtigungen fortsetzen |

Inline-Menü: ⚽ Fußball · 🎾 Tennis · 🔴 Live · 🟢 Pre-Match · 💎 Value ·
🎯 Fixed Error · ⚙️ Einstellungen · 📊 Status

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

### Schritt 6 — False-Positive-Schutz

Mindestanzahl Buchmacher · Mindest-Value · Mindestabweichung · maximales
Quotenalter · Cooldown je Quotenzeile · Duplikaterkennung über Preis-Buckets ·
Suspendierungs-Erkennung · Marktdrift-Unterdrückung · Ausschluss praktisch
entschiedener Märkte.

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
| `GET /alerts` | Alarm-Historie (`?kind=`, `?sport=`, `?min_value=`, `?since_minutes=`) |
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
| Mock-Simulation, Reconnect, Parser der echten Quellen | `test_providers.py` |
| Scanner-Pipeline, Vorreiter/Nachzügler | `test_scanner.py` |
| Redis-Zustand und Pub/Sub | `test_redis_state.py` |
| Repository und Migrationsschema | `test_database.py` |
| HTTP-API, CORS, Rate-Limit | `test_api.py` |
| Telegram-Formatierung und Empfängerfilter | `test_telegram.py` |
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
   zu scannen geben; mit `PROVIDERS=mock` gegenprüfen

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
| Telegram-Token | nur im Backend, niemals im Frontend |
| Wettabgabe | technisch nicht vorhanden |

Für den Betrieb über das Internet zusätzlich einen TLS-Reverse-Proxy
davorsetzen und `API_CORS_ORIGINS` auf die echte Domain setzen.

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
│   │   ├── mock_provider.py  Simulation (Push)
│   │   ├── the_odds_api.py   The Odds API (REST)
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
├── scripts/                  Healthchecks, Rauchtest, Dev-Helfer
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
  Buchmacherquoten. Die Architektur ist auf Push ausgelegt (der MockProvider
  nutzt sie), die beiden echten Adapter arbeiten aber mit asynchronem
  HTTP-Polling. Ein Push-Adapter braucht nur `stream()` zu überschreiben.
- Die Betfair Stream API (TLS-Socket, nicht WebSocket) ist bewusst **nicht**
  implementiert: sie ist ohne Konto nicht testbar, und ungetesteter Code für
  Delta-Merging wäre in einem Low-Latency-Pfad ein Risiko. Der JSON-RPC-Adapter
  deckt dieselben Daten ab, mit etwas höherer Latenz.
- Das kostenlose Kontingent von The Odds API reicht **nicht** für Live-Scans
  (siehe [Abschnitt 9](#9-datenquellen-konfigurieren)).
- **Spielminute, Karten und Tennis-Punktdetails liefert keine der beiden echten
  Quellen.** Diese Felder bleiben leer statt geschätzt zu werden. Der
  MockProvider liefert sie vollständig, damit die Verarbeitung bis in die
  Telegram-Nachricht testbar ist.

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

**Betrieb**

- Der Scanner läuft als **eine** Instanz. Mehrere Instanzen teilen sich zwar
  Redis, würden aber dieselben Quellen doppelt abfragen. Für horizontale
  Skalierung müssten die Provider auf Instanzen aufgeteilt werden.
- Der Prozess-Cache für die Änderungserkennung ist prozesslokal: nach einem
  Neustart des Scanners hat die erste Quote je Zeile keinen Vorpreis.
- Das Dashboard hat keine Authentifizierung. Es gehört hinter einen
  Reverse-Proxy mit Zugangsschutz, wenn es öffentlich erreichbar ist.

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
