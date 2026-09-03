"""Tests for the failure-notification emission sites.

`test_failure_notifications.py` covers the emitters themselves. This file covers
the wiring: that each kind of failure actually reaches an emitter, that a
mid-retry failure does not, and that a failed run no longer produces deliverables
it has no output for.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from bson import ObjectId


# ---------------------------------------------------------------------------
# Workflow runs
# ---------------------------------------------------------------------------


class TestMarkWorkflowFailed:
    def _db(self, *, user_id="alice"):
        db = MagicMock()
        db.workflow_result.find_one.return_value = {"workflow": ObjectId()}
        db.workflow.find_one.return_value = {
            "_id": ObjectId(), "name": "Budget Review", "user_id": "wf-owner",
        }
        db.activity_event.find_one.return_value = {"user_id": user_id}
        return db

    def test_notifies_the_user_who_launched_the_run(self):
        from app.tasks.workflow_tasks import _mark_workflow_failed

        db = self._db(user_id="alice")
        with patch(
            "app.services.failure_notifications.notify_workflow_failed"
        ) as notify:
            _mark_workflow_failed(db, str(ObjectId()), str(ObjectId()), "step 2 blew up")

        assert notify.call_args.kwargs["user_id"] == "alice"
        assert notify.call_args.kwargs["error"] == "step 2 blew up"

    def test_notify_false_suppresses_the_bell_entry(self):
        # Celery is going to retry — the run is not actually over.
        from app.tasks.workflow_tasks import _mark_workflow_failed

        db = self._db()
        with patch(
            "app.services.failure_notifications.notify_workflow_failed"
        ) as notify:
            _mark_workflow_failed(
                db, str(ObjectId()), str(ObjectId()), "blip", notify=False,
            )

        notify.assert_not_called()

    def test_run_and_activity_are_still_marked_failed(self):
        from app.tasks.workflow_tasks import _mark_workflow_failed

        db = self._db()
        with patch("app.services.failure_notifications.notify_workflow_failed"):
            _mark_workflow_failed(db, str(ObjectId()), str(ObjectId()), "boom")

        result_update = db.workflow_result.update_one.call_args.args[1]["$set"]
        assert result_update["status"] == "error"
        activity_update = db.activity_event.update_one.call_args.args[1]["$set"]
        assert activity_update["status"] == "failed"

    def test_notification_failure_does_not_break_the_task(self):
        from app.tasks.workflow_tasks import _mark_workflow_failed

        db = self._db()
        with patch(
            "app.services.failure_notifications.notify_workflow_failed",
            side_effect=RuntimeError("mongo down"),
        ):
            _mark_workflow_failed(db, str(ObjectId()), str(ObjectId()), "boom")


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------


class TestDocumentProcessingFailure:
    def test_uploader_is_notified_when_text_extraction_fails(self):
        from app.tasks.document_tasks import _notify_document_processing_failed

        db = MagicMock()
        db.smart_document.find_one.return_value = {
            "uuid": "d-1", "title": "grant.pdf", "user_id": "alice",
        }

        with patch(
            "app.services.failure_notifications.notify_document_failed"
        ) as notify:
            _notify_document_processing_failed(db, "d-1", "Text extraction failed: boom")

        assert notify.call_args.kwargs["doc"]["user_id"] == "alice"
        assert "boom" in notify.call_args.kwargs["error"]

    def test_deleted_document_is_a_no_op(self):
        from app.tasks.document_tasks import _notify_document_processing_failed

        db = MagicMock()
        db.smart_document.find_one.return_value = None

        with patch(
            "app.services.failure_notifications.notify_document_failed"
        ) as notify:
            _notify_document_processing_failed(db, "gone", "boom")

        # The emitter itself no-ops on a missing doc; assert we still called it
        # rather than crashing on the None.
        assert notify.call_args.kwargs["doc"] is None


# ---------------------------------------------------------------------------
# Extractions
# ---------------------------------------------------------------------------


class TestExtractionTaskFailure:
    def _run_and_capture(self, *, side_effect, retries=0):
        """Drive perform_extraction_task to its failure path."""
        from app.tasks.extraction_tasks import perform_extraction_task

        db = MagicMock()
        db.system_config.find_one.return_value = {}
        db.activity_event.find_one.return_value = {
            "user_id": "alice", "team_id": None, "type": "search_set_run",
        }

        engine = MagicMock()
        engine.extract.side_effect = side_effect

        with (
            patch("app.tasks.extraction_tasks._get_db", return_value=db),
            patch(
                "app.services.extraction_engine.ExtractionEngine",
                return_value=engine,
            ),
            patch("app.tasks.extraction_tasks._get_user_model_name", return_value="m"),
            patch("app.services.metering.metered"),
            patch(
                "app.services.failure_notifications.notify_extraction_failed"
            ) as notify,
        ):
            task = perform_extraction_task
            task.push_request(retries=retries)
            try:
                task.run(
                    activity_id=str(ObjectId()),
                    searchset_uuid="ss-1",
                    document_uuids=["d-1"],
                    keys=["field"],
                    root_path="/tmp",
                )
            except Exception:
                pass
            finally:
                task.pop_request()
        return notify

    def test_owner_is_notified_on_a_terminal_failure(self):
        notify = self._run_and_capture(side_effect=ValueError("bad prompt"))

        notify.assert_called_once()
        assert notify.call_args.kwargs["user_id"] == "alice"
        assert notify.call_args.kwargs["search_set_uuid"] == "ss-1"

    def test_no_notification_while_retries_remain(self):
        notify = self._run_and_capture(
            side_effect=ConnectionError("blip"), retries=0,
        )

        notify.assert_not_called()

    def test_notification_once_retries_are_exhausted(self):
        notify = self._run_and_capture(
            side_effect=ConnectionError("blip"), retries=3,
        )

        notify.assert_called_once()


# ---------------------------------------------------------------------------
# Automations / scheduled runs
# ---------------------------------------------------------------------------


class TestScheduledAutomationFailure:
    @patch("app.tasks.passive_tasks.get_sync_db")
    def test_unevaluatable_schedule_notifies_the_owner(self, mock_get_db):
        from app.tasks.passive_tasks import process_scheduled_automations

        db = MagicMock()
        mock_get_db.return_value = db
        auto = {
            "_id": ObjectId(),
            "name": "Nightly intake",
            "user_id": "alice",
            "enabled": True,
            "trigger_type": "schedule",
            "action_id": str(ObjectId()),
            "action_type": "workflow",
            "trigger_config": {"cron_expression": "not a cron"},
        }
        db.automation.find.return_value = [auto]
        db.workflow_trigger_event.find_one.return_value = None

        with patch(
            "app.services.failure_notifications.notify_automation_failed"
        ) as notify:
            process_scheduled_automations()

        notify.assert_called_once()
        assert notify.call_args.kwargs["automation"]["user_id"] == "alice"

    @patch("app.tasks.passive_tasks.get_sync_db")
    def test_trigger_processing_error_notifies_the_automation_owner(self, mock_get_db):
        from app.tasks.passive_tasks import process_pending_triggers

        db = MagicMock()
        mock_get_db.return_value = db

        auto_oid = ObjectId()
        event = {
            "_id": ObjectId(),
            "uuid": "evt-1",
            "workflow": ObjectId(),
            "trigger_context": {"automation_id": str(auto_oid)},
        }
        db.workflow_trigger_event.find.return_value.limit.return_value = [event]
        # Blow up inside the per-event body.
        db.workflow.find_one.side_effect = RuntimeError("mongo hiccup")
        db.automation.find_one.return_value = {
            "_id": auto_oid, "name": "Nightly intake", "user_id": "alice",
        }

        with patch(
            "app.services.failure_notifications.notify_automation_failed"
        ) as notify:
            process_pending_triggers()

        notify.assert_called_once()
        assert notify.call_args.kwargs["automation"]["user_id"] == "alice"


# ---------------------------------------------------------------------------
# process_outputs on a failed run
# ---------------------------------------------------------------------------


class TestProcessOutputsOnFailedRun:
    def _setup(self, db, *, status):
        wf_oid = ObjectId()
        db.workflow_result.find_one.return_value = {
            "_id": ObjectId(), "workflow": wf_oid, "status": status,
            "error": "step 2 blew up",
        }
        db.workflow.find_one.return_value = {
            "_id": wf_oid,
            "name": "WF",
            "user_id": "alice",
            "output_config": {
                "storage": {"enabled": True},
                "chains": [{"workflow_id": str(ObjectId())}],
                "notifications": [
                    {"channel": "email", "recipients": ["a@b.com"], "conditions": "failure"},
                ],
            },
        }
        db.workflow_trigger_event.find_one.return_value = None
        db.work_items.find_one.return_value = None
        db.automation.find_one.return_value = None

    @patch("app.tasks.passive_tasks.get_sync_db")
    def test_failure_notification_fires_for_an_errored_run(self, mock_get_db):
        from app.tasks.passive_tasks import process_outputs

        db = MagicMock()
        mock_get_db.return_value = db
        self._setup(db, status="error")

        with (
            patch("app.services.output_handlers.send_workflow_notification") as send,
            patch("app.services.output_handlers.save_results_to_folder") as save,
            patch("app.services.passive_triggers.create_chain_trigger") as chain,
        ):
            process_outputs(str(ObjectId()))

        send.assert_called_once()
        # No output exists, so nothing is written or handed downstream.
        save.assert_not_called()
        chain.assert_not_called()

    @patch("app.tasks.passive_tasks.get_sync_db")
    def test_successful_run_still_produces_deliverables(self, mock_get_db):
        from app.tasks.passive_tasks import process_outputs

        db = MagicMock()
        mock_get_db.return_value = db
        self._setup(db, status="completed")

        with (
            patch("app.services.output_handlers.send_workflow_notification"),
            patch("app.services.output_handlers.save_results_to_folder") as save,
            patch(
                "app.services.passive_triggers.create_chain_trigger",
                return_value=None,
            ) as chain,
        ):
            process_outputs(str(ObjectId()))

        save.assert_called_once()
        chain.assert_called_once()


# ---------------------------------------------------------------------------
# Delivery failures (#810): a completed run whose outputs never left the
# building must record and disclose that, not report clean success.
# ---------------------------------------------------------------------------


class TestExtractionOutputDeliveryFailures:
    def _run(self, *, storage_fails=False, webhook_fails=False, notification_fails=False):
        import app.tasks.document_tasks as dt

        db = MagicMock()
        automation = {
            "_id": ObjectId(), "name": "Nightly extract", "user_id": "owner",
            "trigger_type": "folder_watch",
            "output_config": {
                "storage": {"enabled": True},
                "notifications": [{"channel": "teams", "recipients": ["x"]}],
                "webhooks": [{"url": "https://example.org/hook"}],
            },
        }
        with patch(
            "app.services.output_handlers.save_extraction_results_to_folder",
            side_effect=RuntimeError("folder gone") if storage_fails else MagicMock(),
        ), patch(
            "app.services.output_handlers.call_webhook",
            side_effect=RuntimeError("410 Gone") if webhook_fails else MagicMock(),
        ), patch(
            "app.services.output_handlers.should_send_notification",
            return_value=True,
        ), patch(
            "app.services.output_handlers.send_workflow_notification",
            side_effect=RuntimeError("teams 403") if notification_fails else MagicMock(),
        ), patch(
            "app.services.failure_notifications.notify_delivery_failed"
        ) as notify:
            dt._process_extraction_outputs(db, automation, {"F": "v"})
        return notify

    def test_all_outputs_delivering_rings_nothing(self):
        notify = self._run()
        notify.assert_not_called()

    def test_failed_outputs_are_collected_and_belled_once_as_delivery(self):
        """delivery_failed, not automation_failed: the extraction RAN, and
        coalescing onto the genuine-failure key would overwrite an unread
        real dispatch failure's detail."""
        notify = self._run(storage_fails=True, webhook_fails=True)
        notify.assert_called_once()
        kwargs = notify.call_args.kwargs
        assert kwargs["automation"]["name"] == "Nightly extract"
        assert "2 configured output(s)" in kwargs["detail"]
        assert "folder gone" in kwargs["detail"]
        assert "410 Gone" in kwargs["detail"]

    def test_notification_failures_name_the_channel(self):
        """The config key is 'channel' (what the editor writes); reading a
        nonexistent 'type' key rendered every line as '(configured)'."""
        notify = self._run(notification_fails=True)
        assert "notification (teams)" in notify.call_args.kwargs["detail"]

    def test_one_failed_output_does_not_block_the_others(self):
        """Storage failing must not stop the webhook attempt (and vice versa) —
        collection, not early exit."""
        import app.tasks.document_tasks as dt

        db = MagicMock()
        automation = {
            "_id": ObjectId(), "name": "A", "user_id": "owner",
            "output_config": {
                "storage": {"enabled": True},
                "webhooks": [{"url": "https://example.org/hook"}],
            },
        }
        webhook = MagicMock()
        with patch(
            "app.services.output_handlers.save_extraction_results_to_folder",
            side_effect=RuntimeError("boom"),
        ), patch("app.services.output_handlers.call_webhook", webhook), \
             patch("app.services.output_handlers.should_send_notification", return_value=False), \
             patch("app.services.failure_notifications.notify_automation_failed"):
            dt._process_extraction_outputs(db, automation, {"F": "v"})
        webhook.assert_called_once()


class TestNotifyDeliveryFailed:
    def test_emitter_contract(self):
        from app.services.failure_notifications import notify_delivery_failed

        db = MagicMock()
        workflow_doc = {"_id": ObjectId(), "name": "WF", "user_id": "owner"}
        with patch(
            "app.services.failure_notifications.create_notification_sync"
        ) as create:
            notify_delivery_failed(
                db, workflow_doc=workflow_doc,
                detail="The output could not be saved", user_id="runner",
            )
        kwargs = create.call_args.kwargs
        assert kwargs["user_id"] == "runner"  # launcher wins over owner
        assert kwargs["kind"] == "delivery_failed"
        assert "Output not delivered" in kwargs["title"]
        assert "could not be saved" in kwargs["body"]

    def test_falls_back_to_the_workflow_owner(self):
        from app.services.failure_notifications import notify_delivery_failed

        db = MagicMock()
        with patch(
            "app.services.failure_notifications.create_notification_sync"
        ) as create:
            notify_delivery_failed(
                db, workflow_doc={"_id": ObjectId(), "name": "W", "user_id": "owner"},
                detail="d",
            )
        assert create.call_args.kwargs["user_id"] == "owner"
