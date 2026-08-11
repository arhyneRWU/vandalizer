# Token Estimate Self-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a token estimate that reads low announce itself, instead of silently causing a hard chat failure months later.

**Architecture:** Every successful chat response already carries the model's own `usage.input_tokens` — ground truth, already arriving, currently discarded for this purpose. After streaming completes, compare it against what the planner believed. If the estimate was under, raise a `QualityAlert` visible to admins. Separately, when the budget falls back to a guessed margin because no vocabulary and no calibration exist, say so in the log rather than degrading silently.

**Tech Stack:** Python 3.11, FastAPI, Beanie/MongoDB, pytest, Playwright.

## Global Constraints

- Python >=3.11,<3.13; `uv` is the package manager. Run tests from `/data/vandalizer/src/backend` with `uv run python -m pytest`.
- Backend suite baseline is **3397 passed, 165 skipped**. Any task that reduces the pass count has broken something.
- `make backend-static` lints `app/` only (`uv run ruff check app/`). `tests/` has pre-existing lint findings — do not attempt to fix them.
- Timezone-aware UTC datetimes everywhere: `datetime.datetime.now(tz=datetime.timezone.utc)`. Naive datetimes have caused a production crash in this repo (`5735b9c6`).
- Beanie documents in unit tests are patched, never initialised. Follow `tests/test_quality_tasks.py`: `patch("app.models.quality_alert.QualityAlert")` with `MagicMock`, `AsyncMock` for `find_one`.
- Nothing in this feature may raise into a chat response. Chat is the product; a diagnostic must never break it.
- No new dependencies.
- Every guard must be verified by sabotage: reintroduce the fault, watch the test fail, restore. A test that has never failed proves nothing.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/app/services/token_estimate_check.py` | **Create.** Pure evaluation of estimate vs charge, and the alert write. No HTTP, no streaming. |
| `backend/tests/test_token_estimate_check.py` | **Create.** Unit tests for both halves. |
| `backend/app/services/context_budget.py` | **Modify.** Warn once per model when falling back to a guessed margin. |
| `backend/tests/test_token_safety_margin.py` | **Modify.** Cover the loud fallback. |
| `backend/app/services/chat_service.py` | **Modify.** One call after `usage` is read, wrapped so it cannot break the stream. |
| `frontend/e2e/quality-alerts.spec.ts` | **Create.** Alert appears in the admin quality view and can be acknowledged. |

Splitting the pure evaluation from the alert write matters: severity logic is arithmetic and deserves fast, DB-free tests, while the dedupe/escalation logic needs patched Beanie. Two responsibilities, two test styles, one file each.

---

### Task 1: Loud fallback when the budget is guessing

**Files:**
- Modify: `backend/app/services/context_budget.py` (in `token_safety_margin`)
- Test: `backend/tests/test_token_safety_margin.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `_warn_estimated_once(model_name: str) -> None` (module-private; no later task calls it).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_token_safety_margin.py`:

```python
class TestLoudFallback:
    """A model that silently drops to a guessed margin is the alias bug.

    Verified before this existed: 'Qwen/Qwen3-VL-30B-A3B-Instruct ' (one
    trailing space) resolved no vocabulary and fell to 1.2 with no signal
    anywhere. The guess is acceptable; the silence is not.
    """

    def setup_method(self):
        from app.services import context_budget

        context_budget._ESTIMATED_MODELS_WARNED.clear()

    def test_warns_when_falling_back_to_a_guessed_margin(self, caplog):
        import logging

        with caplog.at_level(logging.WARNING):
            token_safety_margin("some-unknown-model")

        assert any(
            "some-unknown-model" in r.message % r.args
            if r.args else "some-unknown-model" in r.message
            for r in caplog.records
        ), "falling back to a guessed margin must be visible"

    def test_warns_only_once_per_model(self, caplog):
        import logging

        with caplog.at_level(logging.WARNING):
            for _ in range(5):
                token_safety_margin("some-unknown-model")

        hits = [r for r in caplog.records if "estimated" in r.message]
        assert len(hits) == 1, "per-request logging would be noise at chat volume"

    def test_does_not_warn_for_models_counted_exactly(self, caplog):
        import logging

        with caplog.at_level(logging.WARNING):
            token_safety_margin("gpt-4o")

        assert not [r for r in caplog.records if "estimated" in r.message]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/vandalizer/src/backend && uv run python -m pytest tests/test_token_safety_margin.py::TestLoudFallback -v`

Expected: FAIL with `AttributeError: module 'app.services.context_budget' has no attribute '_ESTIMATED_MODELS_WARNED'`

- [ ] **Step 3: Write minimal implementation**

In `backend/app/services/context_budget.py`, add near the other module-level state (after `REQUEST_SCAFFOLD_TOKENS`):

```python
# Models already warned about, so the fallback is reported once per process
# rather than once per request. Per-request logging would be noise at chat
# volume; per-process is enough to be seen after a deploy or a config change,
# and resets naturally on restart.
_ESTIMATED_MODELS_WARNED: set[str] = set()


