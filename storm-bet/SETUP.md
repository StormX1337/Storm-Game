# Setup

## Voraussetzungen

| Werkzeug         | Version                                          |
| ---------------- | ------------------------------------------------ |
| Node.js          | ≥ 22.12                                          |
| pnpm             | 10.x (`corepack enable` oder `npm i -g pnpm@10`) |
| PostgreSQL       | 16                                               |
| Redis            | 7 (`maxmemory-policy noeviction` für BullMQ)     |
| Docker + Compose | optional, für den Container-Betrieb              |

## Installation

```bash
cd storm-bet
pnpm install
cp .env.example .env
```

## Umgebungsvariablen

Alle Werte werden beim Start mit Zod validiert (`packages/config/src/env.ts`); fehlerhafte Konfiguration
bricht den Start mit einer klaren Meldung ab.

| Variable                                                                                       | Pflicht | Bedeutung                                                                                         |
| ---------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                 | ja      | PostgreSQL-Verbindung                                                                             |
| `REDIS_URL`                                                                                    | ja      | Redis-Verbindung                                                                                  |
| `AUTH_SECRET`                                                                                  | ja      | ≥ 32 Zeichen, signiert CSRF-Tokens (`openssl rand -base64 48`)                                    |
| `APP_URL`                                                                                      | ja      | öffentliche Origin der Web-App; `https://` ⇒ Secure-Cookies und HSTS. In Produktion Pflicht-HTTPS |
| `API_INTERNAL_URL`                                                                             | Web     | Adresse der API aus Sicht des Web-Servers (SSR und `/api`-Proxy)                                  |
| `TRUST_PROXY`                                                                                  | –       | Proxies, deren `X-Forwarded-For` geglaubt wird (Standard: `loopback,uniquelocal`)                 |
| `ADMIN_IP_ALLOWLIST`                                                                           | –       | CIDR-Liste für `/api/admin`                                                                       |
| `SESSION_TTL_HOURS`, `SESSION_IDLE_MINUTES`, `ADMIN_SESSION_IDLE_MINUTES`                      | –       | Sitzungsdauer, Leerlauf (Staff kürzer)                                                            |
| `AUTH_REQUIRE_EMAIL_VERIFICATION`                                                              | –       | Wetten erst nach E-Mail-Bestätigung                                                               |
| `SMTP_URL`, `MAIL_FROM`, `SUPPORT_EMAIL`                                                       | –       | Mailversand; ohne `SMTP_URL` landen Mails im API-Log                                              |
| `AUDIT_LOG_IP`                                                                                 | –       | IP-Adressen im Audit-Log speichern (abschaltbar, wo nicht zulässig)                               |
| `BET_MIN_STAKE`, `BET_MAX_STAKE`, `BET_MAX_PAYOUT`, `BET_MAX_SELECTIONS`, `BET_MAX_TOTAL_ODDS` | –       | Wettlimits (Beträge in Cent), gedeckelt durch harte Obergrenzen                                   |
| `ODDS_ACCEPT_HIGHER_MAX_PCT`                                                                   | –       | größte automatisch akzeptierte Quotenerhöhung (nur mit Opt-in)                                    |
| `DEMO_STARTING_BALANCE`, `DEMO_TOPUP_*`                                                        | –       | Demo-Startguthaben und Aufladung                                                                  |
| `MOCK_SEED`, `MOCK_TIME_SCALE`                                                                 | –       | Simulator: Seed und Spielzeit-Faktor (3 = 90 Min. Fußball in 30 Min.)                             |
| `ODDS_PROVIDER`                                                                                | –       | `mock` (Simulator, Standard) oder `theoddsapi` (echte Daten, siehe unten)                         |
| `ODDS_API_KEY`                                                                                 | Feed    | API-Key von The Odds API; Pflicht bei `ODDS_PROVIDER=theoddsapi`                                  |
| `ODDS_API_SPORTS`, `ODDS_API_REGIONS`, `ODDS_API_BOOKMAKERS`                                   | –       | Wettbewerbe (`*` am Ende = Präfix), Buchmacher-Region bzw. feste Buchmacher                       |
| `ODDS_API_ODDS_TTL_SECONDS`, `ODDS_API_SCORES_TTL_SECONDS`, `ODDS_API_MIN_REMAINING`           | –       | Abruftakt pro Wettbewerb und Credit-Reserve                                                       |
| `ODDS_API_LIVE_BETTING`, `ODDS_API_LIVE_MAX_AGE_SECONDS`                                       | –       | Live-Wetten auf echte Spiele (Standard aus) und maximales Quotenalter                             |
| `PROVIDER_*`                                                                                   | –       | Timeout, Retries, Rate-Limit, Cache des Odds-Providers                                            |
| `*_INTERVAL_MS`                                                                                | –       | Takt der Worker-Jobs                                                                              |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO_EMAIL`, `SEED_DEMO_PASSWORD`             | –       | Seed-Konten; leere Passwörter werden generiert und einmalig ausgegeben                            |
| `REAL_MONEY_ENABLED`                                                                           | –       | **gesperrt** – jeder Wert außer `false` verhindert den Start                                      |

Secrets gehören ausschließlich in `.env` (per `.gitignore` ausgeschlossen) oder in den Secret-Store der
Zielumgebung. `.env.example` enthält keine echten Werte.

## Datenbank

```bash
pnpm db:migrate        # prisma migrate deploy (nicht-destruktiv)
pnpm db:seed           # Konten, simulierter Katalog, Beispielwetten (idempotent)
pnpm db:migrate:dev    # neue Migration entwickeln (nur lokal)
pnpm db:studio         # Prisma Studio
```

Die zweite Migration (`ledger_guards`) installiert Integritätsregeln, die auch bei Fehlern in der Anwendung
gelten: CHECK-Constraints für Wallets, Append-only-Trigger für `transactions`, `audit_logs` und
`odds_snapshots`, genau eine Abrechnungsbuchung pro Wette und unveränderliche abgerechnete Wetten.

## Entwicklung

```bash
pnpm dev
```

- Web: <http://localhost:3000> (proxied `/api` → API)
- API: <http://localhost:4000/api/health>
- Worker-Health: <http://localhost:4100/health>

Mails (Verifizierung, Passwort-Reset) erscheinen ohne `SMTP_URL` im API-Log.

## Echte Quoten (The Odds API)

Statt des Simulators kann der Worker echte Spielpläne, Quoten und Ergebnisse von
[The Odds API](https://the-odds-api.com) (v4) laden. Gewettet wird weiterhin **nur mit Demo-Guthaben**.

1. API-Key registrieren und in `.env` eintragen:
   ```bash
   ODDS_PROVIDER=theoddsapi
   ODDS_API_KEY=dein-key
   ```
2. Verbindung und Kontingent prüfen (kostet nur mit `--with-odds` Credits):
   ```bash
   pnpm odds:check              # Wettbewerbe + verbleibende Credits
   pnpm odds:check --with-odds  # zusätzlich Quoten des ersten Wettbewerbs
   ```
3. Worker und API neu starten. `pnpm db:seed` importiert die nächsten 7 Tage.

**Credits:** Ein Quotenabruf kostet _Märkte × Regionen_ pro Wettbewerb (Fußball/Basketball 3, Tennis 1),
ein Ergebnisabruf 2 – letzterer nur, solange in dem Wettbewerb ein Spiel läuft. Mit den Standardwerten
(8 Wettbewerbe, Quoten alle 15 Min.) fallen über 2.000 Credits pro Tag an; der kostenlose Plan
(500/Monat) reicht dafür nicht – dort `ODDS_API_SPORTS` auf 1–2 Wettbewerbe und
`ODDS_API_ODDS_TTL_SECONDS` auf mehrere Stunden setzen. Unterhalb von `ODDS_API_MIN_REMAINING` stoppt der
Worker alle kostenpflichtigen Abrufe und suspendiert die Märkte; der Admin-Bereich (System) zeigt das
Kontingent.

**Angebot:** Nur Märkte, die sich aus dem Endergebnis sicher abrechnen lassen: Ergebnis (1X2/Sieger),
Handicap (ohne Viertel-Linien) und Über/Unter. Statistiken (Ecken, Karten, Torschützen) liefert der Feed
nicht; sie werden nicht erfunden. Live-Wetten sind standardmäßig aus (`ODDS_API_LIVE_BETTING`), weil
Snapshot-Quoten schnell veralten. Events, zu denen der Feed kein Ergebnis mehr liefert (älter als 3 Tage,
abgesagt), bleiben offen und müssen im Admin-Bereich abgerechnet oder storniert werden.

**Netzwerk:** Der Worker braucht ausgehend HTTPS zu `api.the-odds-api.com`. Hinter einem HTTP-Proxy
zusätzlich `NODE_USE_ENV_PROXY=1` setzen (Node ≥ 22.15), damit `fetch` `HTTPS_PROXY` verwendet.

## Tests

```bash
pnpm test              # Unit + Integration (Vitest)
pnpm test:e2e          # Playwright; Stack muss laufen (oder E2E_START=1)
```

Die Integrationstests benutzen eine eigene Datenbank (`TEST_DATABASE_URL`, Standard
`postgresql://stormbet:stormbet@localhost:5432/stormbet_test`) und Redis-DB 15. Sie wenden nur ausstehende
Migrationen an und legen eigene Datensätze an – es wird nie etwas zurückgesetzt oder gelöscht.

