# Architektur

## Leitgedanke

Der teuerste Fehler eines Odds-Scanners ist nicht eine verpasste Quote, sondern
ein Fehlalarm: er kostet Vertrauen und Aufmerksamkeit. Die Architektur ist
deshalb zweigeteilt — ein schneller Pfad, der jede Preisänderung sofort
verarbeitet, und eine strenge Filterkette, die entscheidet, was davon
tatsächlich gemeldet wird.

## Prozesse

| Prozess | Aufgabe | Skalierung |
|---|---|---|
| `scanner` | Quellen anzapfen, analysieren, Alarme erzeugen | eine Instanz (siehe Einschränkungen) |
| `api` | REST + WebSocket, liest nur | horizontal skalierbar |
| `telegram-bot` | Befehle und Alarmversand | eine Instanz je Bot-Token |
| `frontend` | statisches Dashboard über nginx | beliebig |

Die Prozesse teilen sich Redis und PostgreSQL, kennen einander aber nicht. Die
Kopplung läuft ausschließlich über Redis Pub/Sub.

## Der schnelle Pfad

```
Provider.stream()
   │  ProviderMessage(events=[...], quotes=[...])
   ▼
ProviderSupervisor          Reconnect, Backoff, Stillstandserkennung
   │
   ▼
asyncio.Queue (bounded)     bei Rückstau fliegt die *älteste* Nachricht raus
   │
   ├─▶ Worker 1 ─┐
   ├─▶ Worker 2 ─┤          scanner_workers, Standard 4
   └─▶ Worker N ─┘
                 │
                 ▼
        1. Event normalisieren    EventMatcher → kanonische ID
        2. Quote anwenden         Redis; unverändert ⇒ hier ist Schluss
        3. Marktbuch laden        ein Roundtrip je Markt, nicht je Quote
        4. Value Engine           Modelle A/B/C + Confidence
        5. Error-Detector         error_score 0–100
        6. Filterkette            Quote → Signal → Cooldown/Duplikat
        7. Alarm                  Redis Pub/Sub + DB-Queue
                                  + Vormerkung zur Nachkontrolle
```

Getrennt davon, im eigenen Task:

```
followup-Loop (alle FOLLOWUP_INTERVAL_SECONDS)
   │
   ├─ fällige Alarme aus dem Sorted Set holen  ein Aufruf, nicht einer je Alarm
   ├─ denselben Markt erneut aus Redis lesen   kein zusätzlicher API-Aufruf
   ├─ Urteil ableiten                          backend/core/verdict.py
   └─ Ergebnis am Alarm speichern              verdict, clv_percent, Preise
```

Bewusst außerhalb des Hot-Paths: eine Nachkontrolle darf niemals einen
aktuellen Preis verzögern.

### Warum das schnell ist

**Nur Änderungen kosten Arbeit.** Ein prozesslokaler Cache vergleicht jeden
Preis mit dem letzten bekannten. Bleibt er gleich, endet die Verarbeitung
sofort — kein Redis-Write, keine Analyse, kein Datenbankschreibvorgang. Bei
typischen Feeds ist der Großteil aller eingehenden Quoten unverändert.

**Ein Markt wird einmal geladen, nicht einmal pro Quote.** Ändern sich in einer
Nachricht zwölf Preise desselben Marktes, gibt es trotzdem nur einen
Redis-Roundtrip für das Marktbuch.

**Die Datenbank blockiert nie.** Alle Schreibvorgänge landen in einer Queue,
die ein eigener Writer-Task gebündelt abarbeitet (Standard: 200 Zeilen oder
1 Sekunde). Fällt PostgreSQL aus, läuft die Analyse weiter — nur die Historie
fehlt, und das steht im Log.

**Rückstau verwirft alte Daten, nicht neue.** Läuft die Queue voll, fliegt die
älteste Nachricht heraus. Bei Quoten ist das genau richtig: ein veralteter
Preis ist wertlos, der aktuelle ist alles.

## Zustand: Redis vs. PostgreSQL

| | Redis | PostgreSQL |
|---|---|---|
| Inhalt | *aktueller* Stand | *Historie* |
| Zugriff | Hot-Path, Millisekunden | Auswertung, Dashboard |
| Verlust verkraftbar | ja (baut sich neu auf) | nein |

Schlüsselschema:

