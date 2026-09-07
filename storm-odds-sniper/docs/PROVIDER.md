# Datenquellen

Welche Quelle liefert was — und was sie **nicht** liefert.

## Überblick

| Provider | Art | Zugangsdaten | Live-Details | Latenz |
|---|---|---|---|---|
| `mock` | Push (Simulation) | keine | vollständig (simuliert) | ~0,3 s |
| `the_odds_api` | REST-Polling | API-Key | nur Spielstand | Poll-Intervall |
| `betfair` | JSON-RPC-Polling | Konto + App-Key | Live-Kennzeichen | ~1 s |

Auswahl über `PROVIDERS` (kommagetrennt, mehrere parallel).

---

## mock — MockProvider

**Zweck:** das komplette System ohne Zugangsdaten testbar machen.

Simuliert werden Fußball (Minute, Spielstand, Halbzeiten, rote Karten,
kurze Suspendierungen) und Tennis (Sätze, Games, Punkte, Aufschlag), dazu
mehrere Buchmacher mit eigener Marge, eigenem Bias und eigenem Update-Takt
sowie gelegentliche Fehlpreise.

Die Fußball-Wahrscheinlichkeiten stammen aus einem Poisson-Modell über die
Restspielzeit: fällt ein Tor, bewegt sich der ganze Markt realistisch. Tennis
nutzt ein bewusst einfacheres Modell aus Grundstärke plus Führungsbonus.

Beendete Partien werden automatisch durch neue ersetzt, damit auch nach
Stunden noch etwas live ist. Dabei wird darauf geachtet, dass nie zwei Events
mit derselben Paarung gleichzeitig laufen — der EventMatcher würde sie sonst
(korrekterweise) zu einem Event zusammenführen und ihre Quoten vermischen.

**Wichtig:** Alle Namen tragen das Präfix `Mock`. Es werden keine echten
Buchmacherquoten nachgebildet oder behauptet.

```env
PROVIDERS=mock
MOCK_TICK_INTERVAL=0.35
MOCK_EVENTS=8
MOCK_BOOKMAKERS=7
MOCK_ERROR_PROBABILITY=0.02
MOCK_SEED=42          # reproduzierbarer Verlauf
```

---

## the_odds_api — The Odds API

**Dokumentation:** <https://the-odds-api.com/liveapi/guides/v4/>
**Registrierung:** <https://the-odds-api.com>

Genutzte Endpunkte:

| Endpunkt | Zweck |
|---|---|
| `GET /v4/sports` | verfügbare Sport-Keys |
| `GET /v4/sports/{sport}/odds` | Quoten mehrerer Buchmacher je Event |
| `GET /v4/sports/{sport}/scores` | Spielstände inkl. Live-Kennzeichnung |

Marktzuordnung:

| API | Fußball | Tennis |
|---|---|---|
| `h2h` | 1X2 | Match Winner |
| `spreads` | Asian Handicap | Game Handicap |
| `totals` | Over/Under | Over/Under Games |
| `btts` | Both Teams To Score | — |
| `draw_no_bet` | Draw No Bet | — |
| `double_chance` | Double Chance | — |

Bei `spreads` trägt jede Selektion ihren eigenen Punktwert (Heim −1.0,
Auswärts +1.0). Als Marktschlüssel gilt der **Heimwert**, damit beide Seiten in
dasselbe Buch fallen — sonst wäre das Buch nie vollständig und die
Margin-Bereinigung könnte nicht greifen.

### Kontingent

Eine Quotenabfrage kostet `Märkte × Regionen` Credits. Der Restwert steht im
Header `x-requests-remaining` und wird im Dashboard angezeigt. Unterhalb von
`ODDS_API_MIN_REMAINING` pausiert der Adapter selbstständig für eine Stunde.

| Konfiguration | Kosten je Abruf | bei 20 s Takt |
|---|---|---|
| 3 Märkte × 2 Regionen | 6 | ~25 900/Tag |
| 1 Markt × 1 Region | 1 | ~4 300/Tag |

