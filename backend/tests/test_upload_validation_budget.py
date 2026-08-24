"""Upload compliance validation on an exhausted trial budget.

The chunk and summary tasks are attributed to the uploader so trial spend is
metered. When the budget is gone the check must degrade to "not checked" —
never a retry storm that leaves the document stuck in ``validating``.
"""

from unittest.mock import MagicMock, patch

from app.exceptions import TrialBudgetExceededError
from app.tasks import upload_validation_tasks as uv


def _budget_exhausted(user_id):
    raise TrialBudgetExceededError("nope")


def test_validate_chunk_marks_skipped_when_budget_exhausted():
    agent = MagicMock()
    with patch.object(uv, "_get_secure_agent", return_value=agent), \
         patch("app.services.trial_budget.check_sync", side_effect=_budget_exhausted):
        result = uv.validate_chunk.apply(
            args=("doc.pdf", "rules", "text", 1, 2), kwargs={"user_id": "trial-u"},
        ).get()

    assert result["skipped"] is True
    assert result["valid"] is True
    assert result["index"] == 1
    agent.run_sync.assert_not_called()


def test_validate_chunk_without_user_is_not_budget_checked():
    agent = MagicMock()
    agent.run_sync.return_value = MagicMock(output='{"valid": true, "feedback": "fine"}')
    with patch.object(uv, "_get_secure_agent", return_value=agent), \
         patch("app.services.trial_budget.check_sync", side_effect=_budget_exhausted) as chk, \
         patch("app.services.metering.flush_sync"):
        result = uv.validate_chunk.apply(args=("doc.pdf", "rules", "text", 1, 1)).get()

    chk.assert_not_called()
    assert result == {"valid": True, "feedback": "fine", "index": 1}


def test_summarize_reports_skipped_sections_without_spending_more():
    db = MagicMock()
    agent = MagicMock()
    results = [
        {"valid": True, "feedback": "ok", "index": 1},
        {"valid": True, "feedback": uv.BUDGET_SKIPPED_FEEDBACK, "index": 2, "skipped": True},
    ]
    with patch.object(uv, "_get_db", return_value=db), \
         patch.object(uv, "_get_secure_agent", return_value=agent):
        summary = uv.summarize_results.apply(
            args=(results, "doc-uuid", True), kwargs={"user_id": "trial-u"},
        ).get()

    agent.run_sync.assert_not_called()
    assert summary["valid"] is True
    assert "1 of 2 sections were not checked" in summary["feedback"]
    written = db.smart_document.update_one.call_args.args[1]["$set"]
    assert written["validating"] is False
    assert "not checked" in written["validation_feedback"]