```
alert:followup                   ZSET   Alarm → Fälligkeit der Nachkontrolle
fu:{fingerprint}                 STRING Alarmdaten für die Nachkontrolle
q:{event}:{market}:{selection}   HASH   bookmaker → Quote-JSON
midx:{event}:{market}            SET    Selektionen des Marktes
eidx:{event}                     SET    Märkte des Events
ev:{event}                       STRING Event-JSON
ev:live                          SET    laufende Events
ph:{provider}                    STRING Provider-Health
cd:* / dup:*                     STRING Cooldown / Duplikat (SET NX EX)
```

## Provider-Schnittstelle

```python
class OddsProvider(ABC):
    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def get_events(self) -> list[EventSnapshot]: ...
    async def get_odds(self) -> list[OddsQuote]: ...

    async def stream(self) -> AsyncIterator[ProviderMessage]:
        """Standard: asynchrones Polling. Push-Adapter überschreiben das."""
```

Die Basisklasse pollt im `poll_interval`-Takt. Push-fähige Quellen
überschreiben `stream()` und liefern Nachrichten ohne Wartezeit — der
MockProvider zeigt das mit einer Producer-Task und einer internen Queue.

**Vertrag:** Adapter liefern ihre *eigenen* Event-IDs. Die kanonische,
providerübergreifende ID vergibt allein der Scanner. Adapter erfinden niemals
Felder — was eine Quelle nicht liefert, bleibt `None`.

## Zeitstempel

Eine Quote trägt drei:

| Feld | Bedeutung | Verwendet für |
|---|---|---|
| `ts` | seit wann dieser *Preis* gilt | Bewegungsanalyse, Standzeit |
| `confirmed_at` | wann wir ihn zuletzt *gesehen* haben | alle Stale-Filter |
| `received_at` | Eingang dieser Nachricht | Latenzmessung |

Die Trennung von `ts` und `confirmed_at` ist wesentlich. Ein *vergessener*
Fehlpreis ändert sich definitionsgemäß nie. Würde man ihn über `ts` altern
lassen, fiele genau der interessanteste Fall aus dem Stale-Filter heraus.
Unveränderte Preise werden deshalb höchstens alle `QUOTE_REFRESH_SECONDS` in
Redis bestätigt — das hält den Hot-Path schlank und die Aktualität korrekt.

## Vorreiter und Nachzügler

Die zentrale Unterscheidung im Live-Betrieb:

```
t0   Markt: 2.40 2.45 2.50 2.42   ← ruhig
t1   TOR
t2   MockExchange springt auf 8.00, Rest steht noch
        → Median unverändert, eigener Sprung riesig
        → dieses Buch FÜHRT die Bewegung an     → kein Alarm
t3   Rest zieht nach: 7.80 8.10 7.95
t4   ein Buch steht immer noch bei 2.42
        → Markt hat sich bewegt, dieses Buch nicht
        → vergessene Quote                       → ALARM
```

Weil ein stehen gebliebenes Buch von sich aus keine Nachricht erzeugt, prüft
der Scanner bei jeder erkannten Marktbewegung zusätzlich **alle unveränderten**
Bücher der betroffenen Quotenzeile. Sie bekommen einen synthetischen
`OddsChange` ohne Vorpreis.

## Fehlerverhalten

| Ausfall | Reaktion |
|---|---|
| Provider trennt | Supervisor reconnectet mit Full-Jitter-Backoff (0,5 s → 60 s) |
| Provider sendet nichts mehr | nach `stall_timeout` gilt die Verbindung als tot |
| Zugangsdaten ungültig | Provider wird dauerhaft deaktiviert (Reconnect wäre zwecklos), Grund steht im Health-Endpunkt |
| Rate-Limit | `Retry-After` wird beachtet, sonst Backoff |
| Redis weg | Scanner beendet sich, Docker startet neu |
| PostgreSQL weg | Scanner läuft weiter, Historie pausiert |
| Telegram weg | Alarme laufen weiter in Dashboard und API |
| Queue voll | älteste Nachricht wird verworfen, Metrik zählt mit |

## Metriken

`GET /metrics` (Prometheus):

```
storm_quotes_received_total{provider}
storm_quotes_changed_total{provider}
storm_quotes_dropped_total{reason}
storm_alerts_emitted_total{kind,sport}
storm_alerts_suppressed_total{reason}      ← zeigt, welcher Filter greift
storm_provider_reconnects_total{provider}
storm_pipeline_latency_seconds             ← Empfang bis Analyse fertig
storm_analysis_latency_seconds             ← reine Rechenzeit
storm_queue_depth
storm_live_events / storm_tracked_events
storm_provider_up{provider}
storm_ws_clients
```

`storm_alerts_suppressed_total` ist beim Einstellen der Schwellen die
nützlichste Metrik: sie zeigt, welcher Filter wie oft greift.
