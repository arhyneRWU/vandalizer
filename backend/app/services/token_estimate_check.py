"""Compare what the planner believed against what the model charged.

Every successful chat response reports the model's own input token count, read
off the usage object as `usage.input_tokens` (see `chat_service.py`; some
providers call the same number `prompt_tokens` on the wire, but that is not the
attribute this code reads). It is exact, it is already arriving, and comparing
against it costs nothing. Bug #1 —
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

    A charge that exactly fills the budget still fit, so the critical test is
    strictly ``>``, not ``>=``.

    ``charged`` of zero means the provider reported no usage; that is an absence
    of evidence, not an under-count. The ``charged <= 0`` clause states that
    intent, but note what it actually does: to change the result it would need
    ``estimated < charged <= 0``, i.e. a negative ``estimated``. Both operands
    are token counts and cannot go negative, so no input the system can produce
    reaches it — a no-usage response is already returned as ``None`` by
    ``estimated >= charged``. Keep it as an executable statement of the rule,
    but do not mistake it for a live branch, and do not write a test claiming to
    cover it: such a test would pass identically with the clause deleted.
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
