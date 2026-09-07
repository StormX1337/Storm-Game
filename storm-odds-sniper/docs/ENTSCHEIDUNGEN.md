# Technische Entscheidungen

Was warum so gebaut ist — inklusive der Alternativen, die verworfen wurden.

## Warum Dataclasses im Hot-Path und Pydantic nur an der API-Grenze

Der Scanner erzeugt zehntausende Quotenobjekte pro Minute. Pydantic validiert
bei jeder Instanziierung; das ist an einer HTTP-Grenze richtig und im
Hot-Path Verschwendung. `dataclass(slots=True)` spart Zeit und Speicher.

Pydantic gibt es deshalb nur in `backend/models/schemas.py` — dort erzeugt es
zugleich die OpenAPI-Dokumentation.

## Warum die eigene Quote nie in ihre eigene Referenz einfließt

Ein Fehlpreis würde sonst seine eigene Bewertung mitziehen und dadurch
kleiner aussehen, als er ist. `fair_odds(..., exclude_bookmaker=...)` ist
deshalb Pflicht, nicht Option.

## Warum drei Fair-Odds-Modelle statt eines

Jedes hat eine bekannte Schwäche:

- **Median** ist robust gegen Ausreißer, enthält aber die Marge.
- **Margin-Bereinigung** braucht ein vollständiges Buch — bei Teilmärkten
  nicht verfügbar.
- **Gewichteter Konsens** ist am nächsten am „wahren" Preis, hängt aber an der
  Gewichtstabelle.

Der Mix ist stabiler als jedes einzelne Modell, und die Spannweite zwischen
den Modellen ist selbst ein Qualitätssignal: laufen sie auseinander, sinkt die
Confidence.

## Warum `proportional` als Standard der Margin-Bereinigung

Die multiplikative Methode ist stabil und nie negativ. Die additive
(`equal_margin`) ist bei Außenseitern oft realistischer, kann aber bei sehr
hohen Quoten negative Wahrscheinlichkeiten erzeugen — dann fällt die
Implementierung automatisch auf proportional zurück. Umschaltbar über
`EngineConfig.margin_method`.

## Warum Double Chance nicht margenbereinigt wird

Die drei Selektionen überlappen sich und summieren sich auf 2, nicht auf 1.
Eine Margin-Bereinigung über das „ganze Buch" wäre schlicht falsch. Solche
Märkte stehen deshalb nicht in `COMPLETE_BOOK_MARKETS` und nutzen nur das
Median-Modell.

## Warum nur positive Abweichungen Alarm auslösen

Eine zu *niedrige* Quote ist zwar auch ein Fehler, aber nicht spielbar. Der
Error-Detector gibt dort Score 0 zurück.

## Warum Confidence auch für Fehlpreis-Alarme gilt

Naheliegend wäre: ein Fehlpreis ist ein Fehlpreis, egal wie sicher die
Referenz ist. In der Praxis ist eine faire Quote mit Confidence 40 aber
schlicht kein belastbarer Vergleichsmaßstab — die daraus abgeleitete
„Abweichung von +200 %" ist dann Modellrauschen. Deshalb greift
`MIN_CONFIDENCE` bei beiden Alarmarten. Wer Fehlpreise auch in dünnen Märkten
sehen will, senkt den Wert bewusst.

## Warum eine Vorreiter-Unterdrückung

Ohne sie produziert der Scanner im Live-Betrieb systematisch Fehlalarme:
Nach einem Tor springt das schnellste Buch zuerst, der Rest steht noch — und
das schnellste Buch sieht dann wie ein grober Fehlpreis aus, obwohl es das
einzig korrekte ist.

Die Regel: springt ein Buch um mehr als `MARKET_SHOCK_PERCENT`, ohne dass der
Markt-Median mindestens halb so weit gefolgt ist, führt es die Bewegung an —
kein Alarm. Das ist eine Heuristik und kann einen echten Tippfehler
verschlucken, der zufällig mit einer Marktbewegung zusammenfällt. Der
Kompromiss ist bewusst zugunsten der Alarmqualität gewählt und einstellbar.