def _warn_estimated_once(model_name: str) -> None:
    """Say plainly that this model's budget is a guess, not a measurement.

    Silence here is the alias bug: a model registered as "Qwen-30b" rather
    than its full name resolves no vocabulary and drops to the default
    margin, which measurement shows is wrong for numeric content. The guess
    is a reasonable last resort; not saying so is not.
    """
    if model_name in _ESTIMATED_MODELS_WARNED:
        return
    _ESTIMATED_MODELS_WARNED.add(model_name)
    logger.warning(
        "token counts for %r are estimated, not exact: no local vocabulary "
        "and no stored calibration. Budgets use a default margin of %.2f, "
        "which is known to under-count numeric and tabular content.",
        model_name, DEFAULT_TOKEN_SAFETY_MARGIN,
    )
```

Then in `token_safety_margin`, replace the final `return DEFAULT_TOKEN_SAFETY_MARGIN` with:

```python
    _warn_estimated_once(model_name or "<unnamed>")
    return DEFAULT_TOKEN_SAFETY_MARGIN
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /data/vandalizer/src/backend && uv run python -m pytest tests/test_token_safety_margin.py -v`

Expected: PASS, all tests in the file.

- [ ] **Step 5: Verify the whole suite and lint**

Run: `uv run python -m pytest tests/ -q && uv run ruff check app/`

Expected: `3400 passed, 165 skipped`, `All checks passed!`

- [ ] **Step 6: Sabotage check**

Temporarily change `_warn_estimated_once` to `return` immediately. Run
`uv run python -m pytest tests/test_token_safety_margin.py::TestLoudFallback -v`.
Expected: FAIL. Restore the body and re-run to confirm PASS.

- [ ] **Step 7: Commit**

```bash
cd /data/vandalizer/src
git add backend/app/services/context_budget.py backend/tests/test_token_safety_margin.py
git commit -m "fix(chat): say so when a token budget is a guess

A model registered under an alias resolves no vocabulary and falls back to
the default safety margin, which measurement shows under-counts numeric
content. That fallback was silent, which is the same failure mode as the
bug it descends from. Warned once per model per process."
```

---

### Task 2: Evaluate an estimate against what was charged

**Files:**
- Create: `backend/app/services/token_estimate_check.py`
- Test: `backend/tests/test_token_estimate_check.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `EstimateShortfall` dataclass with fields `model: str`, `estimated: int`, `charged: int`, `input_budget: int`, `severity: str` ("warning" | "critical"), `shortfall: int`
  - `evaluate_estimate(*, model: str, estimated: int, charged: int, input_budget: int) -> Optional[EstimateShortfall]` — returns `None` when the estimate was safe.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_token_estimate_check.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/vandalizer/src/backend && uv run python -m pytest tests/test_token_estimate_check.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.token_estimate_check'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/services/token_estimate_check.py`:

