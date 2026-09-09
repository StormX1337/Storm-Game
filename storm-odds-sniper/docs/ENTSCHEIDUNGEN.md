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

## Warum jeder Alarm nachkontrolliert wird

Ein Alarm ist eine Behauptung. Ohne Gegenprobe bleibt sie unüberprüft, und
das System kann beliebig schlecht sein, ohne dass es auffällt — der
Alarm-Stream sieht in beiden Fällen gleich aus.

Die Nachkontrolle nutzt ausschließlich Daten, die ohnehin einlaufen: nach
`FOLLOWUP_AFTER_SECONDS` wird derselbe Marktzustand noch einmal aus Redis
gelesen. Damit kostet die Bilanz **keinen** API-Aufruf — beim Gratis-Tarif
mit rund 17 Abrufen pro Tag wäre alles andere nicht tragbar.

## Warum die Richtung entscheidet und nicht der Betrag

Die erste Fassung schrieb die geschlossene Lücke derjenigen Seite zu, die
sich *stärker* bewegt hatte. Der Testlauf gegen echte Daten zeigte, warum das
falsch ist: Value-Alarme kamen auf 13 „korrigiert" bei einem
durchschnittlichen CLV von **−2,2 %**. Ein Urteil, das die eigenen Zahlen
widerlegen.

Der Fall dahinter: der Buchmacher fällt von 2.50 auf 2.20 (−12 %), während
der Markt von 2.30 auf 2.55 steigt (+11 %). Der Betrag spricht für den
Buchmacher, aber der Markt ist über den gemeldeten Preis *hinweggezogen* —
2.50 lag am Ende unter dem Konsens von 2.55. Es gab nie einen Vorteil.

Deshalb jetzt: nur ein **fallender** Buchmacher hat korrigiert, nur ein
**steigender** Markt ist nachgezogen, und wenn beides zutrifft, entscheidet
der CLV. „Korrigiert" hat damit eine Zusage, die ein Test festhält: es
schlägt immer den späteren Markt.

## Warum „offen" nie als Treffer zählt

Fehlen Folgedaten (Kontingent aufgebraucht, Event vorbei, Redis-Zustand
abgelaufen), gibt es kein Urteil — kein geratenes und erst recht kein
positives. `pending` und `unresolved` stehen getrennt in der Bilanz. Eine
Trefferquote, die stillschweigend über fehlende Daten hinwegrechnet, wäre
genau die Art von Zahl, die gut aussieht und nichts bedeutet.

## Warum CLV und keine Trefferquote gegen das Spielergebnis

Der naheliegende Wunsch wäre: hat die Wette gewonnen? Dafür bräuchte es
zuverlässige Endergebnisse aller Events — eine weitere Datenquelle, weitere
Abrufe, und selbst dann sagt eine Stichprobe von ein paar hundert Wetten
statistisch fast nichts, weil die Varianz einzelner Ergebnisse alles
überdeckt.

Der Closing Line Value braucht nichts davon und konvergiert erheblich
schneller. Er ist aber ausdrücklich **kein Gewinn**, und genau so steht es an
jeder Stelle, an der die Zahl auftaucht — README, Dashboard, Telegram und
API-Beschreibung.

## Warum Urteile auf ihren Alarm warten dürfen

Alarm und Nachkontrolle schreiben nicht im selben Takt: der Alarm geht in die
gebündelte Writer-Queue, die Nachkontrolle läuft Minuten später in einem
eigenen Task. Unter Last liegt der Writer zurück — dann trifft das Urteil auf
eine Zeile, die es noch nicht gibt.

Im Lasttest war das kein Randfall: 676 berechnete Urteile standen 54
tatsächlich geschriebenen gegenüber. Das `UPDATE` traf nichts, meldete nichts,
und das Ergebnis war weg. Ein Urteil, das im Prometheus-Zähler steht, aber
nicht am Alarm, ist genau die Art stiller Datenverlust, die man erst Wochen
später bemerkt.

Deshalb meldet `resolve_alerts()` jetzt die nicht zuordenbaren
Fingerabdrücke zurück, und der Scanner hebt diese Urteile auf und versucht es
erneut. Das Urteil selbst steht schon fest — nur der Schreibvorgang wird
wiederholt, nie die Bewertung: eine spätere Neubewertung würde gegen einen
anderen Markt messen. Nach `WRITE_ATTEMPTS` Versuchen wird aufgegeben, mit
einer Warnung im Log statt stillem Verlust.

## Warum das Dashboard jede Abfrage einzeln behandelt

Es hing an einem `Promise.all`. Nach einem `git pull` ohne `--build` kannte
die alte API `/alerts/scorecard` noch nicht, antwortete mit 404 - und dieses
eine 404 riss alle fünf anderen Abfragen mit. Sichtbar war: „Live verbunden"
oben, darunter jede Kachel auf „Lade…". Die Daten für Datenquellen,
Buchmacher und Systemstatus lagen fertig vor und wurden weggeworfen.

