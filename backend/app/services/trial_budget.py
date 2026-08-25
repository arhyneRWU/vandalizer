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

import datetime
import logging

from app.exceptions import (
    TrialBudgetExceededError,
    TrialSpendBlockedError,
    TrialUnverifiedError,
)

logger = logging.getLogger(__name__)

EXCEEDED_MESSAGE = (
    "This trial account has used all of its included AI tokens. "
    "A top-up link is on its way to your email — one click (and a little "
    "feedback) brings you right back."
)

UNVERIFIED_MESSAGE = (
    "Please confirm your email address before using AI features — click the "
    "sign-in link we emailed you. Need a new one? Request it from the trial "
    "status page."
)

FLEET_PAUSED_MESSAGE = (
    "Trial AI usage is paused for the moment while we top up capacity. "
    "Your workspace and everything in it are unaffected — please try again "
    "later, or contact the team running this deployment."
)

_USAGE_PIPELINE = [{"$group": {"_id": None, "total": {"$sum": "$total_tokens"}}}]

#: Redis key holding "1" while fleet-wide trial spend is over the monthly
#: ceiling. Written by the hourly sweep, read on the hot path. Carries a TTL so
#: a stopped sweep fails *open* rather than pausing trials forever.
FLEET_PAUSED_KEY = "trial:fleet_paused"
FLEET_PAUSED_TTL_SECONDS = 3 * 60 * 60


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