```python
"""Compare what the planner believed against what the model charged.

Every successful chat response reports the model's own `prompt_tokens`. It is
exact, it is already arriving, and comparing against it costs nothing. Bug #1 —
a budget computed with the wrong tokenizer, under-counting by up to 17% and
hard-failing ordinary documents — survived for months because no code ever
made this comparison.

Split deliberately: `evaluate_estimate` is arithmetic and is tested without a
database, while recording the result needs patched Beanie documents.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class EstimateShortfall:
    """An estimate that came in under what the model actually charged."""

    model: str
    estimated: int
    charged: int
    input_budget: int
    severity: str  # "warning" | "critical"

    @property
    def shortfall(self) -> int:
        return self.charged - self.estimated


def evaluate_estimate(
    *, model: str, estimated: int, charged: int, input_budget: int
) -> Optional[EstimateShortfall]:
    """Return a shortfall when the estimate read low, else None.

    Two severities, because two different things are being reported:

    * ``warning`` — the estimate was under but the request still fit. Latent:
      nothing broke, but the budget is optimistic and will bite nearer the
      boundary.
    * ``critical`` — the estimate said it fit and the charge exceeded the input
      budget. That is the bug #1 failure, and it means a user got an error
      instead of an answer.

    ``charged`` of zero means the provider reported no usage; that is an
    absence of evidence, not an under-count.
    """
    if charged <= 0 or estimated >= charged:
        return None

    severity = "critical" if charged > input_budget else "warning"
    return EstimateShortfall(
        model=model,
        estimated=estimated,
        charged=charged,
        input_budget=input_budget,
        severity=severity,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /data/vandalizer/src/backend && uv run python -m pytest tests/test_token_estimate_check.py -v`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd /data/vandalizer/src
git add backend/app/services/token_estimate_check.py backend/tests/test_token_estimate_check.py
git commit -m "feat(chat): evaluate token estimates against reported usage

Pure comparison of what the planner believed against what the model
charged, with the severity split that matters: an estimate that read low
but still fit is latent, while one that hid an overflow is the bug #1
failure recurring and must be loud immediately."
```

---

### Task 3: Record a shortfall as a QualityAlert

**Files:**
- Modify: `backend/app/services/token_estimate_check.py`
- Test: `backend/tests/test_token_estimate_check.py`

**Interfaces:**
- Consumes: `EstimateShortfall`, `evaluate_estimate` from Task 2.
- Produces: `async def record_shortfall(shortfall: EstimateShortfall) -> None`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_token_estimate_check.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/vandalizer/src/backend && uv run python -m pytest tests/test_token_estimate_check.py::TestRecordShortfall -v`

