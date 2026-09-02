"""Tests for app.tasks.activity_tasks.generate_activity_description_task.

Activity title generation is best-effort cosmetic enrichment; an LLM outage
must degrade gracefully (activity goes untitled) and log at warning, not page
Sentry as a fault.
"""

from unittest.mock import MagicMock, patch

from bson import ObjectId
from pydantic_ai.exceptions import ModelAPIError


def _db_with_activity():
    db = MagicMock()
    activity_oid = ObjectId()
    db.activity_event.find_one.return_value = {
        "_id": activity_oid, "user_id": "u1", "team_id": None,
    }
    # A document with text so the prompt has context and we reach the model call.
    db.smart_document.find_one.return_value = {
        "uuid": "doc-1", "title": "NSF_Grant.pdf", "raw_text": "Grant proposal body.",
    }
    db.user_model_config.find_one.return_value = None
    db.system_config.find_one.return_value = {}
    return db, str(activity_oid)


class TestGenerateActivityDescription:
    def test_model_connection_error_warns_and_marks_done(self):
        import app.tasks.activity_tasks as at

        db, activity_id = _db_with_activity()
        err = ModelAPIError(model_name="VandalAI-Fast", message="Connection error.")

        with patch.object(at, "_get_db", return_value=db), \
             patch.object(at, "_pick_title_model", return_value="VandalAI-Fast"), \
             patch("app.services.llm_service.create_chat_agent", return_value=MagicMock()), \
             patch("app.services.metering.metered", return_value=MagicMock()), \
             patch.object(at, "run_task_async", side_effect=err), \
             patch.object(at, "logger") as mock_logger:
            result = at.generate_activity_description_task(
                activity_id=activity_id,
                activity_type="conversation",
                document_uuids=["doc-1"],
            )

        assert result is None
        # Handled degradation: warning, never error/exception (no Sentry event).
        mock_logger.error.assert_not_called()
        mock_logger.exception.assert_not_called()
        assert mock_logger.warning.called
        # The activity is still marked done so the UI stops shimmering.
        set_ops = [c[0][1]["$set"] for c in db.activity_event.update_one.call_args_list]
        assert any(s.get("meta_summary.description_generated") for s in set_ops)