Das kostenlose Kontingent (500/Monat) reicht damit nicht für Live-Scans.

### Was diese Quelle nicht liefert

- kein WebSocket/Streaming
- keine Spielminute, keine Halbzeit, keine Karten
- keine Tennis-Games, -Punkte oder Aufschlaginformation

Diese Felder bleiben `None`. Sie werden **nicht** geschätzt.

---

## betfair — Betfair Exchange

**Dokumentation:** <https://developer.betfair.com/en/get-started/>

Genutzte Endpunkte (ausschließlich offizielle API, kein Scraping):

| Endpunkt | Zweck |
|---|---|
| `POST /api/certlogin` bzw. `/api/login` | Session |
| `POST /api/keepAlive` | Session verlängern |
| `SportsAPING/v1.0/listMarketCatalogue` | Märkte, Namen, Runner |
| `SportsAPING/v1.0/listMarketBook` | Preise und verfügbare Beträge |

Verwendet wird der beste **Back**-Preis (`ex.availableToBack[0]`) mit der
verfügbaren Summe als Liquidität. Lay-Preise bleiben außen vor — sie sind für
den Vergleich gegen Buchmacher nicht aussagekräftig.

Marktcode-Zuordnung:

| Betfair | intern |
|---|---|
| `MATCH_ODDS` | 1X2 (Fußball) / Match Winner (Tennis) |
| `OVER_UNDER_25` | Over/Under 2.5 |
| `BOTH_TEAMS_TO_SCORE` | BTTS |
| `DOUBLE_CHANCE` | Double Chance |
| `DRAW_NO_BET` | Draw No Bet |
| `ASIAN_HANDICAP` / `HANDICAP` | Handicap (Linie aus `runner.handicap`) |
| `SET_WINNER` | Set Winner |
| alles andere | `OTHER` — durchgereicht, **nicht geraten** |

### Warum eine Börse wertvoll ist

Praktisch keine Marge, und die verfügbaren Beträge sind ein echter
Liquiditätsindikator statt einer Schätzung. Die Value Engine gewichtet Börsen
deshalb mit Faktor 2,4 gegenüber 1,0 für unbekannte Bücher.

### Was diese Quelle nicht liefert

Die Betting-API kennt keine Spielminute und keine Tennis-Punktdetails. Der
Live-Status kommt aus `marketBook.inplay` und `marketBook.status`.

### Betfair Stream API

Betfair bietet zusätzlich eine Stream API (TLS-Socket mit zeilengetrenntem
JSON, kein WebSocket). Sie ist hier **bewusst nicht implementiert**: ohne Konto
nicht testbar, und ungetestetes Delta-Merging in einem Low-Latency-Pfad wäre
ein Risiko. Der JSON-RPC-Adapter deckt dieselben Daten mit etwas höherer
Latenz ab.

Wer sie ergänzen will, braucht nur einen neuen Adapter mit überschriebenem
`stream()` — die Pipeline dahinter bleibt unverändert.

---

## Einen eigenen Provider bauen

```python
from backend.providers.base import OddsProvider

class MeinProvider(OddsProvider):
    name = "meine_quelle"
    supports_streaming = True          # bei Push
    poll_interval = 5.0                # bei Pull

    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def get_events(self) -> list[EventSnapshot]: ...
    async def get_odds(self) -> list[OddsQuote]: ...

    async def stream(self):            # optional, bei Push
        while not self.stopping:
            yield ProviderMessage(provider=self.name, quotes=[...])
```

Dann in `backend/providers/registry.py` eintragen:

```python
FACTORIES["meine_quelle"] = _make_meine_quelle
PROVIDER_SPECS["meine_quelle"] = ProviderSpec(...)
```

Drei Regeln:

1. **Eigene Event-IDs verwenden.** Die kanonische ID vergibt der Scanner.
2. **Nichts erfinden.** Was die Quelle nicht liefert, bleibt `None`.
3. **Nur erlaubte Quellen.** Kein Scraping hinter Login, kein CAPTCHA-Bypass.
