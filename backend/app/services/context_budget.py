"""Context-budget planning and compaction for chat requests.

Sizes every component of a prompt, decides what to trim when the total
exceeds the model's input budget, and returns compacted pieces the caller
can safely send to the LLM.  All compaction is logged as structured
``CompactionAction`` entries so the caller can surface them to the user
and to Sentry.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tokenization
# ---------------------------------------------------------------------------

_CHAR_TO_TOKEN_RATIO = 4

# How much to inflate a tiktoken estimate for a model tiktoken does not model.
#
# tiktoken is OpenAI's tokenizer. For every other model it is a proxy, and
# measurement says it is a systematically *optimistic* one: across 97 harness
# runs against three self-hosted Qwen models, spanning requests from 307 to
# 46,916 tokens, the estimate came in under the `prompt_tokens` the server
# reported every single time, by 4.2% to 17.3% (mean 14.5%). It was never once
# equal or over.
#
# The error only bites near the window boundary — which is exactly where this
# product's flagship use case lives, reading a whole proposal on a 32k model.
#
# 1.20 covers the worst observation with headroom. The asymmetry justifies
# rounding up rather than fitting tightly: this is a budget estimate, not an
# invoice. Guessing high costs slightly-early routing to a bigger model.
# Guessing low costs a hard error and no answer, which is the bug this exists
# to prevent. Deployments that have measured their own models can set
# `token_safety_margin` on the model config instead of living with this.
DEFAULT_TOKEN_SAFETY_MARGIN = 1.20


@lru_cache(maxsize=8)
def _get_encoder(encoding_name: str):
    try:
        import tiktoken

        return tiktoken.get_encoding(encoding_name)
    except Exception as exc:
        logger.warning("tiktoken unavailable (%s); falling back to char heuristic", exc)
        return None


def _encoding_for(model_name: str) -> str:
    name = (model_name or "").lower()
    if any(tok in name for tok in ("gpt-4o", "gpt-4.1", "o1", "o3", "o4")):
        return "o200k_base"
    return "cl100k_base"


def _is_openai_model(name: str) -> bool:
    """True when tiktoken is this model's *real* tokenizer, not a proxy.

    Prefix-matching the o-series rather than substring-matching it: "o1" as a
    substring matches far too much to be safe on a registry of self-hosted
    model names.
    """
    n = (name or "").lower()
    if n.startswith(("gpt-", "o1", "o3", "o4")):
        return True
    return any(tok in n for tok in ("gpt-3.5", "gpt-4"))


def token_safety_margin(
    model_name: str, model_config: Optional[dict] = None
) -> float:
    """Multiplier that turns a tiktoken estimate into a safe upper bound.

    Returns 1.0 for OpenAI models, where the count is exact and inflating it
    would only trigger premature routing.

    An explicit ``token_safety_margin`` on the model config wins for any model,
    so a deployment can tune against its own measurements. A configured value
    below 1.0 is refused — that re-creates the original bug by configuration,
    leaving the planner optimistic in the direction that hard-fails.
    """
    if model_config:
        raw = model_config.get("token_safety_margin")
        if isinstance(raw, bool):
            raw = None  # bool is an int subclass; never a meaningful margin
        try:
            value = float(raw) if raw not in (None, "") else 0.0
        except (TypeError, ValueError):
            value = 0.0
        if value >= 1.0:
            return value
        if value:
            logger.warning(
                "ignoring token_safety_margin=%r for %s: a margin below 1.0 "
                "would under-count the request",
                raw,
                model_name,
            )

    if _is_openai_model(model_name):
        return 1.0
    return DEFAULT_TOKEN_SAFETY_MARGIN


def _apply_margin(raw_tokens: int, margin: float) -> int:
    """Round up — a fractional token still has to be paid for."""
    if raw_tokens <= 0:
        return 0
    return math.ceil(raw_tokens * margin)


def _count_raw_tokens(text: str, model_name: str = "") -> int:
    """tiktoken's count, with no safety margin applied.

    Internal: callers that are sizing a request want :func:`count_tokens`.
    This exists so the margin is applied exactly once per aggregate, and so
    truncation can convert a margin-inflated budget back into real token
    offsets for slicing.
    """
    if not text:
        return 0
    encoder = _get_encoder(_encoding_for(model_name))
    if encoder is not None:
        try:
            return len(encoder.encode(text, disallowed_special=()))
        except Exception:
            pass
    return max(1, len(text) // _CHAR_TO_TOKEN_RATIO)


def count_raw_tokens(text: str, model_name: str = "") -> int:
    """Count with no safety margin, for values *stored* rather than spent.

    A document's ``token_count`` is written once at ingestion and read later
    against whichever model the user happens to pick, but the safety margin is
    a property of that model, not of the document. Baking a margin into the
    stored value would freeze one model's correction into every future
    comparison — and would still leave every already-ingested document holding
    an uncorrected number. So the stored figure stays a raw baseline and the
    margin is applied at comparison time, by :func:`find_oversize_documents`.
    """
    return _count_raw_tokens(text, model_name)


def count_tokens(
    text: str, model_name: str = "", model_config: Optional[dict] = None
) -> int:
    """Estimate token count for ``text``, erring high for non-OpenAI models."""
    raw = _count_raw_tokens(text, model_name)
    return _apply_margin(raw, token_safety_margin(model_name, model_config))


def count_message_tokens(
    message: Any, model_name: str = "", model_config: Optional[dict] = None
) -> int:
    """Estimate tokens for one pydantic-ai ``ModelMessage``.

    The margin covers the role wrapper too. The per-message overhead below is a
    flat guess at chat-template scaffolding that real templates exceed, and
    under-counting it is most of why small requests showed the *largest*
    proportional error in measurement.
    """
    total = 4  # per-message overhead for role wrapping
    for part in getattr(message, "parts", ()):
        content = getattr(part, "content", None)
        if content is None:
            content = str(part)
        total += _count_raw_tokens(str(content), model_name)
    return _apply_margin(total, token_safety_margin(model_name, model_config))


# ---------------------------------------------------------------------------
# Model context window
# ---------------------------------------------------------------------------

# Order matters — the first substring match wins, so more specific entries
# must appear before broader ones.
_CONTEXT_WINDOW_FALLBACKS: list[tuple[str, int]] = [
    ("gpt-4.1", 1_000_000),
    ("gpt-4o-mini", 128_000),
    ("gpt-4o", 128_000),
    ("gpt-4-turbo", 128_000),
    ("gpt-4-32k", 32_768),
    ("gpt-4", 8_192),
    ("gpt-3.5", 16_385),
    ("o1-mini", 128_000),
    ("o1", 200_000),
    ("o3", 200_000),
    ("o4", 200_000),
    ("claude-opus-4", 200_000),
    ("claude-sonnet-4", 200_000),
    ("claude-haiku-4", 200_000),
    ("claude-3-7", 200_000),
    ("claude-3-5", 200_000),
    ("claude-3", 200_000),
    ("llama-3", 131_072),
    ("llama3", 131_072),
    ("mixtral", 32_768),
    ("mistral", 32_768),
    ("qwen", 131_072),
    ("gemma", 8_192),
]

DEFAULT_CONTEXT_WINDOW = 65_536


def resolve_context_window(
    model_name: str, model_config: Optional[dict] = None
) -> int:
    """Return the max input-context length for a model, in tokens.

    Priority: ``model_config['context_window']`` → fallback registry → default.
    """
    if model_config:
        raw = model_config.get("context_window")
        try:
            value = int(raw) if raw not in (None, "") else 0
        except (TypeError, ValueError):
            value = 0
        if value > 0:
            return value

    name = (model_name or "").lower()
    for pattern, window in _CONTEXT_WINDOW_FALLBACKS:
        if pattern in name:
            return window
    return DEFAULT_CONTEXT_WINDOW


# ---------------------------------------------------------------------------
# Budgeting + compaction
# ---------------------------------------------------------------------------


@dataclass
class DocumentSegment:
    """A single compactable chunk of context (doc body, KB block, attachment)."""

    label: str
    text: str
    required: bool = False  # required segments are never trimmed


@dataclass
class CompactionAction:
    """A single edit the planner applied to fit the budget."""

    kind: str  # "history_trimmed" | "documents_trimmed" | "attachments_trimmed" | "over_budget"
    detail: str
    tokens_dropped: int = 0

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "detail": self.detail,
            "tokens_dropped": self.tokens_dropped,
        }


@dataclass
class BudgetPlan:
    model: str
    context_window: int
    response_reserve: int
    input_budget: int

    system_tokens: int = 0
    user_message_tokens: int = 0
    history_tokens: int = 0
    documents_tokens: int = 0
    attachments_tokens: int = 0

    @property
    def total_input_tokens(self) -> int:
        return (
            self.system_tokens
            + self.user_message_tokens
            + self.history_tokens
            + self.documents_tokens
            + self.attachments_tokens
        )

    @property
    def over_budget(self) -> bool:
        return self.total_input_tokens > self.input_budget

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "context_window": self.context_window,
            "response_reserve": self.response_reserve,
            "input_budget": self.input_budget,
            "total_input_tokens": self.total_input_tokens,
            "system_tokens": self.system_tokens,
            "user_message_tokens": self.user_message_tokens,
            "history_tokens": self.history_tokens,
            "documents_tokens": self.documents_tokens,
            "attachments_tokens": self.attachments_tokens,
            "headroom_tokens": self.input_budget - self.total_input_tokens,
        }


@dataclass
class CompactedContext:
    documents: list[DocumentSegment]
    attachments: list[DocumentSegment]
    history: list  # list[pydantic_ai.messages.ModelMessage]
    plan: BudgetPlan
    actions: list[CompactionAction] = field(default_factory=list)

    @property
    def fatal(self) -> bool:
        """True when we could not shrink the request below the input budget."""
        return self.plan.over_budget


def _default_response_reserve(context_window: int) -> int:
    """Reserve tokens for the model's response.

    Scales with window size so tiny models don't lose all their budget to the
    reserve and large models don't overreserve.
    """
    return max(1024, min(8192, context_window // 4))


def _truncate_text_to_tokens(
    text: str,
    max_tokens: int,
    model_name: str,
    marker: str = "\n\n…[truncated]…\n\n",
    model_config: Optional[dict] = None,
) -> tuple[str, int]:
    """Truncate ``text`` to ≤ ``max_tokens``, preserving head and tail.

    ``max_tokens`` is a margin-inflated budget, but the encoder slices by real
    token offsets, so the budget is converted back to raw token space before
    slicing. Slicing ``toks`` by an inflated count would take *more* text than
    the budget allows and leave the caller still over, which the last-ditch
    loop would then have to iterate its way out of.

    Returns ``(truncated_text, dropped_tokens)``, both in inflated space.
    """
    margin = token_safety_margin(model_name, model_config)
    original_tokens = count_tokens(text, model_name, model_config)
    if max_tokens <= 0:
        return "", original_tokens
    if original_tokens <= max_tokens:
        return text, 0

    marker_tokens = count_tokens(marker, model_name, model_config)
    usable = max(1, max_tokens - marker_tokens)
    raw_usable = max(1, int(usable / margin))

    encoder = _get_encoder(_encoding_for(model_name))
    if encoder is not None:
        try:
            toks = encoder.encode(text, disallowed_special=())
            head_n = int(raw_usable * 0.75)
            tail_n = max(0, raw_usable - head_n)
            head_text = encoder.decode(toks[:head_n]) if head_n else ""
            tail_text = encoder.decode(toks[-tail_n:]) if tail_n else ""
            new_text = head_text + marker + tail_text
            return new_text, original_tokens - count_tokens(
                new_text, model_name, model_config
            )
        except Exception:
            pass

    approx_chars = raw_usable * _CHAR_TO_TOKEN_RATIO
    head_chars = int(approx_chars * 0.75)
    tail_chars = max(0, approx_chars - head_chars)
    new_text = text[:head_chars] + marker + (text[-tail_chars:] if tail_chars else "")
    return new_text, original_tokens - count_tokens(new_text, model_name, model_config)


def input_budget_for(
    model_name: str,
    model_config: Optional[dict] = None,
    response_reserve: Optional[int] = None,
) -> int:
    """Tokens available for input on this model, after the output reserve.

    The same arithmetic ``plan_and_compact_context`` uses to decide whether a
    request is over budget, exposed so callers can ask "would this fit?"
    without building and trimming a whole context first.
    """
    context_window = resolve_context_window(model_name, model_config)
    reserve = (
        response_reserve
        if response_reserve is not None
        else _default_response_reserve(context_window)
    )
    return max(1, context_window - reserve)


def estimate_input_tokens(
    *,
    model_name: str,
    system_prompt: str,
    user_message: str,
    history: list,
    documents: list[DocumentSegment],
    attachments: list[DocumentSegment],
    model_config: Optional[dict] = None,
) -> int:
    """Input size of a request before any trimming.

    Mirrors what ``plan_and_compact_context`` counts into
    ``BudgetPlan.total_input_tokens``, including the same 64-token allowance for
    prompt scaffolding, so a caller can ask "would this fit?" without building
    a context and having the very documents it wants to measure trimmed out
    from under it. Kept next to the planner so the two stay in step.

    Carries the model's safety margin, so the answer is an upper bound rather
    than an optimistic guess. Routing depends on this: a router that trusts an
    estimate which reads low will decline to move a request that does not fit.
    """
    return (
        (
            count_tokens(system_prompt, model_name, model_config)
            if system_prompt
            else 0
        )
        + count_tokens(user_message, model_name, model_config)
        + sum(count_message_tokens(m, model_name, model_config) for m in history)
        + sum(count_tokens(d.text, model_name, model_config) for d in documents)
        + sum(count_tokens(a.text, model_name, model_config) for a in attachments)
    )


def plan_and_compact_context(
    *,
    model_name: str,
    model_config: Optional[dict],
    system_prompt: str,
    user_message: str,
    history: list,
    documents: list[DocumentSegment],
    attachments: list[DocumentSegment],
    response_reserve: Optional[int] = None,
) -> CompactedContext:
    """Plan a context budget for this request and compact oversize components.

    Returns the same pieces (possibly trimmed) plus a ``BudgetPlan`` and the
    list of ``CompactionAction``s the planner applied.  The caller should
    check ``result.fatal`` — if true, sending the request will still fail.
    """
    documents = list(documents)
    attachments = list(attachments)
    history = list(history)

    context_window = resolve_context_window(model_name, model_config)
    reserve = (
        response_reserve
        if response_reserve is not None
        else _default_response_reserve(context_window)
    )
    input_budget = max(1, context_window - reserve)

    plan = BudgetPlan(
        model=model_name,
        context_window=context_window,
        response_reserve=reserve,
        input_budget=input_budget,
    )
    actions: list[CompactionAction] = []

    # Bound to this model and its config once, so no call site below can
    # silently size a segment with a different (optimistic) ruler than the one
    # the budget was planned against.
    def _ct(text: str) -> int:
        return count_tokens(text, model_name, model_config)

    def _cmt(message: Any) -> int:
        return count_message_tokens(message, model_name, model_config)

    def _trunc(text: str, max_tokens: int) -> tuple[str, int]:
        return _truncate_text_to_tokens(
            text, max_tokens, model_name, model_config=model_config
        )

    plan.system_tokens = _ct(system_prompt) if system_prompt else 0
    plan.user_message_tokens = _ct(user_message)
    plan.history_tokens = sum(_cmt(m) for m in history)
    plan.documents_tokens = sum(_ct(d.text) for d in documents)
    plan.attachments_tokens = sum(
        _ct(a.text) for a in attachments
    )

    if not plan.over_budget:
        return CompactedContext(
            documents=documents,
            attachments=attachments,
            history=history,
            plan=plan,
            actions=actions,
        )

    # Non-compactable floor covers the system prompt, user message, and an
    # allowance for prompt scaffolding ("--- BEGIN REFERENCE DOCUMENTS ---" etc.).
    floor = plan.system_tokens + plan.user_message_tokens + 64
    if floor >= input_budget:
        actions.append(
            CompactionAction(
                kind="over_budget",
                detail=(
                    f"System prompt + your message alone ({floor} tokens) already "
                    f"exceed this model's input budget ({input_budget} tokens). "
                    "Shorten the message or pick a larger model."
                ),
            )
        )
        return CompactedContext(
            documents=documents,
            attachments=attachments,
            history=history,
            plan=plan,
            actions=actions,
        )

    remaining = input_budget - floor
    doc_target = int(remaining * 0.65)
    hist_target = int(remaining * 0.25)
    attach_target = remaining - doc_target - hist_target

    # 1. Drop oldest history messages until under target.
    if plan.history_tokens > hist_target:
        dropped = 0
        while history and sum(
            _cmt(m) for m in history
        ) > hist_target:
            m = history.pop(0)
            dropped += _cmt(m)
        plan.history_tokens = sum(_cmt(m) for m in history)
        if dropped:
            actions.append(
                CompactionAction(
                    kind="history_trimmed",
                    detail=f"Dropped {dropped} tokens of older conversation history.",
                    tokens_dropped=dropped,
                )
            )

    # 2. Trim attachments proportionally.
    if plan.attachments_tokens > attach_target and attachments:
        dropped = 0
        scale = attach_target / max(1, plan.attachments_tokens)
        for i, a in enumerate(attachments):
            if a.required:
                continue
            raw = _ct(a.text)
            allowed = max(256, int(raw * scale))
            if allowed >= raw:
                continue
            new_text, loss = _trunc(a.text, allowed)
            dropped += loss
            attachments[i] = DocumentSegment(
                label=a.label, text=new_text, required=a.required
            )
        plan.attachments_tokens = sum(
            _ct(a.text) for a in attachments
        )
        if dropped:
            actions.append(
                CompactionAction(
                    kind="attachments_trimmed",
                    detail=f"Trimmed {dropped} tokens from attached files.",
                    tokens_dropped=dropped,
                )
            )

    # 3. Trim documents proportionally.
    if plan.documents_tokens > doc_target and documents:
        dropped = 0
        scale = doc_target / max(1, plan.documents_tokens)
        for i, d in enumerate(documents):
            if d.required:
                continue
            raw = _ct(d.text)
            allowed = max(512, int(raw * scale))
            if allowed >= raw:
                continue
            new_text, loss = _trunc(d.text, allowed)
            dropped += loss
            documents[i] = DocumentSegment(
                label=d.label, text=new_text, required=d.required
            )
        plan.documents_tokens = sum(
            _ct(d.text) for d in documents
        )
        if dropped:
            actions.append(
                CompactionAction(
                    kind="documents_trimmed",
                    detail=f"Trimmed {dropped} tokens from reference documents.",
                    tokens_dropped=dropped,
                )
            )

    # 4. Last-ditch: aggressively shrink or drop segments until we fit.
    _MIN_USEFUL_TOKENS = 64  # smaller than this is not worth keeping
    safety_counter = 0
    while plan.over_budget and safety_counter < 50:
        safety_counter += 1
        overflow = plan.total_input_tokens - input_budget
        candidate: Optional[DocumentSegment] = None
        bucket_name: Optional[str] = None
        container: Optional[list[DocumentSegment]] = None
        for bucket_name_try, bucket in (
            ("documents", documents),
            ("attachments", attachments),
        ):
            for seg in bucket:
                if seg.required:
                    continue
                if candidate is None or _ct(seg.text) > _ct(candidate.text):
                    candidate = seg
                    bucket_name = bucket_name_try
                    container = bucket
        if candidate is None or container is None:
            actions.append(
                CompactionAction(
                    kind="over_budget",
                    detail=(
                        f"Compaction could not reduce input below {input_budget} "
                        f"tokens (still at {plan.total_input_tokens}). "
                        "Remove some documents or switch to a larger model."
                    ),
                )
            )
            break

        raw = _ct(candidate.text)
        target = raw - overflow - 8  # shave 8 extra tokens of slack
        if target < _MIN_USEFUL_TOKENS:
            # Not worth keeping a tiny sliver — drop the segment entirely.
            container.remove(candidate)
            actions.append(
                CompactionAction(
                    kind=f"{bucket_name}_trimmed",
                    detail=f"Dropped '{candidate.label}' to fit budget ({raw} tokens).",
                    tokens_dropped=raw,
                )
            )
        else:
            new_text, loss = _trunc(candidate.text, target)
            if loss <= 0:
                # No forward progress possible on this segment; drop it.
                container.remove(candidate)
                actions.append(
                    CompactionAction(
                        kind=f"{bucket_name}_trimmed",
                        detail=f"Dropped '{candidate.label}' to fit budget ({raw} tokens).",
                        tokens_dropped=raw,
                    )
                )
            else:
                candidate.text = new_text
                actions.append(
                    CompactionAction(
                        kind=f"{bucket_name}_trimmed",
                        detail=(
                            f"Additional trim of {loss} tokens from "
                            f"'{candidate.label}' to fit budget."
                        ),
                        tokens_dropped=loss,
                    )
                )
        plan.documents_tokens = sum(
            _ct(d.text) for d in documents
        )
        plan.attachments_tokens = sum(
            _ct(a.text) for a in attachments
        )

    return CompactedContext(
        documents=documents,
        attachments=attachments,
        history=history,
        plan=plan,
        actions=actions,
    )


# ---------------------------------------------------------------------------
# Pre-flight oversize check (no LLM call required)
# ---------------------------------------------------------------------------


@dataclass
class OversizeDocument:
    uuid: str
    title: str
    token_count: int

    def to_dict(self) -> dict:
        return {"uuid": self.uuid, "title": self.title, "token_count": self.token_count}


def find_oversize_documents(
    *,
    documents: list[dict],
    model_name: str,
    model_config: Optional[dict] = None,
    overhead_tokens: int = 1024,
) -> list[OversizeDocument]:
    """Return docs whose token_count alone would not fit the model's input budget.

    A doc is "oversize" if its `token_count` exceeds the per-request budget
    after reserving room for the response and a small overhead (system prompt,
    user message, scaffolding). Returns docs sorted largest-first. The caller
    uses this to recommend "Convert to Knowledge Base" rather than running
    compaction and silently truncating.

    ``documents`` is a list of dicts each with at least ``uuid``, ``title``,
    ``token_count``. Accepting dicts (not the Beanie model) keeps this usable
    from sync Celery code.

    ``token_count`` is a raw tiktoken figure (see :func:`count_raw_tokens`), so
    the model's safety margin is applied here rather than trusted from storage.
    Without it this check under-warns by the same 4–17% the planner did, and a
    workflow that will fail is not flagged before it runs. Applying it at read
    time also corrects documents ingested before any of this existed.
    """
    context_window = resolve_context_window(model_name, model_config)
    reserve = _default_response_reserve(context_window)
    budget = max(1, context_window - reserve - overhead_tokens)
    margin = token_safety_margin(model_name, model_config)

    oversize: list[OversizeDocument] = []
    for d in documents:
        tc = _apply_margin(int(d.get("token_count") or 0), margin)
        if tc > budget:
            oversize.append(OversizeDocument(
                uuid=str(d.get("uuid") or ""),
                title=str(d.get("title") or d.get("uuid") or "Untitled"),
                token_count=tc,
            ))
    oversize.sort(key=lambda o: o.token_count, reverse=True)
    return oversize