## Warum unveränderte Quoten aktiv geprüft werden

Der klassische Fehlpreis ist eine *vergessene* Quote: sie ändert sich nie und
erzeugt deshalb auch keine Nachricht. Ein rein änderungsgetriebener Scanner
findet sie prinzipiell nicht.

Deshalb: bewegt sich der Markt-Median einer Quotenzeile spürbar, werden auch
alle **unveränderten** Bücher dieser Zeile geprüft. Sie bekommen einen
synthetischen `OddsChange` ohne Vorpreis.

## Warum eine Quote drei Zeitstempel hat

Aus demselben Grund. Würde die Datenaktualität über `ts` (Zeitpunkt der
letzten Preisänderung) bestimmt, wäre eine stehen gebliebene Quote nach
zehn Sekunden „veraltet" und fiele aus dem Filter — genau die interessanteste.

`confirmed_at` (wann zuletzt gesehen) und `ts` (seit wann dieser Preis gilt)
sind deshalb getrennt. Unveränderte Preise werden höchstens alle
`QUOTE_REFRESH_SECONDS` in Redis bestätigt: korrekt, ohne den Hot-Path mit
Schreibvorgängen zu fluten.

## Warum ein Cooldown *und* eine Duplikaterkennung

Sie lösen verschiedene Probleme. Der Cooldown begrenzt die Frequenz je
Quotenzeile und Buchmacher. Die Duplikaterkennung nutzt zusätzlich einen
logarithmischen Preis-Bucket: derselbe Alarm mit praktisch gleichem Preis ist
ein Duplikat, ein deutlich veränderter Preis ist ein neues Signal — auch
innerhalb des Cooldowns.

## Warum der Event-Matcher Heim/Auswärts spiegeln kann

Anbieter führen Paarungen unterschiedlich herum. Ohne Erkennung würde ein
Heim- gegen einen Auswärtspreis verglichen — der denkbar schlechteste
Fehlalarm, weil er plausibel aussieht. Bei erkannter Spiegelung werden
Selektion *und* Handicap-Linie gedreht.

## Warum Redis *und* PostgreSQL

Getrennte Aufgaben: Redis hält den aktuellen Zustand (Millisekunden, Verlust
verkraftbar), PostgreSQL die Historie (dauerhaft, für Auswertung). Beides in
eine Datenbank zu legen hieße, entweder den Hot-Path zu verlangsamen oder die
Historie zu verlieren.

## Warum ein prozesslokaler Preis-Cache

Die Änderungserkennung ohne Redis-Roundtrip zu machen spart pro unveränderter
Quote eine Netzwerkrunde — bei typischen Feeds ist das der Großteil. Preis:
nach einem Scanner-Neustart hat die erste Quote je Zeile keinen Vorpreis. Das
ist dokumentiert und harmlos.

## Warum bei Rückstau die *älteste* Nachricht verworfen wird

Bei Quoten ist ein veralteter Preis wertlos, der aktuelle ist alles. Die Queue
verwirft deshalb vorne, nicht hinten — und zählt es in
`storm_quotes_dropped_total{reason="queue_full"}` mit.

## Warum ein Auth-Fehler den Provider dauerhaft deaktiviert

Ein fehlender API-Key wird durch Wiederholen nicht besser. Statt endlos zu
reconnecten, markiert der Supervisor den Provider als `disabled` und schreibt
den Grund in die Health-Meldung — dort sieht ihn der Nutzer im Dashboard.

Der Status wird bewusst **nach** dem `disconnect()` gesetzt, sonst
überschriebe `mark_disconnected()` den Grund und das Dashboard zeigte
„getrennt" statt „deaktiviert: Key fehlt".

## Warum in nginx kein location-Block eigene add_header setzt

Eine Falle der nginx-Semantik: `add_header` wird von der übergeordneten Ebene
**nur dann** geerbt, wenn der aktuelle Block selbst *kein* `add_header`
definiert. Ein einzelnes `add_header Cache-Control` im `location /`-Block
hatte deshalb sämtliche Security-Header — inklusive CSP — von der HTML-Seite
entfernt, also genau dort, wo sie am wichtigsten sind. Der Fehler war im
Browser nur daran zu erkennen, dass die Header fehlten; funktional lief alles.