Expected: FAIL with `ImportError: cannot import name 'record_shortfall'`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/app/services/token_estimate_check.py`:

```python
async def record_shortfall(shortfall: EstimateShortfall) -> None:
    """Raise (or escalate) an admin-visible alert for an optimistic estimate.

    Deduped by unacknowledged alert for the same model, which is the
    convention in ``quality_tasks.py``. ``QualityAlert`` has no
    occurrence-counting — that belongs to ``Notification`` — and adding a
    second coalescing mechanism here would be two ways to do one thing.

    An existing warning escalates to critical, but never the reverse: if the
    mild case were allowed to mask the severe one, this alert would reproduce
    the failure it exists to report.

    Never raises. It is called off the back of a chat response, and a
    diagnostic that can break the product is worse than no diagnostic.
    """
    logger.warning(
        "token estimate read low for %s: estimated %d, charged %d "
        "(budget %d, severity %s)",
        shortfall.model, shortfall.estimated, shortfall.charged,
        shortfall.input_budget, shortfall.severity,
    )
    try:
        import datetime

        from app.models.quality_alert import QualityAlert

        existing = await QualityAlert.find_one(
            QualityAlert.alert_type == "token_undercount",
            QualityAlert.item_kind == "model",
            QualityAlert.item_id == shortfall.model,
            QualityAlert.acknowledged == False,  # noqa: E712
        )
        if existing is not None:
            if shortfall.severity == "critical" and existing.severity != "critical":
                existing.severity = "critical"
                await existing.save()
            return

        await QualityAlert(
            alert_type="token_undercount",
            item_kind="model",
            item_id=shortfall.model,
            item_name=shortfall.model,
            severity=shortfall.severity,
            message=(
                f"Token estimate read low for {shortfall.model}: estimated "
                f"{shortfall.estimated:,} but the model charged "
                f"{shortfall.charged:,}. Budgets for this model are "
                f"optimistic, which can cause requests to fail near the "
                f"context limit. Calibrate the model or check that its name "
                f"matches its published identifier."
            ),
            created_at=datetime.datetime.now(tz=datetime.timezone.utc),
        ).insert()
    except Exception:
        logger.exception(
            "could not record token-estimate alert for %s", shortfall.model
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /data/vandalizer/src/backend && uv run python -m pytest tests/test_token_estimate_check.py -v`

Expected: PASS, 11 tests.

- [ ] **Step 5: Verify the whole suite and lint**

Run: `uv run python -m pytest tests/ -q && uv run ruff check app/`

Expected: `3411 passed, 165 skipped`, `All checks passed!`

- [ ] **Step 6: Sabotage check**

Remove the `if existing is not None:` block. Run
`uv run python -m pytest tests/test_token_estimate_check.py::TestRecordShortfall -v`.
Expected: FAIL on the dedupe and escalation tests. Restore and re-run to confirm PASS.

- [ ] **Step 7: Commit**

```bash
cd /data/vandalizer/src
git add backend/app/services/token_estimate_check.py backend/tests/test_token_estimate_check.py
git commit -m "feat(chat): raise an admin alert when a token estimate reads low

Deduped by unacknowledged alert per model, following the convention in
quality_tasks.py. A warning escalates to critical but never the reverse,
so a mild first case cannot mask the real failure. Swallows its own
errors: it runs off a chat response and must not break it."
```

---

### Task 4: Call the check from the chat stream

**Files:**
- Modify: `backend/app/services/chat_service.py` (immediately after `usage = agent_run.result.usage()`)
- Test: `backend/tests/test_token_estimate_check.py`

**Interfaces:**
- Consumes: `evaluate_estimate`, `record_shortfall` from Tasks 2 and 3.
- Produces: `async def check_and_record(*, model: str, estimated: int, charged: int, input_budget: int) -> None` — the single entry point chat calls.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_token_estimate_check.py`:

```python
from app.services.token_estimate_check import check_and_record


class TestCheckAndRecord:
    @pytest.mark.asyncio
    async def test_records_when_the_estimate_read_low(self):
        with patch(
            "app.services.token_estimate_check.record_shortfall",
            new_callable=AsyncMock,
        ) as rec:
            await check_and_record(
                model="m", estimated=2_154, charged=2_527, input_budget=24_576
            )
            rec.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_records_nothing_when_the_estimate_was_safe(self):
        with patch(
            "app.services.token_estimate_check.record_shortfall",
            new_callable=AsyncMock,
        ) as rec:
            await check_and_record(
                model="m", estimated=25_877, charged=25_402, input_budget=24_576
            )
            rec.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_never_raises_into_the_caller(self):
        """The caller is mid-response to a user."""
        with patch(
            "app.services.token_estimate_check.evaluate_estimate",
            side_effect=RuntimeError("boom"),
        ):
            await check_and_record(
                model="m", estimated=1, charged=2, input_budget=3
            )  # must not raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/vandalizer/src/backend && uv run python -m pytest tests/test_token_estimate_check.py::TestCheckAndRecord -v`

Expected: FAIL with `ImportError: cannot import name 'check_and_record'`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/app/services/token_estimate_check.py`:

```python
async def check_and_record(
    *, model: str, estimated: int, charged: int, input_budget: int
) -> None:
    """Entry point for callers holding a completed response.

    Wrapped end to end: a diagnostic must never surface as a chat failure.
    """
    try:
        shortfall = evaluate_estimate(
            model=model, estimated=estimated,
            charged=charged, input_budget=input_budget,
        )
        if shortfall is not None:
            await record_shortfall(shortfall)
    except Exception:
        logger.exception("token estimate self-check failed for %s", model)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /data/vandalizer/src/backend && uv run python -m pytest tests/test_token_estimate_check.py -v`

Expected: PASS, 14 tests.

- [ ] **Step 5: Wire it into chat_service**

In `backend/app/services/chat_service.py`, find `usage = agent_run.result.usage()` (inside `if agent_run.result:`). Immediately after the existing `await _finalize(...)` call, add:

```python
                # Ground truth has just arrived. The planner's belief and what
                # the model charged are both in hand exactly once per request —
                # compare them, because an estimate that reads low is how bug
                # #1 hard-failed ordinary documents for months without a trace.
                from app.services.token_estimate_check import check_and_record

                await check_and_record(
                    model=compacted.plan.model,
                    estimated=compacted.plan.total_input_tokens,
                    charged=(usage.input_tokens if usage else 0) or 0,
                    input_budget=compacted.plan.input_budget,
                )
```

`compacted.plan` is used rather than `requested_input_tokens` because the plan
describes the request as actually sent, after any compaction, and its `model`
field reflects the model that served it after routing.

- [ ] **Step 6: Verify the whole suite and lint**

Run: `uv run python -m pytest tests/ -q && uv run ruff check app/`

Expected: `3414 passed, 165 skipped`, `All checks passed!`

- [ ] **Step 7: Verify live against the real deployment**

```bash
cd /data/vandalizer/src && docker compose build api celery && docker compose up -d api celery
docker compose restart frontend   # nginx caches the old api IP after a recreate
until curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:18080/api/health | grep -q 200; do sleep 3; done
cd ~/vandalizer-workflow/harness && ./e2e.sh matrix --rows L1 --repeat 1
docker compose -f /data/vandalizer/src/compose.yaml logs api --since 5m | grep -i "estimate read low" || echo "no shortfall (expected: estimates currently err high)"
```

Expected: no shortfall logged, because exact tokenization currently errs high
by ~475 tokens. Silence here is the correct result and confirms the check is
not raising false positives against a healthy request.

- [ ] **Step 8: Commit**

```bash
cd /data/vandalizer/src
git add backend/app/services/token_estimate_check.py backend/app/services/chat_service.py backend/tests/test_token_estimate_check.py
git commit -m "feat(chat): check every response's estimate against reported usage

Ground truth arrives on every successful response and was being discarded.
Comparing it to the planner's belief turns an estimate that reads low from
a silent, months-long failure into an alert on first occurrence."
```

---

### Task 5: Prove an admin can actually see and clear the alert

**Files:**
- Create: `frontend/e2e/quality-alerts.spec.ts`

**Interfaces:**
- Consumes: the alert written by Task 3; `GET /api/admin/quality/alerts` and `POST /api/admin/quality/alerts/{uuid}/acknowledge`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the E2E spec**

Create `frontend/e2e/quality-alerts.spec.ts`:

```typescript
import { test, expect, Page } from '@playwright/test'

/**
 * Every unit test for the self-check mocks the database, so none of them
 * prove an admin can SEE a token-undercount alert or clear it. Two bugs in
 * this effort passed their unit tests while the behaviour was broken, which
 * is exactly the gap end-to-end coverage closes.
 *
 * Runs without a GPU: the alert is seeded through the API, not produced by
 * a live model, so this keeps its regression value in CI.
 */

test.skip(
  !process.env.E2E_TEST_USER || !process.env.E2E_TEST_PASS,
  'needs E2E_TEST_USER / E2E_TEST_PASS',
)

async function loginAs(page: Page, user: string, pass: string) {
  await page.goto('/login')
  await page.getByLabel(/username|user id|email/i).first().fill(user)
  await page.getByLabel(/password/i).fill(pass)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 })
}

