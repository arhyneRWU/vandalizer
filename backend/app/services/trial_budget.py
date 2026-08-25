"""Hard LLM spend cap for trial accounts — the trial IS the budget.

Trial accounts are token-metered, not time-limited: each ``is_demo_user``
carries a lifetime token budget (``User.trial_token_budget``, defaulting to
``TRIAL_TOKEN_BUDGET``, raised by feedback-priced top-ups). The check runs at
metering-scope entry (``metering.metered`` / ``metered_async``) — the one
chokepoint every attributed LLM operation passes through, in both the API
process and Celery workers — and raises ``TrialBudgetExceededError`` before an
operation's first model request once the ``llm_usage`` ledger total crosses
the budget.

Cost posture: on deployments without the trial system enabled the check is a
cached settings read and returns immediately. The budget only ever gates
``is_demo_user`` accounts. The check fails open on its own errors — a
metering-side failure must never take down LLM features — but the
budget-exceeded signal itself always propagates.
"""

from __future__ import annotations

import logging

from app.exceptions import TrialBudgetExceededError

logger = logging.getLogger(__name__)

EXCEEDED_MESSAGE = (
    "This trial account has used all of its included AI tokens. "
    "A top-up link is on its way to your email — one click (and a little "
    "feedback) brings you right back."
)

_USAGE_PIPELINE = [{"$group": {"_id": None, "total": {"$sum": "$total_tokens"}}}]


def _budget() -> int:
    """The deployment-default trial token budget, or 0 when not enforced."""
    from app.dependencies import get_settings

    settings = get_settings()
    if not settings.enable_trial_system:
        return 0
    return max(0, settings.trial_token_budget)


def effective_budget(user_override: int | None) -> int:
    """A trial user's budget: their per-user value (raised by top-ups) when
    set, else the deployment default. 0 = the cap is not enforced at all."""
    default = _budget()
    if not default:
        return 0
    if user_override is None:
        return default
    return max(0, user_override)


async def tokens_used_async(user_id: str) -> int:
    from app.models.llm_usage import LlmUsageRecord

    rows = (
        await LlmUsageRecord.find(LlmUsageRecord.user_id == user_id)
        .aggregate(_USAGE_PIPELINE)
        .to_list()
    )
    return int(rows[0]["total"]) if rows else 0


async def get_trial_usage(user) -> dict:
    """Budget/usage snapshot for one trial user — the shape the meter, the
    lifecycle emails, and the trial-end screen all read.

    ``enabled`` is False for non-trial users and cap-disabled deployments;
    the other numbers are zeroed then and must not be rendered.
    """
    if not getattr(user, "is_demo_user", False):
        return {"enabled": False, "budget": 0, "used": 0, "remaining": 0, "percent": 0}
    budget = effective_budget(getattr(user, "trial_token_budget", None))
    if not budget:
        return {"enabled": False, "budget": 0, "used": 0, "remaining": 0, "percent": 0}
    used = await tokens_used_async(user.user_id)
    return {
        "enabled": True,
        "budget": budget,
        "used": used,
        "remaining": max(0, budget - used),
        "percent": min(100, round(used * 100 / budget)),
    }


async def check_async(user_id: str | None) -> None:
    """Raise TrialBudgetExceededError if `user_id` is an over-budget trial user."""
    if not _budget() or not user_id:
        return
    try:
        from app.models.user import User

        user = await User.find_one(User.user_id == user_id)
        if user is None or not user.is_demo_user:
            return
        budget = effective_budget(user.trial_token_budget)
        if not budget:
            return
        used = await tokens_used_async(user_id)
    except Exception as e:
        logger.error("Trial budget check failed for %s: %s", user_id, e)
        return
    if used >= budget:
        raise TrialBudgetExceededError(EXCEEDED_MESSAGE)


def check_sync(user_id: str | None) -> None:
    """Sync twin of check_async, for Celery-side metering scopes."""
    if not _budget() or not user_id:
        return
    try:
        from app.tasks import get_sync_db

        db = get_sync_db()
        user = db.user.find_one(
            {"user_id": user_id}, {"is_demo_user": 1, "trial_token_budget": 1}
        )
        if not user or not user.get("is_demo_user"):
            return
        budget = effective_budget(user.get("trial_token_budget"))
        if not budget:
            return
        rows = list(
            db.llm_usage.aggregate(
                [{"$match": {"user_id": user_id}}, *_USAGE_PIPELINE]
            )
        )
        used = int(rows[0]["total"]) if rows else 0
    except Exception as e:
        logger.error("Trial budget check failed for %s: %s", user_id, e)
        return
    if used >= budget:
        raise TrialBudgetExceededError(EXCEEDED_MESSAGE)