Deshalb stehen jetzt **alle** gemeinsamen Header auf Server-Ebene, und kein
`location`-Block setzt eigene — mit einer bewusst dokumentierten Ausnahme für
die Doku-Pfade, die eine gelockerte CSP brauchen.

Aus demselben Grund nutzt `/healthz` `default_type` statt
`add_header Content-Type`: Letzteres hätte den Header doppelt gesendet.

## Warum die API dieselben Header nochmal setzt

Sie ist im Compose-Setup zusätzlich auf `127.0.0.1:8000` erreichbar, also ohne
nginx davor. Damit auch dieser Weg abgesichert ist, setzt die Middleware die
Header selbst. Auf dem Weg durch nginx würden sie dadurch doppelt erscheinen —
und widersprüchliche Mehrfachangaben werden von Browsern teilweise ganz
ignoriert. Deshalb blendet nginx die drei Header der Anwendung per
`proxy_hide_header` aus und setzt seine eigenen.

## Warum das Dashboard keine Inline-Styles benutzt

Die Content-Security-Policy erlaubt `style-src 'self'` ohne `'unsafe-inline'`.
Ein `style="width:…"` im generierten HTML wurde deshalb blockiert und die
Confidence-Balken blieben leer. Die Breite wird jetzt nach dem Rendern über
`element.style.width` gesetzt — das ist CSSOM-Zugriff und fällt nicht unter
`style-src`. Die Policy konnte so streng bleiben.

## Warum das Dashboard ohne Framework auskommt

Eine Seite, ein WebSocket, sechs Panels. React oder Vue hätten einen
Build-Schritt, eine `node_modules`-Kette und ein Bundle im Container zur Folge
— für diesen Umfang mehr Aufwand als Nutzen. Die Seite lädt keine externen
Skripte oder Schriften und funktioniert deshalb auch ohne Internetzugang im
Container. Die Content-Security-Policy kann entsprechend streng bleiben.

## Warum ein einziges Docker-Image für drei Dienste

`api`, `scanner` und `telegram-bot` teilen denselben Code und dieselben
Abhängigkeiten. Ein Image, drei Kommandos: kürzere Buildzeit, weniger
Registry-Platz und garantiert identische Abhängigkeiten in allen dreien.

## Warum PostgreSQL und Redis keine Host-Ports haben

Sie werden ausschließlich innerhalb des Compose-Netzes gebraucht. Ein
veröffentlichter Port wäre reine Angriffsfläche. Die API ist aus demselben
Grund nur auf `127.0.0.1` gebunden — nach außen geht nur das Dashboard.

## Warum BRIN-Indizes für die Zeitreihen

`odds_snapshots.ts` und `odds_changes.ts` wachsen streng monoton. Ein
BRIN-Index kostet dort einen Bruchteil eines B-Trees und reicht für
Zeitfenster-Abfragen völlig aus. Angelegt werden sie per Roh-SQL in der
Migration; `alembic check` blendet sie über `include_object` aus, damit sie
nicht bei jedem Lauf als „zu entfernen" gemeldet werden.

## Warum Provider-Dateien sprechende Namen tragen

Die Aufgabenstellung nannte `provider_1.py` und `provider_2.py`. Nach einem
halben Jahr sagt `the_odds_api.py` mehr als `provider_1.py`, und die Registry
stellt die Austauschbarkeit ohnehin sicher. Zuordnung:
`provider_1 = the_odds_api`, `provider_2 = betfair_exchange`.

## Warum der Mock so ausführlich ist

Er ist kein Platzhalter, sondern das Testinstrument: mit ihm laufen Streaming,
inkrementelle Verarbeitung, Value Engine, Fehlerdetektor, Cooldown, Telegram
und Dashboard end-to-end ohne einen einzigen API-Key. Zwei echte Fehler im
Scanner sind zuerst im Mock-Betrieb aufgefallen.

Damit er nicht mit echten Daten verwechselt wird, tragen alle Namen das
Präfix `Mock`.