Jetzt `Promise.allSettled`, jede Kachel rendert aus ihrer eigenen Antwort.
Ein 404 auf einem bekannten Endpunkt ist zudem ein eindeutiges Zeichen für
unterschiedlich alte Teile und wird als solches gemeldet - mit dem Befehl,
der es behebt. Ein leeres Dashboard ohne Erklärung sieht aus wie ein kaputtes
System; es war nur ein vergessenes `--build`.

Nebenbei aufgefallen: `.banner { display: flex }` schlägt das
`[hidden]`-Attribut des Browsers. Kein Banner ließ sich dadurch ausblenden -
es fiel nur lange nicht auf.

## Warum die Simulation ganz entfernt wurde

Sie hatte einen klaren Zweck: das System ohne Zugangsdaten ausprobieren zu
können. Der Preis dafür stellte sich als zu hoch heraus.

Die Simulation tickte alle 0,35 s und erzeugte absichtlich Fehlpreise, eine
echte Quelle liefert im Vergleich ein paar Preise pro Minute. Nebeneinander
war das Verhältnis etwa tausend zu eins - die Alarmliste bestand praktisch nur
aus Erfundenem, obwohl echte Daten flossen. Auf dem Bildschirm unterschieden
sich beide nur durch ein kleines 🧪. Dazu kam ein Fallback, der die Simulation
startete, sobald keine echte Quelle hochkam: eine vergessene Zugangsdatei sah
damit aus wie ein prima laufendes System voller überzeugender Funde.

Beides ließ sich abmildern (Warnungen, ein Abschaltskript, kein Fallback mehr),
aber die Grundspannung blieb: ein Werkzeug, das echte Fehlpreise von Rauschen
trennen soll, sollte nicht selbst überzeugendes Rauschen herstellen. Mit einem
bezahlten Zugang entfällt auch der ursprüngliche Zweck.

Verloren geht damit: das Ausprobieren ohne Zugangsdaten, und Tests, die die
Kette über den Simulator geführt haben. Die zwei Stellen, an denen der Scanner
eine laufende Quelle braucht, decken jetzt ein paar Zeilen Stub im Testcode ab
(`StubStreamProvider`) - der landet nicht im Auslieferungsstand.

## Warum der Adapter sein eigenes Anfragelimit rechnet

Ein Tarif nennt Anfragen pro Minute, konfiguriert wird aber ein Poll-Takt in
Sekunden. Dazwischen liegt die Seitenzahl: ein Durchlauf kostet
`SGO_MAX_PAGES` Anfragen, nicht eine. Wer `SGO_POLL_INTERVAL=1` und
`SGO_MAX_PAGES=10` setzt, landet bei 600 Anfragen pro Minute - und ein
Provider in Dauer-429 findet gar nichts mehr.

Deshalb rechnet `next_poll_delay()` die Untergrenze aus
`60 * seiten / limit` und setzt den Takt notfalls hoch. Der gewünschte Wert
gilt, solange er darüber liegt; ein zu gieriger wird stillschweigend
gedrosselt und beim Start mit der tatsächlichen Rate geloggt.

## Warum in nginx kein statischer upstream-Block mehr steht

Das Dashboard lieferte stundenlang 502 auf jeden `/api`-Pfad, während die API
im Container einwandfrei mit 200 antwortete und `docker compose ps` sie als
`healthy` führte. Im nginx-Log stand eine IP, die es nicht mehr gab.

nginx (OSS) löst Servernamen in einem `upstream`-Block **einmal beim Start**
auf. Jedes `docker compose up -d --build` erstellt den api-Container neu, er
bekommt eine neue IP im Compose-Netz - und nginx, das gar nicht neu gestartet
wurde, verbindet weiter zur alten. Der frontend-Container war 18 Stunden alt,
api 47 Sekunden.

Heimtückisch daran: jede naheliegende Prüfung sagt "alles in Ordnung". Der
Container ist gesund, `wget http://api:8000/health` aus demselben Container
funktioniert (frische Auflösung), nur nginx selbst hat die alte IP. Genau
diese Diskrepanz - "nginx erreicht die API: ja" neben "502 von außen" - war
im Diagnosebericht der entscheidende Hinweis.

Behoben, indem der Name in einer Variablen steht: enthält `proxy_pass` eine
Variable, löst nginx sie bei jeder Anfrage über den `resolver` auf. Der
`upstream`-Block entfällt und damit auch dessen Keepalive - im Docker-Netz
kostet ein Verbindungsaufbau nichts, ein stundenlang totes Dashboard schon.

Der Nameserver kommt aus der `/etc/resolv.conf` des Containers (im
Docker-Netz 127.0.0.11) und wird von `05-resolver.sh` beim Start
geschrieben. Ist die Datei nicht lesbar, greift 127.0.0.11 als Rückfall -
ohne `resolver`-Direktive startet nginx sonst gar nicht, und ein Dashboard,
das überhaupt nicht mehr hochkommt, wäre der schlechtere Ausgang.

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