def month_start(now: datetime.datetime | None = None) -> datetime.datetime:
    """First instant of the current UTC calendar month."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def fleet_tokens_this_month() -> int:
    """Trial-attributed tokens spent fleet-wide since the start of the month."""
    from app.models.llm_usage import LlmUsageRecord
    from app.models.user import User

    trial_ids = [
        u.user_id
        for u in await User.find(
            User.is_demo_user == True  # noqa: E712 — Beanie query expression
        ).to_list()
    ]
    if not trial_ids:
        return 0
    rows = (
        await LlmUsageRecord.find(
            {
                "user_id": {"$in": trial_ids},
                "timestamp": {"$gte": month_start()},
            }
        )
        .aggregate(_USAGE_PIPELINE)
        .to_list()
    )
    return int(rows[0]["total"]) if rows else 0


async def refresh_fleet_pause(settings=None) -> dict:
    """Recompute the fleet ceiling and set/clear the Redis pause flag.

    Called by the hourly trial sweep. The flag is what the hot path reads, so
    an overrun is caught within an hour — bounded by the per-account budgets
    that are still enforced exactly in the meantime.
    """
    import redis.asyncio as aioredis

    from app.config import Settings

    settings = settings or Settings()
    ceiling = max(0, settings.trial_global_monthly_tokens)
    if not settings.enable_trial_system or not ceiling:
        return {"enabled": False, "spent": 0, "ceiling": 0, "paused": False}

    spent = await fleet_tokens_this_month()
    paused = spent >= ceiling
    try:
        r = aioredis.from_url(f"redis://{settings.redis_host}:6379")
        try:
            if paused:
                await r.set(FLEET_PAUSED_KEY, "1", ex=FLEET_PAUSED_TTL_SECONDS)
            else:
                await r.delete(FLEET_PAUSED_KEY)
        finally:
            await r.aclose()
    except Exception as e:  # never let the flag write break the sweep
        logger.error("Failed to update trial fleet pause flag: %s", e)

    if paused:
        logger.warning(
            "Trial fleet ceiling reached: %s/%s tokens this month — new trial "
            "spend is paused until the ceiling is raised or the month rolls.",
            spent, ceiling,
        )
    return {"enabled": True, "spent": spent, "ceiling": ceiling, "paused": paused}


async def _fleet_paused_async() -> bool:
    """Read the cached fleet-pause flag. Fails open on any Redis trouble."""
    import redis.asyncio as aioredis

    from app.dependencies import get_settings

    settings = get_settings()
    if not max(0, settings.trial_global_monthly_tokens):
        return False
    try:
        r = aioredis.from_url(f"redis://{settings.redis_host}:6379")
        try:
            return await r.get(FLEET_PAUSED_KEY) is not None
        finally:
            await r.aclose()
    except Exception as e:
        logger.error("Failed to read trial fleet pause flag: %s", e)
        return False


def _fleet_paused_sync() -> bool:
    """Sync twin of _fleet_paused_async, for Celery-side metering scopes."""
    import redis

    from app.dependencies import get_settings

    settings = get_settings()
    if not max(0, settings.trial_global_monthly_tokens):
        return False
    try:
        client = redis.Redis(host=settings.redis_host, port=6379)
        try:
            return client.get(FLEET_PAUSED_KEY) is not None
        finally:
            client.close()
    except Exception as e:
        logger.error("Failed to read trial fleet pause flag: %s", e)
        return False


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
    off = {
        "enabled": False, "budget": 0, "used": 0, "remaining": 0,
        "percent": 0, "email_verified": True,
    }
    if not getattr(user, "is_demo_user", False):
        return off
    budget = effective_budget(getattr(user, "trial_token_budget", None))
    if not budget:
        return off
    used = await tokens_used_async(user.user_id)
    return {
        "enabled": True,
        "budget": budget,
        "used": used,
        "remaining": max(0, budget - used),
        "percent": min(100, round(used * 100 / budget)),
        "email_verified": bool(getattr(user, "email_verified", False)),
    }


async def check_async(user_id: str | None) -> None:
    """Gate LLM spend for a trial user: verified, under budget, fleet not paused.

    Raises TrialUnverifiedError or TrialBudgetExceededError. Non-trial users
    and cap-disabled deployments return immediately.
    """
    if not _budget() or not user_id:
        return
    try:
        from app.models.user import User

        user = await User.find_one(User.user_id == user_id)
        if user is None or not user.is_demo_user:
            return
        # An unverified address can't receive the top-up link, and is what
        # makes one person into unlimited free accounts. Check it first: it's
        # the cheaper answer and the more actionable message.
        if not user.email_verified:
            raise TrialUnverifiedError(UNVERIFIED_MESSAGE)
        budget = effective_budget(user.trial_token_budget)
        if not budget:
            return
        used = await tokens_used_async(user_id)
        over_budget = used >= budget
        fleet_paused = False if over_budget else await _fleet_paused_async()
    except TrialSpendBlockedError:
        raise
    except Exception as e:
        logger.error("Trial budget check failed for %s: %s", user_id, e)
        return
    if over_budget:
        raise TrialBudgetExceededError(EXCEEDED_MESSAGE)
    if fleet_paused:
        raise TrialBudgetExceededError(FLEET_PAUSED_MESSAGE)


def check_sync(user_id: str | None) -> None:
    """Sync twin of check_async, for Celery-side metering scopes."""
    if not _budget() or not user_id:
        return
    try:
        from app.tasks import get_sync_db

        db = get_sync_db()
        user = db.user.find_one(
            {"user_id": user_id},
            {"is_demo_user": 1, "trial_token_budget": 1, "email_verified": 1},
        )
        if not user or not user.get("is_demo_user"):
            return
        if not user.get("email_verified"):
            raise TrialUnverifiedError(UNVERIFIED_MESSAGE)
        budget = effective_budget(user.get("trial_token_budget"))
        if not budget:
            return
        rows = list(
            db.llm_usage.aggregate(
                [{"$match": {"user_id": user_id}}, *_USAGE_PIPELINE]
            )
        )
        used = int(rows[0]["total"]) if rows else 0
        over_budget = used >= budget
        fleet_paused = False if over_budget else _fleet_paused_sync()
    except TrialSpendBlockedError:
        raise
    except Exception as e:
        logger.error("Trial budget check failed for %s: %s", user_id, e)
        return
    if over_budget:
        raise TrialBudgetExceededError(EXCEEDED_MESSAGE)
    if fleet_paused:
        raise TrialBudgetExceededError(FLEET_PAUSED_MESSAGE)
