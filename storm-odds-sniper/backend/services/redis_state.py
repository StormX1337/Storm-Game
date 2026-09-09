"""Redis: schneller Zustand, Cooldowns, Deduplication, Pub/Sub.

Aufteilung der Verantwortung:

* **Redis** hält den *aktuellen* Zustand (letzte Quote je Buchmacher, Event-
  Status, Provider-Health) und ist damit die gemeinsame Wahrheit für API,
  Scanner und Telegram-Worker.
* **PostgreSQL** hält die *Historie*.

Schlüsselschema::

    q:{event}:{market}:{selection}   HASH   bookmaker -> Quote-JSON
    midx:{event}:{market}            SET    Selektionen dieses Marktes
    eidx:{event}                     SET    Märkte dieses Events
    ev:{event}                       STRING Event-JSON
    ev:live                          SET    Event-IDs mit Status LIVE
    ph:{provider}                    STRING Provider-Health-JSON
    cd:*/dup:*                       STRING Cooldown / Duplikat (SET NX EX)
    alert:followup                   ZSET   Alarm -> Fälligkeit der Nachkontrolle
    fu:{fingerprint}                 STRING Alarmdaten für die Nachkontrolle
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable
from typing import Any

import orjson
import redis.asyncio as redis
from redis.asyncio.client import Redis

from backend.core.logging import get_logger
from backend.models.domain import Alert, EventSnapshot, OddsChange, OddsQuote, now_ts

log = get_logger("redis")


def _dumps(payload: Any) -> bytes:
    return orjson.dumps(payload)


def _loads(raw: bytes | str | None) -> Any:
    if raw is None:
        return None
    return orjson.loads(raw)


class RedisState:
    """Dünne, typisierte Hülle um genau die Operationen, die wir brauchen."""

    def __init__(
        self,
        url: str = "redis://redis:6379/0",
        *,
        ttl: int = 900,
        refresh_seconds: float = 5.0,
        max_connections: int = 50,
        client: Redis | None = None,
        channel_alerts: str = "storm:alerts",
        channel_odds: str = "storm:odds",
        channel_events: str = "storm:events",
    ) -> None:
        self.url = url
        self.ttl = ttl
        #: Wie oft ein *unveränderter* Preis in Redis bestätigt wird. Ohne das
        #: würde eine stehen gebliebene Quote fälschlich als "stale" gelten -
        #: und genau die ist der klassische Fehlpreis.
        self.refresh_seconds = refresh_seconds
        self.max_connections = max_connections
        self._client: Redis | None = client
        self.channel_alerts = channel_alerts
        self.channel_odds = channel_odds
        self.channel_events = channel_events
        #: Prozesslokaler Cache für die Änderungserkennung - spart pro Quote
        #: einen Redis-Roundtrip. Redis bleibt die geteilte Wahrheit.
        #: Wert: (Preis, Zeitpunkt der letzten Preisänderung, letzte Bestätigung).
        self._local_prices: dict[str, tuple[float, float, float]] = {}

    # ------------------------------------------------------------ Lifecycle
    @property
    def client(self) -> Redis:
        if self._client is None:
            raise RuntimeError("Redis nicht verbunden - connect() aufrufen")
        return self._client

    async def connect(self) -> None:
        if self._client is None:
            self._client = redis.from_url(
                self.url,
                max_connections=self.max_connections,
                decode_responses=False,
                health_check_interval=15,
            )
        await self._client.ping()
        log.info("redis verbunden")

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def ping(self) -> bool:
        try:
            return bool(await self.client.ping())
        except Exception as exc:  # noqa: BLE001 - Healthcheck darf nie werfen
            log.warning("redis nicht erreichbar", error=str(exc))
            return False

    # --------------------------------------------------------------- Quoten
    @staticmethod
    def line_key(event_id: str, market_key: str, selection_key: str) -> str:
        return f"q:{event_id}:{market_key}:{selection_key}"

    async def apply_quote(self, quote: OddsQuote) -> OddsChange | None:
        """Quote speichern und die Preisänderung zurückgeben.

        Gibt ``None`` zurück, wenn sich der Preis nicht verändert hat - genau
        das ist die inkrementelle Verarbeitung: unveränderte Preise erzeugen
        weder Analyse noch Datenbankschreibvorgang.

        Ein unveränderter Preis wird höchstens alle ``refresh_seconds`` in
        Redis bestätigt. Das hält den Hot-Path schlank und lässt eine stehen
        gebliebene Quote trotzdem nicht künstlich veralten.
        """
        cache_key = quote.key
        previous = self._local_prices.get(cache_key)
        unchanged = (
            previous is not None and abs(previous[0] - quote.price) < 1e-9 and not quote.suspended
        )
        if unchanged:
            price, changed_at, confirmed_at = previous  # type: ignore[misc]
            if quote.confirmed_at - confirmed_at < self.refresh_seconds:
                return None
            # Nur die Bestätigung auffrischen - der Preis selbst steht weiter.
            quote.ts = changed_at
            self._local_prices[cache_key] = (price, changed_at, quote.confirmed_at)
            await self._store(quote)
            return None

        self._local_prices[cache_key] = (quote.price, quote.ts, quote.confirmed_at)
        await self._store(quote)

        return OddsChange(
            quote=quote,
            previous_price=previous[0] if previous else None,
            previous_ts=previous[1] if previous else None,
        )

    async def _store(self, quote: OddsQuote) -> None:
        key = self.line_key(quote.event_id, quote.market.key, quote.selection.key)
        pipe = self.client.pipeline(transaction=False)
        pipe.hset(key, quote.bookmaker, _dumps(quote.to_json()))
        pipe.expire(key, self.ttl)
        pipe.sadd(f"midx:{quote.event_id}:{quote.market.key}", quote.selection.key)
        pipe.expire(f"midx:{quote.event_id}:{quote.market.key}", self.ttl)
        pipe.sadd(f"eidx:{quote.event_id}", quote.market.key)
        pipe.expire(f"eidx:{quote.event_id}", self.ttl)
        await pipe.execute()

    async def get_line(self, event_id: str, market_key: str, selection_key: str) -> list[OddsQuote]:
        raw = await self.client.hgetall(self.line_key(event_id, market_key, selection_key))
        out: list[OddsQuote] = []
        for payload in raw.values():
            data = _loads(payload)
            if data:
                out.append(OddsQuote.from_json(data))
        return out

    async def get_market(self, event_id: str, market_key: str) -> list[OddsQuote]:
        """Alle Quoten eines Marktes - ein Roundtrip pro Selektion, gepipelined."""
        selections = await self.client.smembers(f"midx:{event_id}:{market_key}")
        if not selections:
            return []
        pipe = self.client.pipeline(transaction=False)
        keys = []
        for raw_selection in selections:
            selection = (
                raw_selection.decode() if isinstance(raw_selection, bytes) else raw_selection
            )
            keys.append(selection)
            pipe.hgetall(self.line_key(event_id, market_key, selection))
        results = await pipe.execute()
        out: list[OddsQuote] = []
        for entries in results:
            for payload in (entries or {}).values():
                data = _loads(payload)
                if data:
                    out.append(OddsQuote.from_json(data))
        return out

    async def market_keys(self, event_id: str) -> list[str]:
        raw = await self.client.smembers(f"eidx:{event_id}")
        return [k.decode() if isinstance(k, bytes) else k for k in raw]

    async def drop_quote(self, quote: OddsQuote) -> None:
        key = self.line_key(quote.event_id, quote.market.key, quote.selection.key)
        await self.client.hdel(key, quote.bookmaker)
        self._local_prices.pop(quote.key, None)

    # --------------------------------------------------------------- Events
    async def set_event(self, event: EventSnapshot) -> None:
        pipe = self.client.pipeline(transaction=False)
        pipe.set(f"ev:{event.event_id}", _dumps(event.to_json()), ex=self.ttl * 4)
        if event.is_live:
            pipe.sadd("ev:live", event.event_id)
        else:
            pipe.srem("ev:live", event.event_id)
        pipe.sadd("ev:all", event.event_id)
        pipe.expire("ev:all", self.ttl * 4)
        # Auch die Live-Menge bekommt eine Frist. Ohne sie wüchse sie
        # unbegrenzt: entfernt wird eine ID sonst nur, wenn ein *neuer*
        # Snapshot mit anderem Status kommt - und genau der bleibt aus,
        # wenn ein Spiel endet.
        pipe.expire("ev:live", self.ttl * 4)
        await pipe.execute()

    async def get_event(self, event_id: str) -> EventSnapshot | None:
        data = _loads(await self.client.get(f"ev:{event_id}"))
        return EventSnapshot.from_json(data) if data else None

    async def live_event_ids(self) -> list[str]:
        raw = await self.client.smembers("ev:live")
        return [k.decode() if isinstance(k, bytes) else k for k in raw]

    async def all_event_ids(self) -> list[str]:
        raw = await self.client.smembers("ev:all")
        return [k.decode() if isinstance(k, bytes) else k for k in raw]

    async def prune_live_events(self, max_age: float) -> list[str]:
        """Events ohne frische Daten aus der Live-Menge nehmen.

        Ein beendetes Spiel meldet bei den üblichen Quellen kein "beendet" -
        es verschwindet einfach aus der Antwort. Die ID bliebe dann bis zum
        Ablauf ihres Schlüssels in ``ev:live`` stehen, und das Dashboard
        zeigte ein fertiges Match stundenlang als laufend.

        Bewusst wird der Status **nicht** auf FINISHED gesetzt: dass keine
        Daten mehr kommen, heißt nicht zwingend, dass das Spiel vorbei ist -
        es kann auch die Quelle sein. Behauptet wird deshalb nur das, was
        stimmt: dieses Event gilt nicht mehr als live.
        """
        ids = await self.live_event_ids()
        if not ids:
            return []
        reference = now_ts()
        events = {event.event_id: event for event in await self.get_events(ids)}
        stale = [
            event_id
            for event_id in ids
            # Fehlender Snapshot heißt: der Schlüssel ist abgelaufen, die ID
            # ist eine Leiche.
            if (event := events.get(event_id)) is None or event.age(reference) > max_age
        ]
        if stale:
            await self.client.srem("ev:live", *stale)
        return stale

    async def get_events(self, event_ids: Iterable[str]) -> list[EventSnapshot]:
        ids = list(event_ids)
        if not ids:
            return []
        values = await self.client.mget([f"ev:{eid}" for eid in ids])
        out: list[EventSnapshot] = []
        for payload in values:
            data = _loads(payload)
            if data:
                out.append(EventSnapshot.from_json(data))
        return out

    # ------------------------------------------------------ Cooldown / Dedup
    async def claim(self, key: str, ttl_seconds: int) -> bool:
        """``True``, wenn der Schlüssel frei war (implementiert ``CooldownStore``)."""
        return bool(await self.client.set(key, b"1", ex=max(1, ttl_seconds), nx=True))

    async def release(self, key: str) -> None:
        await self.client.delete(key)

    # ------------------------------------------------------ Provider-Health
    async def set_provider_health(self, name: str, payload: dict[str, Any]) -> None:
        await self.client.set(f"ph:{name}", _dumps(payload), ex=120)
        await self.client.sadd("ph:all", name)

    async def get_provider_health(self) -> list[dict[str, Any]]:
        names = await self.client.smembers("ph:all")
        if not names:
            return []
        keys = [f"ph:{n.decode() if isinstance(n, bytes) else n}" for n in names]
        values = await self.client.mget(keys)
        return [data for payload in values if (data := _loads(payload))]

    # ------------------------------------------------------------- Pub/Sub
    async def publish_alert(self, alert: Alert) -> None:
        await self.client.publish(self.channel_alerts, _dumps(alert.to_json()))

    async def publish(self, channel: str, payload: dict[str, Any]) -> None:
        await self.client.publish(channel, _dumps(payload))

    async def subscribe(self, *channels: str) -> AsyncIterator[tuple[str, Any]]:
        """Nachrichten der angegebenen Kanäle als Async-Iterator."""
        pubsub = self.client.pubsub(ignore_subscribe_messages=True)
        await pubsub.subscribe(*channels)
        try:
            async for message in pubsub.listen():
                if message is None or message.get("type") != "message":
                    continue
                channel = message["channel"]
                channel = channel.decode() if isinstance(channel, bytes) else channel
                yield channel, _loads(message["data"])
        finally:
            await pubsub.unsubscribe(*channels)
            await pubsub.aclose()

    # ------------------------------------------- Unterdrückte Alarme
    async def add_suppressions(self, counts: dict[str, int]) -> None:
        """Zähler gebündelt erhöhen - ein Roundtrip für alle Gründe."""
        if not counts:
            return
        pipe = self.client.pipeline(transaction=False)
        for code, amount in counts.items():
            pipe.hincrby("stat:suppressed", code, amount)
        pipe.expire("stat:suppressed", 86400 * 2)
        await pipe.execute()

    async def get_suppressions(self) -> dict[str, int]:
        """Warum kam nichts an? Zähler je Grund."""
        raw = await self.client.hgetall("stat:suppressed")
        out: dict[str, int] = {}
        for key, value in (raw or {}).items():
            code = key.decode() if isinstance(key, bytes) else key
            try:
                out[code] = int(value)
            except (TypeError, ValueError):
                continue
        return out

    async def reset_suppressions(self) -> None:
        await self.client.delete("stat:suppressed")

    # ------------------------------------------- Alarm-Nachverfolgung
    #: Fällige Nachkontrollen liegen in einem Sorted Set, sortiert nach
    #: Fälligkeit. Der Scanner holt sich damit in einem Aufruf genau die
    #: Alarme, die jetzt dran sind - ohne über alle offenen zu iterieren.
    FOLLOWUP_QUEUE = "alert:followup"

    @staticmethod
    def followup_key(fingerprint: str) -> str:
        return f"fu:{fingerprint}"

    async def schedule_followup(
        self, alert: Alert, *, due_at: float, ttl_seconds: int = 86400
    ) -> None:
        """Einen Alarm zur späteren Nachkontrolle vormerken."""
        payload = {
            "fingerprint": alert.fingerprint,
            "kind": alert.kind.value,
            "event_id": alert.event.event_id,
            "market_key": alert.market.key,
            "selection_key": alert.selection.key,
            "bookmaker": alert.bookmaker,
            "odds": alert.odds,
            "fair_odds": alert.fair_odds,
            "previous_odds": alert.previous_odds,
            "detected_at": alert.detected_at,
            "due_at": due_at,
            # Spielsituation zum Alarmzeitpunkt. Ändert sie sich, ist ein
            # Preisvergleich hinfällig.
            "state_key": alert.event.state_key(),
        }
        pipe = self.client.pipeline(transaction=False)
        pipe.set(self.followup_key(alert.fingerprint), _dumps(payload), ex=ttl_seconds)
        pipe.zadd(self.FOLLOWUP_QUEUE, {alert.fingerprint: due_at})
        await pipe.execute()

    async def claim_followups(self, *, now: float, limit: int = 200) -> list[dict[str, Any]]:
        """Fällige Nachkontrollen holen und aus der Warteschlange entfernen.

        Das Entfernen geschieht sofort: ein Alarm wird genau einmal
        ausgewertet. Läuft der Scanner mehrfach, bekommt ihn nur einer -
        ``zrem`` meldet, wie viele Einträge tatsächlich entfernt wurden.
        """
        members = await self.client.zrangebyscore(
            self.FOLLOWUP_QUEUE, min=0, max=now, start=0, num=max(1, limit)
        )
        if not members:
            return []
        out: list[dict[str, Any]] = []
        for member in members:
            removed = await self.client.zrem(self.FOLLOWUP_QUEUE, member)
            if not removed:
                continue  # ein anderer Scanner war schneller
            key = member.decode() if isinstance(member, bytes) else member
            raw = await self.client.get(self.followup_key(key))
            data = _loads(raw)
            if isinstance(data, dict):
                out.append(data)
            else:
                # Der Zustand ist abgelaufen - der Alarm bleibt unaufgelöst,
                # das ist eine Information und kein Fehler.
                out.append({"fingerprint": key, "expired": True})
            await self.client.delete(self.followup_key(key))
        return out

    async def pending_followups(self) -> int:
        return int(await self.client.zcard(self.FOLLOWUP_QUEUE) or 0)

    async def add_verdicts(self, counts: dict[str, int]) -> None:
        """Urteile gebündelt zählen - eine Runde, ein Roundtrip."""
        if not counts:
            return
        pipe = self.client.pipeline(transaction=False)
        for verdict, amount in counts.items():
            pipe.hincrby("stat:verdicts", verdict, amount)
        pipe.expire("stat:verdicts", 86400 * 7)
        await pipe.execute()

    async def get_verdicts(self) -> dict[str, int]:
        raw = await self.client.hgetall("stat:verdicts")
        out: dict[str, int] = {}
        for key, value in (raw or {}).items():
            code = key.decode() if isinstance(key, bytes) else key
            try:
                out[code] = int(value)
            except (TypeError, ValueError):
                continue
        return out

    async def add_grades(self, counts: dict[str, int]) -> None:
        """Empfehlungsgrade gebündelt zählen - wie die Urteile."""
        if not counts:
            return
        pipe = self.client.pipeline(transaction=False)
        for grade, amount in counts.items():
            pipe.hincrby("stat:grades", grade, amount)
        pipe.expire("stat:grades", 86400 * 7)
        await pipe.execute()

    async def get_grades(self) -> dict[str, int]:
        raw = await self.client.hgetall("stat:grades")
        out: dict[str, int] = {}
        for key, value in (raw or {}).items():
            code = key.decode() if isinstance(key, bytes) else key
            try:
                out[code] = int(value)
            except (TypeError, ValueError):
                continue
        return out

    # ------------------------------------------------------------ Statistik
    async def counters(self, *, max_age: float | None = None) -> dict[str, int]:
        """Zählerstände. Mit ``max_age`` werden nur Events mit frischen Daten
        als live gezählt.

        Ohne das zeigte die Kachel "1 Live-Event", während die Liste darunter
        "keine laufenden Events" sagt - beides aus derselben Menge, nur einmal
        gezählt und einmal gefiltert. Der Aufräumer im Scanner holt das binnen
        Sekunden nach; steht der Scanner, blieben die Zahlen dauerhaft
        widersprüchlich.
        """
        total = await self.client.scard("ev:all")
        if max_age is None:
            live = int(await self.client.scard("ev:live") or 0)
        else:
            reference = now_ts()
            events = await self.get_events(await self.live_event_ids())
            live = sum(1 for event in events if event.age(reference) <= max_age)
        return {"live_events": live, "tracked_events": int(total or 0)}

    async def bump(self, key: str, amount: int = 1) -> None:
        await self.client.incrby(f"stat:{key}", amount)

    async def get_stat(self, key: str) -> int:
        raw = await self.client.get(f"stat:{key}")
        try:
            return int(raw) if raw is not None else 0
        except (TypeError, ValueError):
            return 0

    def prune_local_cache(self, max_entries: int = 200_000) -> int:
        """Prozesslokalen Preis-Cache begrenzen (ältester Zeitstempel fliegt raus)."""
        if len(self._local_prices) <= max_entries:
            return 0
        cutoff = now_ts() - 3600
        stale = [k for k, (_, _, confirmed) in self._local_prices.items() if confirmed < cutoff]
        for key in stale:
            self._local_prices.pop(key, None)
        return len(stale)