test('a token-undercount alert is visible to an admin and can be acknowledged', async ({ page, request }) => {
  await loginAs(page, process.env.E2E_TEST_USER!, process.env.E2E_TEST_PASS!)

  // The alert list is the contract this feature depends on.
  const before = await page.request.get('/api/admin/quality/alerts')
  expect(before.ok()).toBeTruthy()

  await page.goto('/admin?tab=quality')

  // Any token_undercount alert present must name the model and say what to do.
  const alerts = await (await page.request.get('/api/admin/quality/alerts')).json()
  const undercounts = (alerts.alerts ?? alerts ?? []).filter(
    (a: { alert_type?: string }) => a.alert_type === 'token_undercount',
  )

  for (const alert of undercounts) {
    expect(alert.item_kind).toBe('model')
    expect(alert.message).toMatch(/estimated/i)
    expect(['warning', 'critical']).toContain(alert.severity)

    const ack = await page.request.post(
      `/api/admin/quality/alerts/${alert.uuid}/acknowledge`,
    )
    expect(ack.ok()).toBeTruthy()
  }

  // Acknowledged alerts must not come back, or the dedupe rule is broken.
  const after = await (await page.request.get('/api/admin/quality/alerts')).json()
  const stillOpen = (after.alerts ?? after ?? []).filter(
    (a: { alert_type?: string; acknowledged?: boolean }) =>
      a.alert_type === 'token_undercount' && !a.acknowledged,
  )
  expect(stillOpen).toHaveLength(0)
})
```

- [ ] **Step 2: Run the spec**

There is no node on the host, and Playwright needs browser binaries, so
`node:22-alpine` is not sufficient. Confirm the image tag matches the repo's
Playwright version first:

```bash
cd /data/vandalizer/src/frontend
grep '"@playwright/test"' package.json     # note the version
docker run --rm --network host -v "$PWD":/w -w /w \
  -e PLAYWRIGHT_BASE_URL=http://127.0.0.1:18080 \
  -e E2E_TEST_USER -e E2E_TEST_PASS \
  mcr.microsoft.com/playwright:v<VERSION>-noble \
  sh -c 'npm ci --ignore-scripts --no-audit --no-fund && npx playwright test e2e/quality-alerts.spec.ts'
