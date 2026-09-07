"""Nachvollziehbarkeit: warum kein Alarm - und woraus ein Alarm entstand.

Ein korrekt arbeitendes, aber zu streng eingestelltes System sieht von außen
identisch aus wie ein kaputtes. Diese beiden Funktionen machen den
Unterschied sichtbar.
"""

from __future__ import annotations

import pytest

from backend.core.filters import SUPPRESSION_LABELS, FilterThresholds, check_quote
from backend.models.domain import Alert, now_ts
from backend.models.enums import AlertKind
from backend.scanner.engine import ScannerEngine
from backend.telegram import formatting as fmt
from backend.tests.conftest import make_event, make_quote
from backend.tests.test_scanner import market_message, scanner_settings


class TestSuppressionCodes:
    def test_codes_are_stable_regardless_of_the_measured_value(self):
        """Sonst legt jede Alterszahl eine eigene Metrik-Zeitreihe an."""
        thresholds = FilterThresholds(max_odds_age_seconds=10.0)
        event = make_event()
        codes = {
            check_quote(
                make_quote(bookmaker="b", price=2.0, ts=now_ts() - age), event, thresholds
            ).code
            for age in (30, 45.5, 120, 999)
        }
        assert codes == {"stale"}

    def test_every_code_has_a_readable_label(self):
        thresholds = FilterThresholds(max_odds_age_seconds=10.0)
        decision = check_quote(
            make_quote(bookmaker="b", price=2.0, ts=now_ts() - 60), make_event(), thresholds
        )
        assert decision.code in SUPPRESSION_LABELS
        assert SUPPRESSION_LABELS[decision.code]

    def test_the_reason_keeps_the_measurement_for_the_log(self):
        thresholds = FilterThresholds(max_odds_age_seconds=10.0)
        decision = check_quote(
            make_quote(bookmaker="b", price=2.0, ts=now_ts() - 60), make_event(), thresholds
        )
        assert "60" in decision.reason


class TestSuppressionCounting:
    async def test_reasons_are_counted_and_reach_redis(self, redis_state):
        engine = ScannerEngine(
            scanner_settings(min_bookmakers=99),  # garantiert zu streng
            state=redis_state,
            repository=None,
            providers=[],
        )
        await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50}))
        await engine.handle_message(market_message({"b1": 2.40, "b2": 2.45, "b3": 3.80}))
        assert engine._suppressed, "es wurde nichts gezählt"

        await redis_state.add_suppressions(dict(engine._suppressed))
        stored = await redis_state.get_suppressions()
        assert stored
        assert all(code in SUPPRESSION_LABELS for code in stored), stored
        assert sum(stored.values()) == sum(engine._suppressed.values())

    async def test_counters_accumulate(self, redis_state):
        await redis_state.add_suppressions({"stale": 3})
        await redis_state.add_suppressions({"stale": 4, "cooldown": 1})
        assert await redis_state.get_suppressions() == {"stale": 7, "cooldown": 1}

    async def test_empty_batch_is_a_noop(self, redis_state):
        await redis_state.add_suppressions({})
        assert await redis_state.get_suppressions() == {}

    async def test_reset(self, redis_state):
        await redis_state.add_suppressions({"stale": 5})
        await redis_state.reset_suppressions()
        assert await redis_state.get_suppressions() == {}

    async def test_a_working_configuration_produces_alerts_not_suppressions(self, redis_state):
        engine = ScannerEngine(scanner_settings(), state=redis_state, repository=None, providers=[])
        await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42})
        )
        alerts = await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42, "off": 3.80})
        )
        assert alerts


class TestAlertProvenance:
    async def _alert(self, redis_state) -> Alert:
        engine = ScannerEngine(scanner_settings(), state=redis_state, repository=None, providers=[])
        await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42})
        )
        alerts = await engine.handle_message(
            market_message({"b1": 2.40, "b2": 2.45, "b3": 2.50, "b4": 2.42, "off": 3.80})
        )
        hits = [a for a in alerts if a.bookmaker == "off"]
        assert hits
        return hits[0]

    async def test_the_compared_prices_are_recorded(self, redis_state):
        alert = await self._alert(redis_state)
        assert set(alert.references) == {"b1", "b2", "b3", "b4"}
        assert alert.references["b1"] == pytest.approx(2.40)
        assert "off" not in alert.references, "die geprüfte Quote ist keine Referenz"

    async def test_all_three_models_are_recorded(self, redis_state):
        alert = await self._alert(redis_state)
        assert set(alert.fair_models) == {"median", "margin_removed", "weighted_consensus"}
        assert alert.fair_models["median"] > 1.0

    async def test_score_components_are_recorded(self, redis_state):
        alert = await self._alert(redis_state)
        assert alert.score_components
        assert sum(alert.score_components.values()) == pytest.approx(alert.error_score, abs=1.0)

    async def test_provenance_survives_serialisation(self, redis_state):
        alert = await self._alert(redis_state)
        restored = Alert.from_json(alert.to_json())
        assert restored.references == alert.references
        assert restored.fair_models == alert.fair_models
        assert restored.score_components == alert.score_components


class TestTelegramExplanation:
    def _alert(self, **overrides) -> Alert:
        from backend.tests.test_telegram import football_alert

        alert = football_alert(**overrides)
        alert.references = {"pinnacle": 2.62, "bet365": 2.70, "unibet": 2.71}
        alert.fair_models = {"median": 2.68, "margin_removed": 2.71, "weighted_consensus": 2.66}
        alert.score_components = {"deviation": 28.4, "breadth": 12.1, "quality": 8.0}
        return alert

    def test_the_comparison_is_shown(self):
        text = fmt.format_alert(self._alert())
        assert "Verglichen mit" in text
        assert "pinnacle 2.62" in text

    def test_the_models_are_shown(self):
        text = fmt.format_alert(self._alert())
        assert "Median 2.68" in text
        assert "margenbereinigt 2.71" in text

    def test_the_strongest_signals_are_shown(self):
        text = fmt.format_alert(self._alert())
        assert "Stärkste Signale" in text
        assert "Abweichung 28" in text

    def test_movement_alerts_stay_short(self):
        """Bewegungen haben keine faire Quote - eine Herleitung wäre sinnlos."""
        text = fmt.format_alert(self._alert(kind=AlertKind.ODDS_MOVE))
        assert "Verglichen mit" not in text

    def test_alerts_without_provenance_still_render(self):
        from backend.tests.test_telegram import football_alert

        text = fmt.format_alert(football_alert())
        assert "STORM ODDS SNIPER" in text
        assert "Verglichen mit" not in text

    def test_bookmaker_names_are_escaped(self):
        alert = self._alert()
        alert.references = {"<script>": 2.0}
        assert "<script>" not in fmt.format_alert(alert)
