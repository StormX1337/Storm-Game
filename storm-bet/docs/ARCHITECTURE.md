# Architektur

```
 Browser ──► web (Next.js 15)  ──/api/*──►  api (Fastify 5)  ──►  PostgreSQL 16
              SSR über die API              REST · SSE · RBAC     (Quelle der Wahrheit)
              CSP mit Nonce                 Sessions · CSRF              ▲
                                             │        ▲                  │
                                             ▼        │ Pub/Sub          │
                                           Redis 7 ◄──┴─────────  worker (BullMQ)
                                  Locks · Rate-Limits ·            Odds-Sync · Settlement
                                  Cache · Queues · Events          Wartung · Heartbeat
                                                                         │
                                                                   OddsProvider
                          (MockOddsProvider | TheOddsApiProvider | SportsGameOddsProvider → Resilient)
```

## Prinzipien

- **PostgreSQL entscheidet.** Quoten, Status, Guthaben und Wetten werden nur aus der Datenbank gelesen, wenn
  es um Geld (auch Spielgeld) geht. Redis beschleunigt, entscheidet aber nichts.
- **Dem Client wird nichts geglaubt.** Der Wettschein sendet Auswahl-ID und gesehene Quote; der Server prüft
  alles erneut und berechnet Gesamtquote und Gewinn selbst.
- **Integrität in der Datenbank.** Constraints und Trigger verhindern negative Wallets, doppelte Auszahlungen
  und das Ändern abgerechneter Wetten – unabhängig davon, welcher Code schreibt.
- **Business-Logik in Paketen, nicht in der UI.** `betting-engine` und `odds-engine` sind die einzigen Orte, an
  denen Quoten, Einsätze und Ergebnisse berechnet werden.

## Wettplatzierung

1. Session prüfen (API), Rate-Limit pro Nutzer
2. Idempotenz: vorhandener Wettschein mit gleichem Schlüssel ⇒ Antwort wird wiederholt, anderer Inhalt ⇒ 409
3. Redis-Lock pro Nutzer (verhindert Warteschlangen auf DB-Locks)
4. Eine READ-COMMITTED-Transaktion:
   - Nutzer (Status, E-Mail-Bestätigung) neu laden, Wallet `FOR UPDATE`
   - Selbstsperre prüfen
   - Events → Märkte → Auswahlen `FOR SHARE` (je nach ID sortiert) und laden
   - Regeln: aktiv, nicht beendet, kein Past-Posting, Markt/Auswahl offen, Quote gleich (oder – nur mit
     Opt-in – höchstens X % höher), keine zwei Auswahlen desselben Events in einer Kombi, Mindest-/
     Höchsteinsatz, Höchstgewinn, Gesamtquote
   - Limits (pro Wette, 24 h, 7 Tage, 30 Tage), Guthaben
   - `BetSlip`, `Bet`, `BetSelection`, `OddsSnapshot`, Reservierung (bedingtes UPDATE), `Transaction`,
     `AuditLog`
5. Deadlock/Serialisierungsfehler ⇒ bis zu zwei Wiederholungen

Ein Quoten-Update wartet auf die Share-Locks und wird direkt nach der Wette wirksam; eine Wette kann also nie
mit einer Quote angenommen werden, die zum Commit-Zeitpunkt nicht mehr galt. Sync, Admin und Placement sperren
in derselben Reihenfolge (Märkte vor Auswahlen, sortiert), damit keine Deadlocks entstehen.

## Wallet

`balance` = Gesamtguthaben inkl. reservierter Einsätze, `reserved` = Einsätze offener Wetten,
verfügbar = `balance − reserved`.

| Buchung                   | Saldo                    | reserviert |
| ------------------------- | ------------------------ | ---------- |
| `DEPOSIT_DEMO`            | + Betrag                 | –          |
| `BET_PLACED`              | –                        | + Einsatz  |
| `BET_WON`                 | + (Auszahlung − Einsatz) | − Einsatz  |
| `BET_LOST`                | − Einsatz                | − Einsatz  |
| `BET_VOID` / `BET_REFUND` | –                        | − Einsatz  |

Jede Buchung speichert den Stand danach; die Tabelle ist append-only.

## Odds Engine

- `OddsProvider` – providerneutrale Schnittstelle (`getSports`, `getLeagues`, `getEvents`, `getEvent`,
  `getMarkets`, `getLiveEvents`). Die Auswahl trifft `ODDS_PROVIDER` (`apps/worker/src/provider.ts`);
  `PROVIDER_INFO` legt fest, welche Quellen als simuliert gekennzeichnet werden (unbekannt ⇒ simuliert).
