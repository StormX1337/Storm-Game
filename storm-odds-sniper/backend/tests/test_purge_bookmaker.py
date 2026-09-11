"""Aufräumen darf nie mehr mitnehmen als gemeint.

Löschen ist nicht rückgängig zu machen, und das Wett-Tagebuch ist der
einzige Ort, an dem steht, was ein Mensch tatsächlich gespielt hat. Alles
andere kann der Scanner neu sammeln - diese Zeilen kann niemand
rekonstruieren. Die drei Sicherungen des Skripts sind deshalb keine
Höflichkeit, sondern die eigentliche Funktion.
"""

from __future__ import annotations

import importlib.util
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import func, select

from backend.database.tables import AlertRow, Bet, Bookmaker, OddsSnapshot

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "purge_bookmaker.py"


def load_script():
    spec = importlib.util.spec_from_file_location("purge_bookmaker", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def script():
    return load_script()


async def _befuellen(repository):
    """Ein Mock-Buchmacher mit Daten - und eine echte Wette darauf."""
    async with repository.session_factory() as session:
        buch = Bookmaker(key="MockSharp", title="", is_exchange=False)
        echt = Bookmaker(key="pinnacle", title="", is_exchange=False)
        session.add_all([buch, echt])
        await session.flush()
        session.add_all(
            [
                OddsSnapshot(
                    selection_id=1,
                    bookmaker_id=buch.id,
                    price=2.5,
                    ts=datetime.now(UTC),
                    received_at=datetime.now(UTC),
                    provider="mock",
                ),
                OddsSnapshot(
                    selection_id=1,
                    bookmaker_id=echt.id,
                    price=2.4,
                    ts=datetime.now(UTC),
                    received_at=datetime.now(UTC),
                    provider="sgo",
                ),
                AlertRow(
                    kind="value",
                    event_id="e1",
                    sport="football",
                    market_key="m",
                    selection_key="s",
                    bookmaker="MockSharp",
                    odds=2.5,
                    fair_odds=2.3,
                    value_percent=8.0,
                    deviation_percent=8.0,
                    confidence=70,
                    error_score=70,
                    bookmaker_count=4,
                    fingerprint="f-mock",
                    detected_at=datetime.now(UTC),
                ),
                AlertRow(
                    kind="value",
                    event_id="e2",
                    sport="football",
                    market_key="m",
                    selection_key="s",
                    bookmaker="pinnacle",
                    odds=2.4,
                    fair_odds=2.3,
                    value_percent=4.0,
                    deviation_percent=4.0,
                    confidence=70,
                    error_score=70,
                    bookmaker_count=4,
                    fingerprint="f-echt",
                    detected_at=datetime.now(UTC),
                ),
                Bet(
                    event_id="e1",
                    event_title="Echte Wette",
                    sport="football",
                    market_key="m",
                    market_label="M",
                    selection_key="s",
                    selection_label="S",
                    bookmaker="MockSharp",
                    odds=2.5,
                    stake=10.0,
                    status="open",
                    note="",
                    placed_at=datetime.now(UTC),
                    stake_unit="percent",
                ),
            ]
        )
        await session.commit()


async def _anzahl(repository, modell, *bedingungen):
    async with repository.session_factory() as session:
        stmt = select(func.count()).select_from(modell)
        for bedingung in bedingungen:
            stmt = stmt.where(bedingung)
        return int((await session.execute(stmt)).scalar() or 0)


class TestTrockenlauf:
    async def test_zaehlt_ohne_zu_veraendern(self, script, repository):
        await _befuellen(repository)
        async with repository.session_factory() as session:
            stand = await script.zaehlen(session, "Mock%")
        assert [b.key for b in stand["buecher"]] == ["MockSharp"]
        assert stand["alerts"] == 1
        assert stand["snapshots"] == 1
        assert stand["bets"] == 1
        # Nichts angefasst.
        assert await _anzahl(repository, Bookmaker) == 2
        assert await _anzahl(repository, AlertRow) == 2


class TestLoeschen:
    async def test_nimmt_nur_das_gemeinte_mit(self, script, repository):
        await _befuellen(repository)
        async with repository.session_factory() as session:
            stand = await script.zaehlen(session, "Mock%")
            await script.loeschen(session, "Mock%", stand)

        assert await _anzahl(repository, Bookmaker, Bookmaker.key == "MockSharp") == 0
        assert await _anzahl(repository, AlertRow, AlertRow.bookmaker == "MockSharp") == 0
        assert await _anzahl(repository, OddsSnapshot) == 1  # der echte bleibt
        # Der echte Buchmacher ist unberührt.
        assert await _anzahl(repository, Bookmaker, Bookmaker.key == "pinnacle") == 1
        assert await _anzahl(repository, AlertRow, AlertRow.bookmaker == "pinnacle") == 1

    async def test_das_wett_tagebuch_bleibt_unangetastet(self, script, repository):
        """Die wichtigste Zusage des Skripts. Was ein Mensch gespielt hat,
        kann niemand rekonstruieren - auch nicht aus einer Sicherung, die
        jemand vergessen hat anzulegen."""
        await _befuellen(repository)
        async with repository.session_factory() as session:
            stand = await script.zaehlen(session, "Mock%")
            await script.loeschen(session, "Mock%", stand)
        assert await _anzahl(repository, Bet, Bet.bookmaker == "MockSharp") == 1


class TestZuBreiteMuster:
    def test_alles_treffende_muster_sind_hinterlegt(self, script):
        for muster in ("%", "%%", "_%", "%_"):
            assert muster in script.ZU_BREIT

    def test_ein_echtes_muster_ist_nicht_betroffen(self, script):
        for muster in ("Mock%", "%bet%", "test_"):
            assert muster not in script.ZU_BREIT