Besonders abgesichert:

| Test                                                    | Datei                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Wette darf nicht doppelt platziert werden               | `packages/betting-engine/test/betting.int.test.ts`                                            |
| Quote wird während des Place-Vorgangs geändert          | ebenda (paralleler Row-Lock)                                                                  |
| Wallet darf niemals negativ werden                      | ebenda (parallele Wetten + DB-Constraint)                                                     |
| Settlement darf nicht doppelt auszahlen                 | ebenda (parallele Läufe + Ledger-Trigger)                                                     |
| Login, Registrierung, Brute-Force, CSRF, Passwort-Reset | `apps/api/test/api.int.test.ts`                                                               |
| Rollen/Berechtigungen, Admin-APIs                       | ebenda                                                                                        |
| Quoten-, Wettschein- und Abrechnungsregeln              | `packages/betting-engine/test/domain.test.ts`                                                 |
| Simulator, Resilience, Sync                             | `packages/odds-engine/test/*`                                                                 |
| The-Odds-API-Mapping, Kontingent, Sync → Abrechnung     | `packages/odds-engine/test/the-odds-api.test.ts`, `apps/worker/test/the-odds-api.int.test.ts` |

## Docker

```bash
docker compose up -d --build
docker compose ps                # alle Dienste mit Healthcheck
docker compose logs -f worker
```