- `MockOddsProvider` – zustandslos und deterministisch: jedes Spiel ergibt sich aus Seed + ID + Zeit.
  Fußball über Poisson-Modelle (inkl. In-Play-Neubewertung, Rote Karten, kurze Sperren nach Toren), Tennis
  über eine Markov-Kette auf Spiel-/Satzebene, Basketball über Normalverteilungen. Marge offen und
  proportional, Quoten auf eine übliche Leiter gerundet. Alle Namen sind erfunden, alle Daten als simuliert
  markiert. Rund 2 % der Spiele werden kurz vor Beginn abgesagt (Storno-Abrechnung).
- `TheOddsApiProvider` – echte Daten aus The Odds API v4. Pro Wettbewerb ein Quoten-Snapshot (`/odds`,
  erneuert nach `ODDS_API_ODDS_TTL_SECONDS`) und – nur solange dort ein Spiel läuft – ein Ergebnis-Snapshot
  (`/scores`); `getEvent`/`getMarkets` lesen aus den Snapshots und kosten keine Credits. Übernommen werden nur
  Märkte, die sich aus dem Endergebnis abrechnen lassen (1X2/Sieger, Handicap ohne Viertel-Linien,
  Über/Unter), jeweils von genau einem Buchmacher. Statistiken werden nicht erfunden: fehlt eine Kennzahl,
  bleibt der betroffene Markt offen (`SettlementDataError`, Log „market needs a manual result“) statt zu raten. Kontingentwächter:
  unter `ODDS_API_MIN_REMAINING` keine kostenpflichtigen Abrufe mehr, Märkte suspendiert, Provider-Status
  `DEGRADED`. Live-Märkte sind standardmäßig suspendiert (`ODDS_API_LIVE_BETTING=false`) und werden auch bei
  aktivem Live-Betrieb gesperrt, wenn der Snapshot älter als `ODDS_API_LIVE_MAX_AGE_SECONDS` ist.
- `SportsGameOddsProvider` – echte Daten aus SportsGameOdds v2 (abgerechnet pro Event-Objekt). Ein
  Snapshot aller Ligen (`finalized=false`, Zeitfenster `SGO_HORIZON_HOURS`) und – kürzer getaktet – eine
  Nachabfrage nur der laufenden, noch nicht finalisierten Spiele per `eventIDs`; unbekannte IDs (z. B. nach
  Neustart) werden gesammelt nachgeschlagen. Amerikanische Quoten werden in Dezimalquoten umgerechnet;
  ohne feste Buchmacher gilt der Konsens-Preis, Märkte ohne Buchmacher-Marge entfallen. Fußball wird auf
  die reguläre Spielzeit abgerechnet (`reg`); nach Verlängerung bleibt das Ergebnis unbestätigt (manuell).
- Gemeinsam (`providers/shared.ts`): Validierung (Linien, Marge), Markt-Freigabe (Kontingent, Live-Alter),
  Score-Statistiken ohne erfundene Details.
- `OddsSyncService` sperrt Märkte, die der Feed nicht mehr anbietet (z. B. verschobene Linie), statt sie mit
  altem Preis offen zu lassen; sie öffnen wieder, sobald der Feed sie erneut liefert.
- `ResilientOddsProvider` – Timeout, Retries mit Jitter, Circuit Breaker, gemeinsames Rate-Limit (Redis),
  Antwort-Cache und Health-Metriken für das Admin-Panel.
- `OddsSyncService` – schreibt nur Unterschiede (Batch-Updates), erhöht `oddsVersion`, veröffentlicht
  Änderungen über Redis Pub/Sub; manuelle Sperren durch Staff bleiben erhalten.

## Settlement

Ein Event mit bestätigtem Ergebnis (oder abgesagt) wird unter einem Redis-Lock abgerechnet: jede Auswahl wird
über den Marktkatalog (`MARKET_DEFINITIONS`) aus der offiziellen Statistik entschieden (Push ⇒ VOID), danach
jede betroffene Wette in einer eigenen Transaktion. Eine verlorene Auswahl entscheidet eine Kombi sofort, VOID
zählt als Quote 1,00. Idempotenz auf drei Ebenen: nur `PENDING` ändert sich, Wetten werden gesperrt und bedingt
aktualisiert, das Hauptbuch akzeptiert genau eine Abrechnungsbuchung pro Wette.

## Realtime

Der Worker veröffentlicht `odds`, `market` und `event`-Nachrichten; jede API-Instanz fächert sie per SSE an die
Browser aus (Topics `live`, `event:<id>`). Der Browser öffnet genau eine Verbindung; Komponenten melden Topics
an. Nachrichten sind Hinweise zur Anzeige – der Wettschein fragt vor dem Platzieren immer die API.

## Skalierung

- API: zustandslos, horizontal skalierbar (Sessions in PostgreSQL mit kurzem Redis-Cache).
- Worker: mehrere Instanzen möglich; Jobs laufen per Redis-Lock nur einmal gleichzeitig.
- Katalog-Lesezugriffe: kurze Redis-Caches (2–5 s), Listen ohne N+1 (Prisma-Includes, Aggregationen).
