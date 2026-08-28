"""A judge that cannot be reached must not score 0.0.

`judge_field_value` returned `{"score": 0.0, "verdict": "FAIL"}` on any
exception. A provider outage during an optimizer run was therefore
indistinguishable from a quality collapse: every field scored zero, the trial
recorded a catastrophic accuracy, and that number went into the quality history
permanently — where the next comparison reads it as a regression and fires an
alert about a problem that never existed.

The judge now reports `JUDGE_UNAVAILABLE` with `score=None`, aggregates exclude
it, and a trial the judge did not cover is discarded rather than published.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import extraction_judge
from app.services.extraction_judge import (
    JUDGE_UNAVAILABLE,
    is_judge_unavailable,
    judge_test_case_extraction,
)
from app.services.extraction_optimizer import (
    MIN_JUDGE_COVERAGE,
    _covered_score_to_unit,
    _judge_covered,
    _to_trial_summary,
)


class TestVerdict:
    @pytest.mark.asyncio
    async def test_outage_is_not_a_failing_score(self):
        agent = MagicMock()
        agent.run = AsyncMock(side_effect=RuntimeError("502 Bad Gateway"))
        with (
            # The deterministic pre-judge would resolve this pair without an
            # LLM call; this test is about the path that does reach the judge.
            patch("app.services.extraction_judge_router.prejudge", return_value=None),
            patch.object(extraction_judge, "_ensure_system_config_loaded",
                         new=AsyncMock(return_value=None)),
            patch.object(extraction_judge, "_get_agent", return_value=agent),
        ):
            out = await extraction_judge.judge_field_value(
                field_name="Award Amount", expected="$4,200,000",
                actual="$4,200,000", model_name="m",
            )
        assert out["verdict"] == JUDGE_UNAVAILABLE
        assert out["score"] is None
        assert out["comparator"] == "llm_error"

    def test_is_judge_unavailable_only_matches_the_outage_verdict(self):
        assert is_judge_unavailable({"verdict": JUDGE_UNAVAILABLE})
        assert not is_judge_unavailable({"verdict": "FAIL", "score": 0.0})
        assert not is_judge_unavailable({"verdict": "PASS", "score": 1.0})
        assert not is_judge_unavailable(None)


class TestTestCaseAggregate:
    @pytest.mark.asyncio
    async def test_unavailable_field_is_excluded_not_zeroed(self):
        """Two fields scored 1.0 and one unreachable is 1.0, not 0.67."""
        verdicts = {
            "PI Name": {"score": 1.0, "verdict": "PASS", "reasoning": "", "tokens_used": 5},
            "Amount": {"score": 1.0, "verdict": "PASS", "reasoning": "", "tokens_used": 5},
            "Award Date": {"score": None, "verdict": JUDGE_UNAVAILABLE,
                           "reasoning": "judge unavailable: timeout", "tokens_used": 0},
        }

        async def fake_judge(field_name, expected, actual, model_name, field_metadata=None):
            return verdicts[field_name]

        with patch.object(extraction_judge, "judge_field_value",
                          new=AsyncMock(side_effect=fake_judge)):
            out = await judge_test_case_extraction(
                keys=["PI Name", "Amount", "Award Date"],
                expected={"PI Name": "Smith", "Amount": "$1000", "Award Date": "2026-01-05"},
                actual={"PI Name": "Smith", "Amount": "$1000", "Award Date": "2026-01-05"},
                model_name="m",
            )

        assert out["avg_score"] == pytest.approx(1.0)
        assert out["num_fields_judged"] == 2
        assert out["num_fields_unavailable"] == 1
        assert out["judge_coverage"] == pytest.approx(2 / 3, abs=1e-4)

    @pytest.mark.asyncio
    async def test_full_coverage_when_every_field_answered(self):
        async def fake_judge(field_name, expected, actual, model_name, field_metadata=None):
            return {"score": 0.5, "verdict": "PARTIAL", "reasoning": "", "tokens_used": 1}

        with patch.object(extraction_judge, "judge_field_value",
                          new=AsyncMock(side_effect=fake_judge)):
            out = await judge_test_case_extraction(
                keys=["A", "B"], expected={"A": "1", "B": "2"},
                actual={"A": "1", "B": "2"}, model_name="m",
            )
        assert out["judge_coverage"] == 1.0
        assert out["num_fields_unavailable"] == 0


class TestCoverageFloor:
    def test_uncovered_trial_is_not_scored(self):
        summary = _to_trial_summary(
            {
                "label": "candidate-a", "model": "m", "config_override": {},
                "accuracy": 0.02, "consistency": 0.5, "score": 2.0,
                "judge_used": True, "judge_coverage": 0.1,
            },
            baseline_default_score=0.8,
        )
        assert summary["status"] == "judge_unavailable"
        assert summary["score"] is None
        assert summary["accuracy"] is None
        assert summary["lift_vs_default"] is None
        assert "10%" in summary["error"]

    def test_covered_trial_keeps_its_score(self):
        summary = _to_trial_summary(
            {
                "label": "candidate-b", "model": "m", "config_override": {},
                "accuracy": 0.9, "consistency": 0.9, "score": 90.0,
                "judge_used": True, "judge_coverage": 1.0,
            },
            baseline_default_score=0.8,
        )
        assert summary["status"] == "completed"
        assert summary["score"] == pytest.approx(0.9)
        assert summary["lift_vs_default"] == pytest.approx(0.1)

    def test_strict_match_trials_are_never_gated(self):
        """With no judge there is nothing to be unavailable — a strict-match
        trial must not be discarded for a coverage field it never sets."""
        summary = _to_trial_summary(
            {
                "label": "candidate-c", "model": "m", "config_override": {},
                "accuracy": 0.7, "consistency": 0.7, "score": 70.0,
                "judge_used": False,
            },
            baseline_default_score=None,
        )
        assert summary["status"] == "completed"
        assert summary["score"] == pytest.approx(0.7)

    def test_floor_is_the_boundary(self):
        at_floor = {"judge_used": True, "judge_coverage": MIN_JUDGE_COVERAGE}
        below = {"judge_used": True, "judge_coverage": MIN_JUDGE_COVERAGE - 0.01}
        assert _judge_covered(at_floor, "t")
        assert not _judge_covered(below, "t")

    def test_baseline_score_is_withheld_when_uncovered(self):
        """A baseline is the thing every later comparison is measured against —
        publishing an outage as the baseline poisons every one of them."""
        uncovered = {"score": 5.0, "judge_used": True, "judge_coverage": 0.2}
        covered = {"score": 80.0, "judge_used": True, "judge_coverage": 0.95}
        assert _covered_score_to_unit(uncovered, "baseline-default") is None
        assert _covered_score_to_unit(covered, "baseline-default") == pytest.approx(0.8)
