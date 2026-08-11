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
