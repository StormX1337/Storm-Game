# STORM BET

Moderne Sportwetten-Plattform – **ausschließlich im Demo-Modus**. Gewettet wird mit Spielgeld (DEMO). Die
Daten kommen wahlweise aus dem eingebauten Simulator (Standard, als Demo gekennzeichnet) oder als **echte
Spielpläne, Quoten und Ergebnisse** von [The Odds API](https://the-odds-api.com) (`ODDS_PROVIDER=theoddsapi`)
oder [SportsGameOdds](https://sportsgameodds.com) (`ODDS_PROVIDER=sportsgameodds`), siehe
[SETUP.md](SETUP.md#echte-quoten-the-odds-api). Es gibt keine Einzahlungen, keine Auszahlungen und
keinen Echtgeldbetrieb; der entsprechende Schalter ist technisch gesperrt.

![Stack](https://img.shields.io/badge/Next.js-15-black) ![Stack](https://img.shields.io/badge/Fastify-5-black)
![Stack](https://img.shields.io/badge/PostgreSQL-16-336791) ![Stack](https://img.shields.io/badge/Redis-7-d82c20)

## Funktionsumfang

**Spieler**

- Sportsbook für Fußball, Tennis und Basketball: Ligen, Events, Live-Events mit Spielstand und Statistiken
- Märkte: 1X2, Doppelte Chance, Draw No Bet, Über/Unter, Asiatisches Handicap, Beide treffen, Ecken, Karten,
  Torschützen, Sieger, Satzwetten, Spiele-/Punkte-Handicaps und -Totals; mit SportsGameOdds zusätzlich
  Halbzeit-Wetten und Spieler-Wetten (Basketball-Punkte/-Rebounds/-Assists)
- Cashout offener Wetten (Wert zu aktuellen Quoten, 5 % Abschlag, zweistufige Bestätigung)
- Live-Matchcenter: Spielfeld/Court mit Spielstand, Periode und Uhr, Viertel/Halbzeiten und
  Teamstatistiken – nur Daten, die der Feed liefert (kein Ball-Tracking)
- Bet Builder: mehrere Tipps auf ein Fußballspiel zu einer Modell-Quote; mit echten Feeds zusätzliche,
  aus den Feed-Quoten berechnete Märkte (Doppelte Chance, Draw No Bet, Beide treffen, weitere Linien)
- Wettschein mit Einzel-, Zweier-, Dreier- und Kombiwetten, serverseitiger Quote, sichtbarer Quotenänderung
  („Quote wurde aktualisiert.“) und ausdrücklicher Annahme; Sticky-Wettschein auf Mobile
- Live-Updates per Server-Sent Events (Quoten, Marktstatus, Spielstand)
- **Casino (DEMO MODE – No real money)**: Lobby mit Empfohlen/Beliebt/Neu, Kategorien (Slots, Roulette,
  Blackjack, Baccarat, Tischspiele, Live Casino), Suche und Favoriten; spielbare Demo-Versionen von Slots,
  europäischem Roulette, Blackjack und Baccarat – jede Runde serverseitig entschieden und gespeichert;
  Casino-Verlauf unter `/casino/history`
- Navigation: Sport, Live, Casino, Aktionen, Meine Wetten, Wallet, Profil; mobile Bottom-Navigation
- Dashboard: Guthaben, offene/abgerechnete Wetten, Wetthistorie mit Quoten-Snapshot, Transaktionen, Profil,
  Sitzungen, Einsatzlimits mit Bedenkzeit, Selbstsperre

**Betrieb**

- Admin-Panel mit RBAC (Support, Trader, Admin): Nutzer, Events, Märkte, Quoten (manuelle Events),
  Ergebniserfassung und Abrechnung, Wetten, Transaktionen, Audit-Log, Odds-Provider, System Health;
  Casino (`/admin/casino`): Spiele, Status, Empfehlungen, Kategorien, Anbieter, Sitzungen, Demo-Runden
- Worker: Odds-Sync (Katalog, Live, Pre-Match), Settlement, Wartung – über BullMQ-Scheduler

**Integrität**

- Wettplatzierung in einer PostgreSQL-Transaktion mit Row-Locks, idempotent über Wettschein-Schlüssel
- Wallet mit Saldo / reserviert / verfügbar; jede Bewegung im unveränderlichen Hauptbuch
- Datenbank-Trigger: kein negatives Wallet, keine Doppelauszahlung, abgerechnete Wetten und Audit-Log unveränderlich
- Casino-Runden in einer Transaktion mit Wallet-Lock, idempotent (Schlüssel + Request-Hash bzw. Schritt-Nummer),
  höchstens eine Auszahlung pro Runde (DB-Index + Trigger), abgeschlossene Runden unveränderlich

## Schnellstart (Docker)

```bash
cd storm-bet
cp .env.example .env
# AUTH_SECRET, POSTGRES_PASSWORD und optional SEED_*_PASSWORD setzen:
sed -i "s#^AUTH_SECRET=.*#AUTH_SECRET=$(openssl rand -base64 48)#" .env
sed -i "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$(openssl rand -hex 16)#" .env
docker compose up -d --build
```

Danach: <http://localhost:3000>. Der `migrate`-Job migriert die Datenbank, legt Admin- und Demo-Konto an
(Passwörter aus `.env` oder einmalig generiert – siehe `docker compose logs migrate`) und importiert den
Katalog (Simulator oder – mit `ODDS_PROVIDER=theoddsapi`/`sportsgameodds` – echte Daten).

## Lokale Entwicklung

```bash
pnpm install
cp .env.example .env            # Werte ergänzen, DATABASE_URL/REDIS_URL auf lokale Dienste
pnpm db:migrate && pnpm db:seed
pnpm dev                        # api :4000, worker, web :3000
```

Ausführlich: [SETUP.md](SETUP.md) · Architektur: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
Sicherheit & Compliance: [docs/SECURITY.md](docs/SECURITY.md)

## Skripte

| Befehl                                               | Zweck                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm dev`                                           | API, Worker und Web im Watch-Modus                             |
| `pnpm build`                                         | Prisma-Client, API- und Worker-Bundles, Next.js-Build          |
| `pnpm start`                                         | gebaute Dienste starten                                        |
| `pnpm test`                                          | Vitest: Unit- und Integrationstests (PostgreSQL + Redis nötig) |
| `pnpm test:e2e`                                      | Playwright gegen den laufenden Stack                           |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Qualitätsprüfungen                                             |
| `pnpm db:migrate` / `pnpm db:seed`                   | Migrationen anwenden / Demo-Daten                              |

## Projektstruktur

```
apps/
  web/            Next.js 15 (App Router) – Sportsbook, Dashboard, Admin, /api-Proxy
  api/            Fastify 5 – REST-API, Sessions, CSRF, RBAC, SSE
  worker/         BullMQ-Jobs – Odds-Sync, Settlement, Wartung; Seed
packages/
  types/          Enums, Fehlercodes, RBAC, Marktkatalog, DTOs
  validation/     Zod-Schemas für jede Eingabe (Client und Server)
  config/         validierte Umgebung, Konstanten, Limits
  database/       Prisma-Schema, Migrationen mit DB-Guards, Client, Audit
  redis/          Locks, Rate-Limiter, Cache, Pub/Sub
  security/       Argon2id, Tokens, CSRF, CIDR
  odds-engine/    OddsProvider-Interface, Mock-, TheOddsApi-, SportsGameOdds-Provider, Resilience, Sync
  betting-engine/ Quoten-Mathematik, Wettschein-Regeln, Placement, Wallet, Settlement
  casino/         CasinoProvider-Interface, MockCasinoProvider, Spiel-Engines, Runden-/Sitzungs-Service
  compliance/     Limits, Selbstsperre, Jurisdiktion, KYC-/Zahlungs-Schnittstellen
  ui/             Design-System (Tailwind v4, shadcn-Stil auf Radix)
tests/            Vitest-Integration-Setup, Playwright-E2E
docker/           Dockerfile (Targets api, worker, web)
```

## Rechtlicher Hinweis

STORM BET ist Demonstrationssoftware ohne Glücksspiellizenz. Ein Echtgeldbetrieb würde eine behördliche
Lizenz, Identitäts- und Altersprüfung, Geolokalisierung, Einzahlungs- und Verlustlimits, Anbindung an
Sperrsysteme (z. B. OASIS) und weitere regulatorische Maßnahmen voraussetzen. Die dafür vorgesehenen
Schnittstellen sind vorbereitet, aber bewusst nicht aktiviert.
