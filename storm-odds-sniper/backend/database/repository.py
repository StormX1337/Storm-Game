"""Datenzugriff.

Der Scanner darf im Hot-Path nicht auf die Datenbank warten. Deshalb:

* IDs (Buchmacher/Markt/Selektion) werden im Prozess gecacht - eine
  Quotenzeile kostet nach dem ersten Mal keine Abfrage mehr.
* Schreibvorgänge laufen gebündelt (``insert_snapshots``/``insert_changes``)
  aus einem eigenen Writer-Task.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Select, delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.core.logging import get_logger
from backend.database.tables import (
    AlertRow,
    Bookmaker,
    Event,
    Market,
    OddsChangeRow,
    OddsSnapshot,
    ProviderHealthRow,
    SelectionRow,
    User,
    UserSettings,
)
from backend.models.domain import Alert, EventSnapshot, OddsChange, OddsQuote
from backend.providers.base import ProviderHealth

log = get_logger("database.repository")


def _insert_for(session: AsyncSession):
    """Dialektabhängiges ``INSERT ... ON CONFLICT``."""
    name = session.bind.dialect.name if session.bind is not None else "postgresql"
    return sqlite_insert if name == "sqlite" else pg_insert


def _dt(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, tz=UTC)


class Repository:
    """Alle Datenbankzugriffe an einem Ort."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.session_factory = session_factory
        self._bookmaker_ids: dict[str, int] = {}
        self._market_ids: dict[tuple[str, str], int] = {}
        self._selection_ids: dict[tuple[int, str], int] = {}

    def clear_caches(self) -> None:
        self._bookmaker_ids.clear()
        self._market_ids.clear()
        self._selection_ids.clear()

    # ------------------------------------------------------------ Stammdaten
    async def ensure_bookmaker(
        self, session: AsyncSession, key: str, *, is_exchange: bool = False
    ) -> int:
        if (cached := self._bookmaker_ids.get(key)) is not None:
            return cached
        insert = _insert_for(session)
        stmt = (
            insert(Bookmaker)
            .values(key=key, title=key, is_exchange=is_exchange)
            .on_conflict_do_nothing(index_elements=[Bookmaker.key])
        )
        await session.execute(stmt)
        result = await session.execute(select(Bookmaker.id).where(Bookmaker.key == key))
        bookmaker_id = result.scalar_one()
        self._bookmaker_ids[key] = bookmaker_id
        return bookmaker_id

    async def upsert_event(self, session: AsyncSession, event: EventSnapshot) -> None:
        live_state: dict[str, Any] | None = None
        if event.football is not None:
            live_state = {
                k: v
                for k, v in {
                    "minute": event.football.minute,
                    "period": event.football.period,
                    "home_red_cards": event.football.home_red_cards,
                    "away_red_cards": event.football.away_red_cards,
                    "stoppage_time": event.football.stoppage_time,
                }.items()
                if v is not None
            } or None
        elif event.tennis is not None:
            live_state = {
                k: v
                for k, v in {
                    "set_number": event.tennis.set_number,
                    "sets_home": event.tennis.sets_home,
                    "sets_away": event.tennis.sets_away,
                    "games_home": event.tennis.games_home,
                    "games_away": event.tennis.games_away,
                    "points_home": event.tennis.points_home,
                    "points_away": event.tennis.points_away,
                    "server": event.tennis.server,
                }.items()
                if v is not None
            } or None

        values = {
            "id": event.event_id,
            "sport": event.sport.value,
            "league": event.league,
            "home": event.home,
            "away": event.away,
            "start_time": event.start_time,
            "status": event.status.value,
            "score_home": event.score.home if event.score else None,
            "score_away": event.score.away if event.score else None,
            "live_state": live_state,
            "providers": [event.provider],
            "updated_at": datetime.now(UTC),
        }
        insert = _insert_for(session)
        stmt = insert(Event).values(**values)
        update_cols = {
            k: getattr(stmt.excluded, k)
            for k in (
                "sport",
                "league",
                "home",
                "away",
                "start_time",
                "status",
                "score_home",
                "score_away",
                "live_state",
                "updated_at",
            )
        }
        await session.execute(
            stmt.on_conflict_do_update(index_elements=[Event.id], set_=update_cols)
        )

    async def ensure_market(self, session: AsyncSession, quote: OddsQuote) -> int:
        cache_key = (quote.event_id, quote.market.key)
        if (cached := self._market_ids.get(cache_key)) is not None:
            return cached
        insert = _insert_for(session)
        stmt = (
            insert(Market)
            .values(
                event_id=quote.event_id,
                market_key=quote.market.key,
                market_type=quote.market.type.value,
                line=quote.market.line,
                period=quote.market.period.value,
            )
            .on_conflict_do_nothing(index_elements=[Market.event_id, Market.market_key])
        )
        await session.execute(stmt)
        result = await session.execute(
            select(Market.id).where(
                Market.event_id == quote.event_id, Market.market_key == quote.market.key
            )
        )
        market_id = result.scalar_one()
        self._market_ids[cache_key] = market_id
        return market_id

    async def ensure_selection(
        self, session: AsyncSession, market_id: int, quote: OddsQuote
    ) -> int:
        cache_key = (market_id, quote.selection.key)
        if (cached := self._selection_ids.get(cache_key)) is not None:
            return cached
        insert = _insert_for(session)
        stmt = (
            insert(SelectionRow)
            .values(
                market_id=market_id,
                selection_key=quote.selection.key,
                label=quote.selection.display[:128],
            )
            .on_conflict_do_nothing(
                index_elements=[SelectionRow.market_id, SelectionRow.selection_key]
            )
        )
        await session.execute(stmt)
        result = await session.execute(
            select(SelectionRow.id).where(
                SelectionRow.market_id == market_id,
                SelectionRow.selection_key == quote.selection.key,
            )
        )
        selection_id = result.scalar_one()
        self._selection_ids[cache_key] = selection_id
        return selection_id

    async def resolve_ids(self, session: AsyncSession, quote: OddsQuote) -> tuple[int, int]:
        """(selection_id, bookmaker_id) - über Prozess-Cache nahezu kostenlos."""
        market_id = await self.ensure_market(session, quote)
        selection_id = await self.ensure_selection(session, market_id, quote)
        bookmaker_id = await self.ensure_bookmaker(
            session, quote.bookmaker, is_exchange=quote.is_exchange
        )
        return selection_id, bookmaker_id

    # -------------------------------------------------------------- Schreiben
    async def write_batch(
        self,
        *,
        events: Sequence[EventSnapshot] = (),
        changes: Sequence[OddsChange] = (),
        alerts: Sequence[Alert] = (),
        store_snapshots: bool = True,
    ) -> None:
        """Ein Batch = eine Transaktion."""
        if not events and not changes and not alerts:
            return
        async with self.session_factory() as session:
            try:
                for event in events:
                    await self.upsert_event(session, event)

                snapshot_rows: list[dict[str, Any]] = []
                change_rows: list[dict[str, Any]] = []
                for change in changes:
                    quote = change.quote
                    selection_id, bookmaker_id = await self.resolve_ids(session, quote)
                    if store_snapshots:
                        snapshot_rows.append(
                            {
                                "selection_id": selection_id,
                                "bookmaker_id": bookmaker_id,
                                "price": quote.price,
                                "ts": _dt(quote.ts),
                                "received_at": _dt(quote.received_at),
                                "provider": quote.provider,
                                "suspended": quote.suspended,
                                "liquidity": quote.liquidity,
                            }
                        )
                    change_rows.append(
                        {
                            "selection_id": selection_id,
                            "bookmaker_id": bookmaker_id,
                            "old_price": change.previous_price,
                            "new_price": quote.price,
                            "delta_percent": change.delta_percent,
                            "elapsed_seconds": change.elapsed,
                            "ts": _dt(quote.ts),
                        }
                    )
                if snapshot_rows:
                    await session.execute(OddsSnapshot.__table__.insert(), snapshot_rows)
                if change_rows:
                    await session.execute(OddsChangeRow.__table__.insert(), change_rows)

                for alert in alerts:
                    await self._insert_alert(session, alert)
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def _insert_alert(self, session: AsyncSession, alert: Alert) -> None:
        insert = _insert_for(session)
        stmt = (
            insert(AlertRow)
            .values(
                kind=alert.kind.value,
                event_id=alert.event.event_id,
                sport=alert.event.sport.value,
                market_key=alert.market.key,
                market_label=alert.market.label[:128],
                selection_key=alert.selection.key,
                selection_label=alert.selection.display[:128],
                bookmaker=alert.bookmaker,
                odds=alert.odds,
                fair_odds=alert.fair_odds,
                value_percent=alert.value_percent,
                deviation_percent=alert.deviation_percent,
                confidence=alert.confidence,
                error_score=alert.error_score,
                bookmaker_count=alert.bookmaker_count,
                provider=alert.provider,
                fingerprint=alert.fingerprint,
                detected_at=_dt(alert.detected_at),
                payload=alert.to_json(),
            )
            .on_conflict_do_nothing(index_elements=[AlertRow.fingerprint])
        )
        await session.execute(stmt)

    async def save_alert(self, alert: Alert) -> None:
        async with self.session_factory() as session:
            await self._insert_alert(session, alert)
            await session.commit()

    async def mark_alert_sent(self, fingerprint: str) -> None:
        async with self.session_factory() as session:
            await session.execute(
                AlertRow.__table__.update()
                .where(AlertRow.fingerprint == fingerprint)
                .values(telegram_sent=True)
            )
            await session.commit()

    async def resolve_alerts(self, resolutions: Sequence[dict[str, Any]]) -> list[str]:
        """Ergebnisse der Nachkontrolle eintragen.

        Jeder Eintrag braucht ``fingerprint`` und ``verdict``; die Preise
        dürfen fehlen (ein verschwundener Preis *ist* das Ergebnis).

        Zurück kommen die Fingerabdrücke, zu denen **keine** Zeile gefunden
        wurde. Das ist kein Randfall: der Alarm wird gebündelt geschrieben,
        und unter Last kann der Writer hinter der Nachkontrolle liegen. Ohne
        diese Rückmeldung ginge das Urteil still verloren.
        """
        if not resolutions:
            return []
        missing: list[str] = []
        now = datetime.now(UTC)
        async with self.session_factory() as session:
            for entry in resolutions:
                fingerprint = entry.get("fingerprint")
                if not fingerprint:
                    continue
                result = await session.execute(
                    AlertRow.__table__.update()
                    .where(AlertRow.fingerprint == fingerprint)
                    .values(
                        verdict=entry.get("verdict"),
                        clv_percent=entry.get("clv_percent"),
                        closing_odds=entry.get("closing_odds"),
                        closing_fair_odds=entry.get("closing_fair_odds"),
                        resolved_at=now,
                        status="resolved",
                    )
                )
                if not result.rowcount:
                    missing.append(str(fingerprint))
            await session.commit()
        return missing

    async def scorecard(self, *, window_hours: int = 168) -> dict[str, Any]:
        """Trefferbilanz: was ist aus den Alarmen geworden?

        Bewusst getrennt nach Alarmart - ein Bewegungsalarm hat keinen Value
        und darf die CLV-Statistik der Value-Alarme nicht verwässern.
        """
        since = datetime.now(UTC) - timedelta(hours=window_hours)
        async with self.session_factory() as session:
            rows = (
                await session.execute(
                    select(
                        AlertRow.kind,
                        AlertRow.verdict,
                        func.count(AlertRow.id),
                        func.avg(AlertRow.clv_percent),
                        # Zeilen *mit* CLV - nur über die darf gemittelt werden.
                        func.count(AlertRow.clv_percent),
                    )
                    .where(AlertRow.detected_at >= since)
                    .group_by(AlertRow.kind, AlertRow.verdict)
                )
            ).all()
            beat = (
                await session.execute(
                    select(func.count(AlertRow.id)).where(
                        AlertRow.detected_at >= since, AlertRow.clv_percent > 0
                    )
                )
            ).scalar_one()
            scored = (
                await session.execute(
                    select(func.count(AlertRow.id), func.avg(AlertRow.clv_percent)).where(
                        AlertRow.detected_at >= since, AlertRow.clv_percent.is_not(None)
                    )
                )
            ).one()
            by_bookmaker = (
                await session.execute(
                    select(
                        AlertRow.bookmaker,
                        func.count(AlertRow.id),
                        func.avg(AlertRow.clv_percent),
                    )
                    .where(AlertRow.detected_at >= since, AlertRow.verdict.is_not(None))
                    .group_by(AlertRow.bookmaker)
                    .order_by(func.count(AlertRow.id).desc())
                    .limit(12)
                )
            ).all()

        verdicts: dict[str, int] = {}
        by_kind: dict[str, dict[str, Any]] = {}
        # Der Durchschnitt je Alarmart muss über *alle* Gruppen dieser Art
        # gebildet werden. Ihn je Gruppe zu überschreiben ergäbe den Wert einer
        # beliebigen Urteilsgruppe - etwa nur den der Fehlschläge.
        clv_sum: dict[str, float] = {}
        clv_count: dict[str, int] = {}
        pending = 0
        for kind, verdict, count, avg_clv, scored_rows in rows:
            label = verdict or "pending"
            if verdict is None:
                pending += count
            verdicts[label] = verdicts.get(label, 0) + count
            bucket = by_kind.setdefault(kind, {"total": 0, "verdicts": {}, "avg_clv_percent": None})
            bucket["total"] += count
            bucket["verdicts"][label] = count
            if avg_clv is not None and scored_rows:
                clv_sum[kind] = clv_sum.get(kind, 0.0) + float(avg_clv) * int(scored_rows)
                clv_count[kind] = clv_count.get(kind, 0) + int(scored_rows)
        for kind, total in clv_count.items():
            by_kind[kind]["avg_clv_percent"] = round(clv_sum[kind] / total, 2)
            by_kind[kind]["scored"] = total

        scored_count = int(scored[0] or 0)
        return {
            "window_hours": window_hours,
            "verdicts": verdicts,
            "by_kind": by_kind,
            "pending": pending,
            "resolved": sum(v for k, v in verdicts.items() if k != "pending"),
            "scored": scored_count,
            "avg_clv_percent": round(float(scored[1]), 2) if scored[1] is not None else None,
            "beat_close": int(beat or 0),
            "beat_close_share": round(beat / scored_count * 100.0, 1) if scored_count else None,
            "by_bookmaker": [
                {
                    "bookmaker": name,
                    "alerts": count,
                    "avg_clv_percent": round(float(avg), 2) if avg is not None else None,
                }
                for name, count, avg in by_bookmaker
            ],
        }

    async def upsert_provider_health(self, health: ProviderHealth) -> None:
        async with self.session_factory() as session:
            insert = _insert_for(session)
            values = {
                "provider": health.name,
                "status": health.status.value,
                "connected_since": _dt(health.connected_since) if health.connected_since else None,
                "last_message_at": _dt(health.last_message_at) if health.last_message_at else None,
                "messages": health.messages,
                "quotes": health.quotes,
                "errors": health.errors,
                "reconnects": health.reconnects,
                "rate_limit_remaining": health.rate_limit_remaining,
                "latency_ms": health.latency_ms,
                "detail": health.detail[:2000],
                "updated_at": datetime.now(UTC),
            }
            stmt = insert(ProviderHealthRow).values(**values)
            await session.execute(
                stmt.on_conflict_do_update(
                    index_elements=[ProviderHealthRow.provider],
                    set_={k: getattr(stmt.excluded, k) for k in values if k != "provider"},
                )
            )
            await session.commit()

    # ----------------------------------------------------------------- Lesen
    async def list_events(
        self,
        *,
        sport: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Event]:
        stmt: Select = select(Event).order_by(Event.updated_at.desc()).limit(limit).offset(offset)
        if sport:
            stmt = stmt.where(Event.sport == sport)
        if status:
            stmt = stmt.where(Event.status == status)
        async with self.session_factory() as session:
            return list((await session.execute(stmt)).scalars().all())

    async def get_event(self, event_id: str) -> Event | None:
        async with self.session_factory() as session:
            return (
                await session.execute(select(Event).where(Event.id == event_id))
            ).scalar_one_or_none()

    async def list_alerts(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        sport: str | None = None,
        kind: str | None = None,
        min_value: float | None = None,
        since: datetime | None = None,
    ) -> list[AlertRow]:
        stmt: Select = (
            select(AlertRow).order_by(AlertRow.detected_at.desc()).limit(limit).offset(offset)
        )
        if sport:
            stmt = stmt.where(AlertRow.sport == sport)
        if kind:
            stmt = stmt.where(AlertRow.kind == kind)
        if min_value is not None:
            stmt = stmt.where(AlertRow.value_percent >= min_value)
        if since is not None:
            stmt = stmt.where(AlertRow.detected_at >= since)
        async with self.session_factory() as session:
            return list((await session.execute(stmt)).scalars().all())

    async def list_odds(self, event_id: str, *, limit: int = 500) -> list[dict[str, Any]]:
        """Letzter bekannter Preis je (Markt, Selektion, Buchmacher)."""
        stmt = (
            select(
                Market.market_key,
                Market.market_type,
                Market.line,
                Market.period,
                SelectionRow.selection_key,
                SelectionRow.label,
                Bookmaker.key,
                OddsSnapshot.price,
                OddsSnapshot.ts,
                OddsSnapshot.suspended,
                OddsSnapshot.liquidity,
            )
            .join(SelectionRow, SelectionRow.market_id == Market.id)
            .join(OddsSnapshot, OddsSnapshot.selection_id == SelectionRow.id)
            .join(Bookmaker, Bookmaker.id == OddsSnapshot.bookmaker_id)
            .where(Market.event_id == event_id)
            .order_by(OddsSnapshot.ts.desc())
            .limit(limit)
        )
        async with self.session_factory() as session:
            rows = (await session.execute(stmt)).all()
        seen: set[tuple[str, str, str]] = set()
        out: list[dict[str, Any]] = []
        for row in rows:
            key = (row[0], row[4], row[6])
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "market": row[0],
                    "market_type": row[1],
                    "line": row[2],
                    "period": row[3],
                    "selection": row[4],
                    "selection_label": row[5],
                    "bookmaker": row[6],
                    "price": row[7],
                    "ts": row[8],
                    "suspended": row[9],
                    "liquidity": row[10],
                }
            )
        return out

    async def list_provider_health(self) -> list[ProviderHealthRow]:
        async with self.session_factory() as session:
            return list((await session.execute(select(ProviderHealthRow))).scalars().all())

    async def stats(self, *, window_hours: int = 24) -> dict[str, Any]:
        since = datetime.now(UTC) - timedelta(hours=window_hours)
        async with self.session_factory() as session:
            events_total = (await session.execute(select(func.count(Event.id)))).scalar_one()
            events_live = (
                await session.execute(select(func.count(Event.id)).where(Event.status == "LIVE"))
            ).scalar_one()
            alerts_total = (await session.execute(select(func.count(AlertRow.id)))).scalar_one()
            alerts_window = (
                await session.execute(
                    select(func.count(AlertRow.id)).where(AlertRow.detected_at >= since)
                )
            ).scalar_one()
            avg_value = (
                await session.execute(
                    select(func.avg(AlertRow.value_percent)).where(AlertRow.detected_at >= since)
                )
            ).scalar()
            snapshots = (await session.execute(select(func.count(OddsSnapshot.id)))).scalar_one()
            bookmakers = (await session.execute(select(func.count(Bookmaker.id)))).scalar_one()
            by_kind = (
                await session.execute(
                    select(AlertRow.kind, func.count(AlertRow.id))
                    .where(AlertRow.detected_at >= since)
                    .group_by(AlertRow.kind)
                )
            ).all()
        return {
            "events_total": events_total,
            "events_live": events_live,
            "alerts_total": alerts_total,
            "alerts_window": alerts_window,
            "alerts_by_kind": {row[0]: row[1] for row in by_kind},
            "avg_value_percent": round(float(avg_value), 2) if avg_value is not None else None,
            "odds_snapshots": snapshots,
            "bookmakers": bookmakers,
            "window_hours": window_hours,
        }

    # ------------------------------------------------------------- Benutzer
    async def get_or_create_user(
        self,
        telegram_id: int,
        *,
        username: str | None = None,
        first_name: str | None = None,
        is_admin: bool = False,
    ) -> tuple[User, UserSettings]:
        async with self.session_factory() as session:
            user = (
                await session.execute(select(User).where(User.telegram_id == telegram_id))
            ).scalar_one_or_none()
            if user is None:
                user = User(
                    telegram_id=telegram_id,
                    username=username,
                    first_name=first_name,
                    is_admin=is_admin,
                )
                session.add(user)
                await session.flush()
                settings = UserSettings(user_id=user.id)
                session.add(settings)
                await session.commit()
                await session.refresh(user)
                await session.refresh(settings)
                return user, settings

            settings = (
                await session.execute(select(UserSettings).where(UserSettings.user_id == user.id))
            ).scalar_one_or_none()
            if settings is None:
                settings = UserSettings(user_id=user.id)
                session.add(settings)
            if username and user.username != username:
                user.username = username
            await session.commit()
            await session.refresh(settings)
            return user, settings

    async def update_user_settings(self, telegram_id: int, **values: Any) -> UserSettings | None:
        async with self.session_factory() as session:
            user = (
                await session.execute(select(User).where(User.telegram_id == telegram_id))
            ).scalar_one_or_none()
            if user is None:
                return None
            settings = (
                await session.execute(select(UserSettings).where(UserSettings.user_id == user.id))
            ).scalar_one_or_none()
            if settings is None:
                settings = UserSettings(user_id=user.id)
                session.add(settings)
                await session.flush()
            for key, value in values.items():
                if value is not None and hasattr(settings, key):
                    setattr(settings, key, value)
            await session.commit()
            await session.refresh(settings)
            return settings

    async def list_active_users(self) -> list[tuple[User, UserSettings]]:
        async with self.session_factory() as session:
            rows = (
                await session.execute(
                    select(User, UserSettings)
                    .join(UserSettings, UserSettings.user_id == User.id)
                    .where(User.active.is_(True))
                )
            ).all()
        return [(row[0], row[1]) for row in rows]

    # ---------------------------------------------------------------- Pflege
    async def prune(self, *, snapshot_days: int = 7, alert_days: int = 30) -> dict[str, int]:
        """Alte Zeitreihen aufräumen - sonst wächst die Datenbank unbegrenzt."""
        now = datetime.now(UTC)
        async with self.session_factory() as session:
            snap = await session.execute(
                delete(OddsSnapshot).where(OddsSnapshot.ts < now - timedelta(days=snapshot_days))
            )
            chg = await session.execute(
                delete(OddsChangeRow).where(OddsChangeRow.ts < now - timedelta(days=snapshot_days))
            )
            alr = await session.execute(
                delete(AlertRow).where(AlertRow.detected_at < now - timedelta(days=alert_days))
            )
            await session.commit()
        return {
            "odds_snapshots": snap.rowcount or 0,
            "odds_changes": chg.rowcount or 0,
            "alerts": alr.rowcount or 0,
        }


def bulk_chunks(items: Iterable, size: int):
    chunk: list = []
    for item in items:
        chunk.append(item)
        if len(chunk) >= size:
            yield chunk
            chunk = []
    if chunk:
        yield chunk
