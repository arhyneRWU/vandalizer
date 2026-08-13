"""Tests for the empty-workflow guard on validation and export.

A workflow with no steps used to run the whole validation flow: it would
synthesize a seed input, draft a plan from the name alone, grade a run whose
only output was an internal id, and hand back an F with suggestions about
extraction fields that didn't exist — all of it paid for in LLM calls. These
tests pin the refusal at each entry point. Mocked models — no DB.
"""

import secrets
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.services.workflow_service import (
    generate_validation_plan,
    require_workflow_steps,
    validate_workflow,
    workflow_has_steps,
)
from app.utils.security import create_access_token

_TEST_SETTINGS = Settings(jwt_secret_key="test-secret-key", environment="development")

_STEP = {"id": "s1", "name": "Summarize", "is_output": True, "tasks": []}


def _make_user(user_id="testuser"):
    user = MagicMock()
    user.id = "fake-id"
    user.user_id = user_id
    user.email = f"{user_id}@example.com"
    user.name = "Test User"
    user.is_admin = False
    user.is_examiner = False
    user.current_team = None
    user.is_demo_user = False
    user.token_version = 0
    user.demo_status = None
    return user


def _auth(user_id="testuser"):
    token = create_access_token(user_id, _TEST_SETTINGS)
    csrf = secrets.token_urlsafe(32)
    return {"access_token": token, "csrf_token": csrf}, {"X-CSRF-Token": csrf}


@pytest.fixture
async def client():
    with patch("app.main.init_db", new_callable=AsyncMock):
        from app.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            yield ac


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def test_workflow_has_steps():
    assert workflow_has_steps({"steps": [_STEP]}) is True
    assert workflow_has_steps({"steps": []}) is False
    assert workflow_has_steps({}) is False
    assert workflow_has_steps(None) is False


def test_require_workflow_steps_names_the_action():
    require_workflow_steps({"steps": [_STEP]}, "validating it")  # does not raise
    with pytest.raises(ValueError, match="no steps yet — add at least one step before validating it"):
        require_workflow_steps({"steps": []}, "validating it")


# ---------------------------------------------------------------------------
# Plan generation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_plan_rejects_workflow_with_no_steps():
    user = _make_user()
    agent = MagicMock()

    with (
        patch("app.services.workflow_service.get_authorized_workflow",
              new=AsyncMock(return_value=MagicMock())),
        patch("app.services.workflow_service.get_workflow",
              new=AsyncMock(return_value={"id": "wf", "name": "X", "steps": []})),
        patch("app.services.llm_service.create_chat_agent", new=AsyncMock(return_value=agent)),
    ):
        with pytest.raises(ValueError, match="no steps yet"):
            await generate_validation_plan("wf", user)

    agent.run.assert_not_called()


# ---------------------------------------------------------------------------
# Grading
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_validate_rejects_workflow_with_no_steps_even_with_a_plan():
    """A plan can outlive the steps it was drafted from (import, step deletion),
    so the step check has to come before the plan check."""
    user = _make_user()
    wf = MagicMock()
    wf.validation_plan = [{"id": "c1", "description": "Output names the award"}]

    with (
        patch("app.services.workflow_service.get_authorized_workflow",
              new=AsyncMock(return_value=wf)),
        patch("app.services.workflow_service.get_workflow",
              new=AsyncMock(return_value={"id": "wf", "name": "X", "steps": []})),
    ):
        with pytest.raises(ValueError, match="no steps yet"):
            await validate_workflow("wf", user=user)


@pytest.mark.asyncio
async def test_validate_still_reports_a_missing_plan_when_steps_exist():
    user = _make_user()
    wf = MagicMock()
    wf.validation_plan = []

    with (
        patch("app.services.workflow_service.get_authorized_workflow",
              new=AsyncMock(return_value=wf)),
        patch("app.services.workflow_service.get_workflow",
              new=AsyncMock(return_value={"id": "wf", "name": "X", "steps": [_STEP]})),
    ):
        with pytest.raises(ValueError, match="No validation plan"):
            await validate_workflow("wf", user=user)


# ---------------------------------------------------------------------------
# Export route
# ---------------------------------------------------------------------------


class TestExportGuard:
    @pytest.mark.asyncio
    async def test_export_rejects_workflow_with_no_steps(self, client):
        user = _make_user()
        cookies, headers = _auth()
        wf = MagicMock()
        wf.steps = []

        with patch("app.dependencies.decode_token", return_value={"sub": "testuser", "type": "access"}), \
             patch("app.dependencies.User") as MockUser, \
             patch("app.routers.workflows.get_authorized_workflow", AsyncMock(return_value=wf)):
            MockUser.find_one = AsyncMock(return_value=user)

            resp = await client.get("/api/workflows/wf-id/export", cookies=cookies, headers=headers)

        assert resp.status_code == 400
        assert "no steps yet" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_export_succeeds_when_steps_exist(self, client):
        user = _make_user()
        cookies, headers = _auth()
        wf = MagicMock()
        wf.steps = ["step-id"]

        with patch("app.dependencies.decode_token", return_value={"sub": "testuser", "type": "access"}), \
             patch("app.dependencies.User") as MockUser, \
             patch("app.routers.workflows.get_authorized_workflow", AsyncMock(return_value=wf)), \
             patch("app.services.export_import_service.export_workflow",
                   AsyncMock(return_value={"items": [{"name": "My WF", "steps": [{"name": "Summarize"}]}]})):
            MockUser.find_one = AsyncMock(return_value=user)

            resp = await client.get("/api/workflows/wf-id/export", cookies=cookies, headers=headers)

        assert resp.status_code == 200
        assert "My WF.vandalizer.json" in resp.headers["content-disposition"]