class TestReapStaleRunning:
    """A run parked on an approval gate is waiting on a person, not stalled.

    It stops reporting progress by design, so the elapsed-time sweep used to
    mark every review left overnight as a timeout and fail the run's activity.
    """

    def _reap(self, pending_uuids=(), stale_extractions=()):
        """Run the task and return (elapsed_time_query, decided_review_query)."""
        import app.tasks.activity_tasks as at

        db = MagicMock()
        db.activity_event.find.return_value = list(stale_extractions)
        db.activity_event.update_many.return_value = MagicMock(modified_count=0)
        db.approval_request.find.return_value = [{"uuid": u} for u in pending_uuids]
        with patch.object(at, "_get_db", return_value=db), \
             patch.object(at, "_resolve_stale_threshold_minutes", return_value=30), \
             patch("app.services.failure_notifications.notify_extraction_failed") as notify:
            at.reap_stale_running_task()
        self.last_db = db
        self.last_notify = notify
        calls = db.activity_event.update_many.call_args_list
        assert len(calls) == 2, f"expected two sweeps, got {len(calls)}"
        return calls[0][0][0], calls[1][0][0]

    def test_skips_runs_awaiting_approval(self):
        elapsed, _ = self._reap()
        # `None` matches both a null field and a missing one, so ordinary
        # activities (which never carry the key) stay in scope.
        assert elapsed["meta_summary.pending_review_uuid"] is None

    def test_still_targets_stuck_running_events(self):
        elapsed, _ = self._reap()
        assert elapsed["status"] == {"$in": ["running", "queued"]}
        assert "$lt" in elapsed["last_updated_at"]

    def test_a_row_parked_on_a_decided_review_is_still_reaped(self):
        """The exemption was unbounded. approve_review returns as soon as the
        resume task is dispatched, and the marker is cleared deep inside that
        task, after guards that raise. A lost message or a tripped guard left
        the row at "running" forever — the exact condition the reaper exists to
        catch, made unreachable by its own exemption.
        """
        _elapsed, decided = self._reap(pending_uuids=["still-waiting"])

        # Reaps rows carrying a marker that is not one of the pending reviews.
        assert decided["meta_summary.pending_review_uuid"]["$nin"] == [
            None, "still-waiting",
        ]
        assert decided["status"] == {"$in": ["running", "queued"]}
        assert "$lt" in decided["last_updated_at"]

    def test_a_row_parked_on_a_review_still_awaiting_a_decision_is_left_alone(self):
        _elapsed, decided = self._reap(pending_uuids=["a", "b"])
        excluded = decided["meta_summary.pending_review_uuid"]["$nin"]
        assert "a" in excluded and "b" in excluded

    def test_the_decided_sweep_clears_the_marker_it_reaps(self):
        """Otherwise the row stays exempt from the first sweep forever."""
        import app.tasks.activity_tasks as at

        db = MagicMock()
        db.activity_event.find.return_value = []
        db.activity_event.update_many.return_value = MagicMock(modified_count=0)
        db.approval_request.find.return_value = []
        with patch.object(at, "_get_db", return_value=db), \
             patch.object(at, "_resolve_stale_threshold_minutes", return_value=30):
            at.reap_stale_running_task()

        update = db.activity_event.update_many.call_args_list[1][0][1]
        assert update["$unset"] == {"meta_summary.pending_review_uuid": ""}
        assert update["$set"]["status"] == "failed"

    def test_a_reaped_extraction_rings_the_owners_bell(self):
        """A reaped run previously failed in total silence: the rail said
        "Timed out" and nobody was told. Extraction runs are notified from
        this sweep because it is their only backstop."""
        self._reap(stale_extractions=[{
            "_id": "a1", "user_id": "u1",
            "search_set_uuid": "ss-1", "title": "Award terms",
        }])
        self.last_notify.assert_called_once()
        kwargs = self.last_notify.call_args.kwargs
        assert kwargs["user_id"] == "u1"
        assert kwargs["search_set_uuid"] == "ss-1"
        assert kwargs["search_set_name"] == "Award terms"

    def test_workflow_and_conversation_rows_do_not_ring_from_this_sweep(self):
        """Workflow runs are notified by reap_stale_workflow_runs_task with
        run-level truth; ringing here too would double the bell. The find that
        feeds notifications must therefore select extraction rows only."""
        self._reap()
        self.last_notify.assert_not_called()
        find_filter = self.last_db.activity_event.find.call_args[0][0]
        assert find_filter["type"] == "search_set_run"


