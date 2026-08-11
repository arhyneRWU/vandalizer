"""The estimate is checked against what the model actually charged.

Every successful response reports `usage.input_tokens`. That is ground truth,
it is free, and until now it was never compared against what the planner
believed. Bug #1 hid for months because nothing made that comparison.
"""

from __future__ import annotations

from app.services.token_estimate_check import evaluate_estimate


class TestEvaluateEstimate:
    def test_an_estimate_above_the_charge_is_not_reported(self):
        """The safe direction. Erring high is the intended behaviour."""
        assert evaluate_estimate(
            model="m", estimated=25_877, charged=25_402, input_budget=24_576
        ) is None

    def test_an_exact_estimate_is_not_reported(self):
        assert evaluate_estimate(
            model="m", estimated=1_000, charged=1_000, input_budget=24_576
        ) is None

    def test_an_estimate_below_the_charge_is_a_warning(self):
        """Read low but still fit: latent, not yet user-visible."""
        result = evaluate_estimate(
            model="m", estimated=2_154, charged=2_527, input_budget=24_576
        )
        assert result is not None
        assert result.severity == "warning"
        assert result.shortfall == 373

    def test_an_estimate_that_hid_an_overflow_is_critical(self):
        """The bug #1 failure exactly: planner said 23,592 against a 24,576
        budget -- 'fits, 984 spare' -- and the model charged 25,402 and
        rejected it. If this recurs it must be loud immediately."""
        result = evaluate_estimate(
            model="m", estimated=23_592, charged=25_402, input_budget=24_576
        )
        assert result is not None
        assert result.severity == "critical"
        assert result.shortfall == 1_810

    def test_a_charge_that_exactly_fills_the_budget_still_fit(self):
        """The severity boundary, which the cases above sit far away from.

        24,576 charged against a 24,576 budget fits exactly -- the request was
        answered -- so the low estimate is latent, not the bug #1 failure. Pins
        the comparison as ``>`` and not ``>=``, which an off-by-one refactor
        would otherwise flip without failing a single other test.
        """
        result = evaluate_estimate(
            model="m", estimated=24_000, charged=24_576, input_budget=24_576
        )
        assert result is not None
        assert result.severity == "warning"
        assert result.shortfall == 576

    def test_carries_the_numbers_needed_to_act(self):
        result = evaluate_estimate(
            model="Qwen/Qwen3.5-9B", estimated=100, charged=150, input_budget=1_000
        )
        assert result.model == "Qwen/Qwen3.5-9B"
        assert result.estimated == 100
        assert result.charged == 150
        assert result.input_budget == 1_000

    def test_missing_usage_is_not_a_shortfall(self):
        """Providers that report no usage must not look like an under-count."""
        assert evaluate_estimate(
            model="m", estimated=100, charged=0, input_budget=1_000
        ) is None


import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.token_estimate_check import EstimateShortfall, record_shortfall


def _shortfall(severity="warning"):
    return EstimateShortfall(
        model="Qwen/Qwen3.5-9B", estimated=2_154, charged=2_527,
        input_budget=24_576, severity=severity,
    )


class TestRecordShortfall:
    @pytest.mark.asyncio
    async def test_creates_an_alert_when_none_is_outstanding(self):
        with patch("app.models.quality_alert.QualityAlert") as MockAlert:
            MockAlert.find_one = AsyncMock(return_value=None)
            MockAlert.return_value.insert = AsyncMock()

            await record_shortfall(_shortfall())

            MockAlert.assert_called_once()
            kwargs = MockAlert.call_args.kwargs
            assert kwargs["alert_type"] == "token_undercount"
            assert kwargs["item_kind"] == "model"
            assert kwargs["item_id"] == "Qwen/Qwen3.5-9B"
            assert kwargs["severity"] == "warning"

    @pytest.mark.asyncio
    async def test_does_not_duplicate_an_unacknowledged_alert(self):
        """Dedupe-by-unacknowledged is the convention in quality_tasks.py.
        Chat volume would otherwise bury the alerts table."""
        existing = MagicMock(severity="warning")
        existing.save = AsyncMock()
        with patch("app.models.quality_alert.QualityAlert") as MockAlert:
            MockAlert.find_one = AsyncMock(return_value=existing)

            await record_shortfall(_shortfall())

            MockAlert.assert_not_called()

    @pytest.mark.asyncio
    async def test_escalates_an_existing_warning_to_critical(self):
        """Otherwise the first mild case masks the real failure — which is
        the exact shape of bug this feature exists to catch."""
        existing = MagicMock(severity="warning")
        existing.save = AsyncMock()
        with patch("app.models.quality_alert.QualityAlert") as MockAlert:
            MockAlert.find_one = AsyncMock(return_value=existing)

            await record_shortfall(_shortfall(severity="critical"))

            assert existing.severity == "critical"
            existing.save.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_does_not_downgrade_an_existing_critical(self):
        existing = MagicMock(severity="critical")
        existing.save = AsyncMock()
        with patch("app.models.quality_alert.QualityAlert") as MockAlert:
            MockAlert.find_one = AsyncMock(return_value=existing)

            await record_shortfall(_shortfall(severity="warning"))

            assert existing.severity == "critical"
            existing.save.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_database_failure_does_not_propagate(self):
        """This runs off the back of a chat response. A diagnostic must never
        break the product it is diagnosing."""
        with patch("app.models.quality_alert.QualityAlert") as MockAlert:
            MockAlert.find_one = AsyncMock(side_effect=RuntimeError("mongo down"))

            await record_shortfall(_shortfall())  # must not raise