Dienste: `postgres`, `redis`, `migrate` (einmalig: Migrationen + Seed, abschaltbar mit `SEED_ON_START=false`),
`api`, `worker`, `web`. Nur `web` ist veröffentlicht (Port `WEB_PORT`, Standard 3000).

Hinter einem TLS-abfangenden Firmenproxy kann dem Build ein CA-Zertifikat übergeben werden (nichts davon
landet im Image):

```bash
docker build -f docker/Dockerfile --target api --secret id=ca,src=/pfad/zu/ca.pem -t storm-bet/api .
```

## Production Build

```bash
pnpm build
pnpm start
```

- API und Worker werden mit esbuild zu je einer Datei gebündelt; Laufzeitabhängigkeiten bleiben extern.
- Die Web-App wird als Next.js-Standalone-Server gebaut.
- Vor die Web-App gehört ein TLS-terminierender Reverse-Proxy (z. B. Caddy, nginx, Load Balancer), der
  `X-Forwarded-For` setzt. `APP_URL` muss dessen `https://`-Origin sein.

## Zugänge nach dem Seed

| Rolle   | E-Mail                                                | Passwort                                      |
| ------- | ----------------------------------------------------- | --------------------------------------------- |
| Admin   | `SEED_ADMIN_EMAIL` (Standard `admin@storm-bet.local`) | `SEED_ADMIN_PASSWORD` bzw. einmalig generiert |
| Spieler | `SEED_DEMO_EMAIL` (Standard `demo@storm-bet.local`)   | `SEED_DEMO_PASSWORD` bzw. einmalig generiert  |

Weitere Staff-Rollen (Support, Trader) vergibt ein Admin im Admin-Panel (mit Passwortbestätigung).