class TestReapStaleWorkflowRuns:
    """A worker that dies mid-run (OOM, hard time limit, deploy) leaves the
    WorkflowResult at "running" with no failure handler ever firing. The SSE
    poller returns only on terminal status, so it streamed forever and Run
    History spun indefinitely. This reaper is the backstop.
    """

    def _reap(self, stuck=(), parked=(), approvals=None, flip_modified=1):
        import app.tasks.activity_tasks as at

        db = MagicMock()
        # First find: the heartbeat/never-started sweep. Second: pending_approval.
        db.workflow_result.find.side_effect = [list(stuck), list(parked)]
        db.workflow_result.update_one.return_value = MagicMock(
            modified_count=flip_modified,
        )
        db.activity_event.find_one_and_update.return_value = {"user_id": "runner"}
        db.approval_request.find_one.side_effect = lambda *a, **k: approvals
        db.workflow.find_one.return_value = {"name": "WF", "user_id": "owner"}
        with patch.object(at, "_get_db", return_value=db), \
             patch("app.services.failure_notifications.notify_workflow_failed") as notify:
            at.reap_stale_workflow_runs_task()
        return db, notify

    def _run(self, **over):
        base = {
            "_id": ObjectId(), "workflow": ObjectId(),
            "session_id": "s1", "status": "running",
            "last_progress_at": "old",
        }
        base.update(over)
        return base

    def test_sweep_query_matches_dead_heartbeats_and_never_started_rows(self):
        db, _ = self._reap()
        query = db.workflow_result.find.call_args_list[0][0][0]
        stale, never_started = query["$or"]
        assert stale["status"] == "running"
        assert "$lt" in stale["last_progress_at"]
        # `None` matches null or missing, so rows predating the heartbeat
        # field fall into the gentler day-old sweep, not the strict one.
        assert never_started["last_progress_at"] is None
        assert "$lt" in never_started["start_time"]

    def test_dead_run_is_failed_synced_to_rail_and_notifies_owner(self):
        run = self._run()
        db, notify = self._reap(stuck=[run])

        flip_filter, flip_update = db.workflow_result.update_one.call_args[0]
        assert flip_filter == {"_id": run["_id"], "status": "running"}
        assert flip_update["$set"]["status"] == "error"

        rail_filter = db.activity_event.find_one_and_update.call_args[0][0]
        assert {"workflow_result": run["_id"]} in rail_filter["$or"]
        assert {"workflow_session_id": "s1"} in rail_filter["$or"]

        notify.assert_called_once()
        assert notify.call_args.kwargs["user_id"] == "runner"

    def test_a_run_that_finished_between_find_and_flip_is_left_alone(self):
        """The flip filters on the status the sweep matched; zero modified
        means the run reached a real terminal state first — no bell."""
        db, notify = self._reap(stuck=[self._run()], flip_modified=0)
        db.activity_event.find_one_and_update.assert_not_called()
        notify.assert_not_called()

    def test_approved_but_never_resumed_run_is_reaped(self):
        """approve_review dispatches a resume message and returns. If that
        message is lost the run sits at pending_approval forever while the
        reviewer believes they released it."""
        import datetime as dt

        run = self._run(status="pending_approval", approval_request_id="ap-1")
        run.pop("last_progress_at")
        old = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)
        # Naive on purpose: pymongo returns naive UTC datetimes by default.
        db, notify = self._reap(
            parked=[run],
            approvals={"status": "approved", "decision_at": old.replace(tzinfo=None)},
        )
        flip_filter, flip_update = db.workflow_result.update_one.call_args[0]
        assert flip_filter["status"] == "pending_approval"
        assert "approved but never resumed" in flip_update["$set"]["error"]
        notify.assert_called_once()

    def test_a_run_whose_review_is_still_pending_is_left_alone(self):
        run = self._run(status="pending_approval", approval_request_id="ap-1")
        run.pop("last_progress_at")
        db, notify = self._reap(parked=[run], approvals={"status": "pending"})
        db.workflow_result.update_one.assert_not_called()
        notify.assert_not_called()

    def test_a_recently_approved_run_is_given_time_to_resume(self):
        """A resume can be in flight or in Celery retry backoff; only a
        decision older than the stale cutoff is evidence of a lost message."""
        import datetime as dt

        run = self._run(status="pending_approval", approval_request_id="ap-1")
        run.pop("last_progress_at")
        recent = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)
        db, notify = self._reap(
            parked=[run],
            approvals={"status": "approved", "decision_at": recent},
        )
        db.workflow_result.update_one.assert_not_called()
        notify.assert_not_called()


class TestWorkflowTasksAckLate:
    """Workers ack on delivery by default, so a worker death loses the message
    for good and no failure path ever runs. These two tasks are safe to
    redeliver — resume-at-step skips completed steps and the atomic
    finalized_at claim keeps side effects single-shot — so they opt in. Other
    task families have NOT been audited for idempotency; do not widen this to
    a global setting.
    """

    def test_execution_and_resume_ack_late_and_requeue_on_worker_loss(self):
        import app.tasks.workflow_tasks as wt

        for task in (wt.execute_workflow_task, wt.resume_workflow_after_approval):
            assert task.acks_late is True
            assert task.reject_on_worker_lost is True
