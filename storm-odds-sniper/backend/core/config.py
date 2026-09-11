"""Zentrale Konfiguration.

Alle Werte kommen aus Umgebungsvariablen bzw. aus einer ``.env``-Datei.
Es gibt bewusst keine Default-Secrets im Code: fehlen Zugangsdaten, wird der
betroffene Provider deaktiviert und das im Log vermerkt.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ------------------------------------------------------------------ app
    app_name: str = "Storm Odds Sniper"
    app_version: str = "1.0.0"
    environment: str = Field(default="development")
    log_level: str = Field(default="INFO")
    log_json: bool = Field(default=True)

    # ------------------------------------------------------------- database
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "storm"
    postgres_user: str = "storm"
    postgres_password: str = ""
    database_url: str | None = None
    db_pool_size: int = 10
    db_max_overflow: int = 10
    db_echo: bool = False

    # ---------------------------------------------------------------- redis
    redis_url: str = "redis://redis:6379/0"
    redis_max_connections: int = 50

    # ------------------------------------------------------------- telegram
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    telegram_admin_ids: str = ""
    telegram_parse_mode: str = "HTML"

    # ------------------------------------------------------------ providers
    # Kommaseparierte Liste aktiver Provider, z. B. "sportsgameodds"
    # oder "sportsgameodds,betfair". Leer = keine Quelle; der Scanner läuft
    # dann, findet nichts und schreibt den Grund ins Log. Es gibt bewusst
    # keine Ersatzquelle, die Daten erfinden könnte.
    providers: str = ""

    # The Odds API (https://the-odds-api.com) - echter REST-Anbieter, Key nötig.
    odds_api_key: str = ""
    odds_api_base_url: str = "https://api.the-odds-api.com/v4"
    odds_api_regions: str = "eu,uk"
    #: Leer = die aktuell laufenden Fußball-/Tennis-Wettbewerbe werden über
    #: /v4/sports ermittelt. Feste Keys veralten (z. B. gilt ein Australian-
    #: Open-Key nur im Januar), deshalb ist die Ermittlung der Standard.
    odds_api_sports: str = ""
    odds_api_markets: str = "h2h,spreads,totals"
    odds_api_poll_interval: float = 20.0
    odds_api_odds_format: str = "decimal"
    odds_api_use_scores: bool = True
    odds_api_scores_interval: float = 30.0
    #: Unterhalb dieses Restkontingents pausiert der Provider (Quota-Schutz).
    odds_api_min_remaining: int = 5
    #: Takt automatisch so wählen, dass das Restkontingent bis Monatsende
    #: reicht. Ohne das ist ein Gratiskontingent in einer halben Stunde weg.
    odds_api_pace_to_quota: bool = True
    odds_api_quota_reserve: int = 20
    #: Wie viele laufende Wettbewerbe maximal abgefragt werden. Jeder Key
    #: kostet pro Durchlauf eigene Credits.
    odds_api_max_discovered_sports: int = 4

    # SportsGameOdds (https://sportsgameodds.com) - REST mit echtem Live-Filter.
    # Schema aus der offiziellen, OpenAPI-generierten SDK übernommen.
    sgo_api_key: str = ""
    sgo_base_url: str = "https://api.sportsgameodds.com/v2"
    #: Leer = über sportID gefiltert. Konkrete Ligen (z. B. "EPL,BUNDESLIGA")
    #: sparen Kontingent, weil weniger Events zurückkommen.
    sgo_leagues: str = ""
    sgo_sport_ids: str = "SOCCER,TENNIS"
    #: true = ausschließlich laufende Events. Genau dafür ist diese Quelle da.
    sgo_live_only: bool = False
    #: Poll-Takt. Der Pro-Tarif erlaubt 300 Anfragen/Minute und aktualisiert
    #: schneller als einmal pro Minute - fünf Sekunden je Seite liegen weit
    #: darunter (siehe ``requests_per_minute()``).
    sgo_poll_interval: float = 5.0
    #: Jede Seite ist ein eigener Abruf - hier begrenzt sich der Verbrauch.
    sgo_max_pages: int = 3
    sgo_page_limit: int = 100
    #: Anfragen pro Minute, die der Tarif zulässt. Der Adapter drosselt sich
    #: selbst darauf; 0 = keine Drosselung.
    sgo_rate_limit_per_minute: int = 300
    #: Optional auf bestimmte Buchmacher einschränken (kommagetrennt).
    sgo_bookmakers: str = ""

    # Betfair Exchange (https://developer.betfair.com) - App-Key + Session nötig.
    betfair_app_key: str = ""
    betfair_username: str = ""
    betfair_password: str = ""
    betfair_cert_file: str = ""
    betfair_key_file: str = ""
    betfair_identity_url: str = "https://identitysso-cert.betfair.com/api/certlogin"
    betfair_keepalive_url: str = "https://identitysso.betfair.com/api/keepAlive"
    betfair_api_url: str = "https://api.betfair.com/exchange/betting/json-rpc/v1"
    betfair_stream_host: str = "stream-api.betfair.com"
    betfair_stream_port: int = 443
    betfair_use_stream: bool = True
    betfair_poll_interval: float = 1.0
    betfair_catalogue_interval: float = 60.0
    betfair_keepalive_interval: float = 600.0
    betfair_event_type_ids: str = "1,2"  # 1 = Soccer, 2 = Tennis
    betfair_market_types: str = (
        "MATCH_ODDS,OVER_UNDER_25,BOTH_TEAMS_TO_SCORE,DOUBLE_CHANCE,DRAW_NO_BET,SET_WINNER"
    )
    betfair_max_markets_per_request: int = 40
    betfair_max_catalogue_results: int = 100
    betfair_inplay_only: bool = False

    # ----------------------------------------------------------- thresholds
    min_value_percent: float = 10.0
    min_outlier_percent: float = 15.0
    min_bookmakers: int = 3
    min_odds: float = 1.50
    max_odds: float = 51.0
    max_odds_age_seconds: float = 10.0
    alert_cooldown_seconds: int = 60
    min_confidence: int = 60
    min_error_score: int = 60
    #: Märkte jenseits dieser Wahrscheinlichkeit gelten als entschieden -
    #: dort dominiert der Modellfehler, deshalb keine Alarme.
    max_fair_probability: float = 0.97
    scan_live: bool = True
    scan_prematch: bool = True
    sports_enabled: str = "football,tennis"
    #: Nur bei diesen Buchmachern wird gemeldet. Leer = bei allen.
    #:
    #: Wichtig ist, wo dieser Filter greift: **am Alarm**, nicht am Abruf.
    #: Die faire Quote lebt davon, möglichst viele Bücher zu vergleichen -
    #: wer die Quelle selbst einschränkt (SGO_BOOKMAKERS), macht seine
    #: Referenz schlechter und findet dann weniger Fehlpreise statt mehr.
    #: Gemeldet werden soll aber nur, was man auch spielen kann. Beides
    #: zugleich geht nur, wenn die Referenz vollständig bleibt und erst die
    #: Meldung gefiltert wird.
    #:
    #: Die Namen stehen so drin, wie die Quelle sie liefert - welche das
    #: sind, zeigt ./scripts/bookmakers.sh. Geraten wird hier nichts.
    alert_bookmakers: str = ""

    @property
    def alert_bookmaker_set(self) -> frozenset[str]:
        return frozenset(b.lower() for b in _split_csv(self.alert_bookmakers))

    # ------------------------------------------------------- Vor dem Anpfiff
    #
    # Prematch ist nicht Live mit anderem Etikett, sondern ein anderer Markt:
    # es sind mehr Buchmacher da, alle hatten Tage Zeit, und die Preise stehen
    # dichter beieinander. Mit den Live-Schwellen käme darum fast nichts durch -
    # und was durchkäme, wäre eher ein Datenfehler als ein Vorteil. Deshalb
    # eigene Schwellen. ``None`` heißt "wie live".
    #
    # Standardmäßig AUS: Prematch kostet zusätzliches Kontingent, und das darf
    # sich nach einem Update niemandes Rechnung ändern, ohne dass er es
    # eingeschaltet hat.
    prematch_enabled: bool = False
    #: Prematch-Preise bewegen sich in Minuten, nicht in Sekunden. Ein eigener,
    #: langsamer Takt hält den Live-Abruf schnell und das Kontingent heil.
    prematch_poll_interval: float = 60.0
    #: Eigenes Seitenbudget - sonst verdrängen die vielen Prematch-Events die
    #: laufenden Spiele aus dem gemeinsamen Kontingent.
    prematch_max_pages: int = 2
    #: Engere Märkte, also niedrigere Schwelle. Zahlen sind ein Startpunkt und
    #: gehören mit ./scripts/backtest.sh an den eigenen Daten geprüft.
    prematch_min_value_percent: float | None = 4.0
    prematch_min_outlier_percent: float | None = 6.0
    #: Vor dem Anpfiff sind mehr Bücher da - ein Konsens aus dreien ist hier
    #: schwächer als live, wo drei schon viel sind.
    prematch_min_bookmakers: int | None = 5
    prematch_min_confidence: int | None = None
    prematch_min_error_score: int | None = None
    #: Abkühlzeit vor dem Anpfiff - deutlich länger als live, und zwar aus
    #: einem gemessenen Grund: eine Fehlquote, die stundenlang steht, zappelt
    #: dabei um ein, zwei Cent. Jede dieser Winzigkeiten ist eine Änderung,
    #: also eine neue Bewertung - und nach Ablauf der Sperre ein neuer Alarm.
    #: Mit den Live-Werten (60 s) wären das rund 180 Telegram-Nachrichten für
    #: EINE Wette, die drei Stunden lang gültig ist. Live ist das kein Thema:
    #: dort ändern sich Preise wirklich, und ein Spiel dauert 90 Minuten.
    prematch_alert_cooldown: int = 1800
    #: Wie lange ein Prematch-Alarm eine Empfehlung bleibt. Für Live gilt
    #: EVENT_STALE_SECONDS (180 s) - eine Live-Quote steht keine drei Minuten.
    #: Vor dem Anpfiff steht dieselbe Quote oft stundenlang; mit der
    #: Live-Frist verschwand jede Prematch-Empfehlung nach drei Minuten
    #: wieder, obwohl der Preis noch stand. Die Karte war praktisch immer
    #: leer.
    prematch_max_alert_age: float = 3600.0

    # Nachkontrolle vor dem Anpfiff.
    #
    # Live sind fünf Minuten die richtige Wartezeit: in der Zeit hat sich der
    # Markt bewegt, und der Vergleich sagt etwas. Vor dem Anpfiff bewegt sich
    # in fünf Minuten praktisch nichts - gemessen kam dabei heraus, dass der
    # CLV exakt der gemeldete Vorteil ist (+9.52 % gegen +9.52 %) und das
    # Urteil immer "held". Also null Information, die im Backtest dann wie
    # Beleg aussieht.
    #
    # Richtig ist, wogegen "Closing Line Value" ohnehin gemessen gehört: die
    # Linie, bei der der Markt schließt - der Anpfiff.
    prematch_followup_at_kickoff: bool = True
    #: Etwas vorher, damit die Vergleichsquoten noch in Redis stehen.
    prematch_followup_lead_seconds: float = 120.0
    #: Ohne gelieferte Anstoßzeit bleibt nur ein fester, längerer Abstand.
    prematch_followup_after_seconds: float = 3600.0
    #: Obergrenze: die Vormerkung in Redis lebt 24 Stunden. Ein Spiel in drei
    #: Tagen wird dann eben nach 23 Stunden geprüft - später als der Anpfiff
    #: wäre, aber unendlich viel aussagekräftiger als nach fünf Minuten.
    prematch_followup_max_seconds: float = 82800.0
    #: Quotenalter für Empfehlungen vor dem Anpfiff. Live ist eine Quote nach
    #: 15 Sekunden fraglich; vor dem Anpfiff steht derselbe Preis Stunden, und
    #: die Live-Grenze wirft dort alles weg, was der langsamere Prematch-Takt
    #: (60 s) ohnehin nie unterschreiten kann.
    prematch_recommend_max_odds_age: float = 300.0
    #: Wie weit nach vorn geschaut wird, in Stunden. 24 = heute und heute
    #: Nacht. 0 = ohne Grenze.
    #:
    #: Der Abruf fragt "alles, was nicht beendet ist" - das schließt Spiele in
    #: zwei Wochen ein. Bei einem Seitenbudget von zwei Seiten à 100 Events
    #: können die Spiele von heute dabei schlicht nie ankommen, und niemand
    #: merkt es: die Liste ist ja voll. Ein Preis für übernächsten Samstag ist
    #: ohnehin wertlos, weil er bis dahin zehnmal anders steht.
    prematch_horizon_hours: float = 24.0

    # ----------------------------------------------------- Bewegungsalarme
    move_alerts_enabled: bool = True
    #: Ab dieser Preisbewegung innerhalb von ``move_alert_window`` wird gemeldet.
    move_alert_percent: float = 12.0
    move_alert_window: float = 30.0
    move_alert_cooldown: int = 120
    #: Bewegungsalarme sind fürs Dashboard gedacht. Telegram bleibt so
    #: signalstark - einschaltbar über TELEGRAM_SEND_MOVES=true.
    telegram_send_moves: bool = False
    #: Mindestgrad für den in TELEGRAM_CHAT_ID eingetragenen Standard-Chat.
    #:
    #: Wer den Bot mit /start eingerichtet hat, hat eigene Einstellungen und
    #: ist davon nicht betroffen. Der Standard-Chat hatte dagegen gar keinen
    #: Filter - er bekam jeden Alarm, den der Scanner durchließ. Auf einem
    #: echten Server waren das 166 Alarme in 30 Minuten, von denen das System
    #: selbst keinen einzigen als spielbar einstufte. Eine Push-Nachricht für
    #: etwas zu schicken, das man gleichzeitig "nicht spielen" nennt, ist ein
    #: Widerspruch - deshalb fliegt "skip" hier standardmäßig raus.
    #:
    #: "any" stellt das alte Verhalten wieder her.
    telegram_min_grade: str = "weak"
    #: Kleinere Bewegungen landen nicht im Dashboard-Stream (Flut vermeiden).
    publish_odds_min_percent: float = 1.0
    #: Ähnlichkeitsschwelle des Event-Matchings über Provider hinweg.
    event_match_threshold: float = 0.82
    #: Bewegt sich der *ganze* Markt binnen dieses Fensters nach oben, ist eine
    #: hohe Einzelquote meist nur schneller - nicht falsch. Solche Alarme
    #: werden unterdrückt.
    market_drift_window: float = 20.0
    market_drift_suppress_percent: float = 4.0
    #: Springt ein einzelnes Buch stärker als das, ohne dass der Markt folgt,
    #: führt es die Bewegung an - das ist kein Fehlpreis.
    market_shock_percent: float = 25.0
    #: Ab diesem Alter gilt ein Event nicht mehr als live. Beendete Spiele
    #: melden bei den meisten Quellen kein "beendet", sie verschwinden
    #: einfach aus der Antwort - ohne diese Grenze stünden sie stundenlang
    #: weiter im Dashboard. Es wird deshalb nicht FINISHED behauptet,
    #: sondern nur aufgehört, LIVE zu behaupten.
    event_stale_seconds: float = 180.0
    #: Bestätigungsintervall für unveränderte Quoten (Redis-Schreiblast).
    quote_refresh_seconds: float = 5.0

    # -------------------------------------------------- Alarm-Nachverfolgung
    #: Jeder Alarm wird nachkontrolliert: steht der Preis später noch, hat der
    #: Buchmacher korrigiert, oder ist der Markt nachgezogen? Kostet keinen
    #: einzigen zusätzlichen API-Aufruf - es wird nur erneut angesehen, was
    #: ohnehin schon in Redis liegt.
    followup_enabled: bool = True
    #: Wartezeit bis zur Nachkontrolle. Kürzer als die Redis-TTL für Quoten,
    #: sonst ist der Vergleichsmarkt beim Auswerten schon abgelaufen.
    followup_after_seconds: float = 300.0
    #: Takt, in dem fällige Nachkontrollen abgearbeitet werden.
    followup_interval_seconds: float = 30.0
    #: Wie viele Nachkontrollen je Durchlauf höchstens.
    followup_batch: int = 200
    #: Ab dieser Änderung gilt ein Preis als bewegt (Prozentpunkte).
    followup_move_percent: float = 2.0

    # ------------------------------------------------------------ Empfehlung
    #: Aus einem Alarm wird eine Handlungsempfehlung abgeleitet: spielen,
    #: kleiner Einsatz, beobachten oder sein lassen - mit Einsatzgröße.
    #: Es wird nichts gesetzt; die Empfehlung ist eine Rechnung, keine Wette.
    recommend_enabled: bool = True
    #: Bankroll in Kontowährung. 0 = nicht hinterlegt; dann nennt die
    #: Empfehlung nur Prozentwerte und erfindet keinen Betrag.
    bankroll: float = 0.0
    #: Anteil des vollen Kelly-Einsatzes. Voller Kelly unterstellt, die
    #: geschätzte Wahrscheinlichkeit sei exakt - sie ist es nie.
    kelly_fraction: float = 0.25
    max_stake_percent: float = 2.0
    max_total_stake_percent: float = 6.0
    #: Größenordnung eines Vorteils, den es real geben kann (in Prozent).
    #: Alles weit darüber gilt als Datenfehler und wird abgewertet, nicht
    #: hochsortiert - siehe backend/core/recommendation.py.
    plausible_edge_percent: float = 8.0
    max_plausible_edge_percent: float = 18.0
    absurd_edge_percent: float = 60.0
    recommend_min_confidence: int = 65
    recommend_min_bookmakers: int = 4
    recommend_max_odds_age: float = 15.0
    #: Wetten je Event. Zwei Selektionen desselben Spiels hängen zusammen.
    recommend_max_picks_per_event: int = 1
    #: Wie viele Empfehlungen die Bestenliste höchstens enthält.
    recommend_limit: int = 10

    def threshold_bands(self) -> list[str]:
        """Wo Alarm und Empfehlung auseinanderliegen - und wie weit.

        Es gibt zwei Stufen. Der **Alarmfilter** entscheidet, was gemeldet
        wird ("sieh dir das an"), die **Empfehlung** entscheidet, was davon
        spielbar ist ("das würde ich setzen"). Dass die zweite Stufe strenger
        ist, ist Absicht - sonst wäre sie keine zweite Stufe.

        Gefährlich ist nicht das Band, sondern seine Breite. Wird es groß,
        entstehen Alarme, die zwangsläufig nie eine Empfehlung werden - und
        niemand sagt es. Auf einem echten Server gemessen: MAX_ODDS_AGE_SECONDS
        von 10 auf 60 gesetzt, während die Empfehlung bei 15s blieb. Ergebnis
        waren 166 Alarme in 30 Minuten und null Empfehlungen, 80 davon allein
        wegen "Quote zu alt" - ohne eine einzige Fehlermeldung.

        Diese Liste urteilt deshalb nicht, sie beziffert. Ob ein Band zu breit
        ist, beantworten die Verwerfungsgründe der Empfehlungsliste - die
        zählen, was tatsächlich hängenbleibt.
        """
        baender: list[str] = []
        if self.recommend_max_odds_age < self.max_odds_age_seconds:
            baender.append(
                f"Quotenalter {self.recommend_max_odds_age:.0f}-"
                f"{self.max_odds_age_seconds:.0f}s: gemeldet, nie spielbar "
                f"(RECOMMEND_MAX_ODDS_AGE gegen MAX_ODDS_AGE_SECONDS)"
            )
        if self.recommend_min_confidence > self.min_confidence:
            baender.append(
                f"Confidence {self.min_confidence}-{self.recommend_min_confidence - 1}: "
                f"gemeldet, nie spielbar "
                f"(MIN_CONFIDENCE gegen RECOMMEND_MIN_CONFIDENCE)"
            )
        if self.recommend_min_bookmakers > self.min_bookmakers:
            baender.append(
                f"Buchmacher {self.min_bookmakers}-{self.recommend_min_bookmakers - 1}: "
                f"gemeldet, nie spielbar "
                f"(MIN_BOOKMAKERS gegen RECOMMEND_MIN_BOOKMAKERS)"
            )
        return baender

    # --------------------------------------------------------- Sichere Wetten
    #: Widersprechen sich die Buchmacher untereinander, ist der Gewinn
    #: Arithmetik statt Schätzung. Kostet keinen zusätzlichen Abruf - es wird
    #: nur zusätzlich angesehen, was ohnehin schon einläuft.
    arbitrage_enabled: bool = True
    #: Darunter lohnt der Aufwand nicht, und Rundung erzeugt Scheinfunde.
    arbitrage_min_profit_percent: float = 0.5
    #: Darüber ist es praktisch immer ein Datenfehler. Solche Funde werden
    #: als Verdacht ausgewiesen, nicht als Empfehlung.
    arbitrage_max_profit_percent: float = 12.0
    #: Beide Seiten müssen frisch sein - eine alte Quote ist keine Wette.
    arbitrage_max_age: float = 15.0
    #: Anteil des Nettogewinns, den eine Börse einbehält (Betfair: 2-5 %).
    #: Reale Arbitragen liegen bei 0,5-3 % - ohne Abzug würde ein Verlust
    #: als risikofrei ausgewiesen. Lieber zu hoch als zu niedrig ansetzen.
    arbitrage_exchange_commission: float = 0.05
    #: Darunter gilt eine Quote als zu dünn für den Einsatz. 0 = nicht prüfen.
    arbitrage_min_liquidity: float = 0.0
    #: Wie lange ein Fund im Dashboard stehen bleibt.
    arbitrage_ttl_seconds: int = 120
    #: Abstand zwischen zwei Meldungen zum selben Markt.
    arbitrage_cooldown_seconds: int = 300
    #: Funde auch nach Telegram schicken.
    arbitrage_telegram: bool = True

    # -------------------------------------------------------- Wett-Tagebuch
    #: Festhalten, was tatsächlich gespielt wurde - und was dabei herauskam.
    #: Der Bot setzt weiterhin nichts; er führt Buch.
    betlog_enabled: bool = True
    #: Schreibzugriff über die HTTP-API (Dashboard-Knopf "Gespielt").
    #: Standard aus: die API ist genau so geschützt wie das Dashboard, und
    #: das steht bei vielen offen im Netz. Über Telegram geht es immer -
    #: dort ist der Absender bekannt. Vor dem Einschalten bitte
    #: ./scripts/set-dashboard-password.sh laufen lassen.
    betlog_api_writes: bool = False

    # -------------------------------------------------------------- scanner
    scanner_queue_size: int = 20000
    scanner_workers: int = 4
    db_writer_batch: int = 200
    db_writer_interval: float = 1.0
    odds_state_ttl_seconds: int = 900
    snapshot_persist_every: int = 1
    provider_health_interval: float = 5.0
    maintenance_interval_seconds: float = 21600.0  # 6 h
    retention_snapshot_days: int = 7
    retention_alert_days: int = 30

    # ------------------------------------------------------------------ api
    api_host: str = "0.0.0.0"  # noqa: S104 - im Container gewollt
    api_port: int = 8000
    api_cors_origins: str = "http://localhost:8080"
    api_rate_limit_per_minute: int = 240
    api_docs_enabled: bool = True
    api_ws_max_clients: int = 200

    # ------------------------------------------------------------ pub/sub
    channel_alerts: str = "storm:alerts"
    channel_odds: str = "storm:odds"
    channel_events: str = "storm:events"
    channel_arbitrage: str = "storm:arbitrage"

    @field_validator("log_level")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()

    # ------------------------------------------------------------- helpers
    @property
    def sqlalchemy_dsn(self) -> str:
        if self.database_url:
            return self.database_url
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def alembic_dsn(self) -> str:
        return self.sqlalchemy_dsn

    @property
    def provider_names(self) -> list[str]:
        return _split_csv(self.providers)

    @property
    def enabled_sports(self) -> list[str]:
        return _split_csv(self.sports_enabled)

    @property
    def cors_origins(self) -> list[str]:
        return _split_csv(self.api_cors_origins)

    @property
    def odds_api_sport_keys(self) -> list[str]:
        return _split_csv(self.odds_api_sports)

    @property
    def betfair_event_types(self) -> list[str]:
        return _split_csv(self.betfair_event_type_ids)

    @property
    def betfair_market_type_codes(self) -> list[str]:
        return _split_csv(self.betfair_market_types)

    @property
    def odds_api_market_keys(self) -> list[str]:
        return _split_csv(self.odds_api_markets)

    @property
    def admin_ids(self) -> set[int]:
        out: set[int] = set()
        for raw in _split_csv(self.telegram_admin_ids):
            try:
                out.add(int(raw))
            except ValueError:
                continue
        return out


def _split_csv(raw: str) -> list[str]:
    return [part.strip() for part in (raw or "").split(",") if part.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Nur für Tests: Settings-Cache leeren."""
    get_settings.cache_clear()
