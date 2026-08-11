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