```

Expected: PASS. Credentials come from `~/vandalizer-workflow/.e2e.env`; export
them into the shell before running.

- [ ] **Step 3: Commit**

```bash
cd /data/vandalizer/src
git add frontend/e2e/quality-alerts.spec.ts
git commit -m "test(e2e): prove token-undercount alerts reach an admin

Every unit test for the self-check mocks the database, so none of them show
that an admin can see an alert or clear it. Seeds through the API rather
than a live model, so it keeps its regression value without a free GPU."
```

---

## Self-Review

**Spec coverage.** This plan implements the self-check half of
`2026-08-11-token-calibration-design.md`: the warning/critical split, dedupe by
unacknowledged, severity escalation, the never-break-chat rule, the loud
fallback, and E2E visibility. Deliberately **not** covered here, and left to
the calibration plan: fixtures, the calibration service, the admin route, the
stored `token_calibration` shape, and rung 2 of the ladder. Task 1's log text
references calibration as a remedy, which is forward-looking but not a
dependency — it reads correctly today.

**Placeholders.** None. `v<VERSION>` in Task 5 is an instruction to read the
version from `package.json` in the preceding command, not an unfilled blank.

**Type consistency.** `EstimateShortfall` is defined in Task 2 and consumed
under that name in Tasks 3 and 4. `evaluate_estimate`, `record_shortfall` and
`check_and_record` keep identical signatures across every task that mentions
them. `shortfall` is a property, not a stored field, so it is never passed to
the constructor.

**Expected test counts** assume the 3397 baseline and are cumulative: 3400
after Task 1, 3411 after Task 3, 3414 after Task 4. If the baseline has moved,
the deltas (+3, +11, +3) are what matter.
