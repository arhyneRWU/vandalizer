"""Per-field source tracking for extractions.

The extraction engine asks the LLM for a verbatim supporting passage per
field (stored under ``SOURCE_KEY`` on each entity dict). This module then
verifies each passage against the document text it was extracted from and
resolves the page it appears on via the document's ``text_markers``
(see ``SmartDocument.text_markers`` / ``document_readers.extract_text_with_markers``).

A passage that cannot be located in the document — even after unicode
normalization — is marked ``verified: False``, which the frontend surfaces
as "no source found": both a traceability gap and a hallucination signal.

``verified`` answers only "does this passage exist in the document?". It says
nothing about whether the passage supports the value shown beside it: a model
that hallucinates an award amount and returns any real sentence from the
budget section earns a located quote. ``value_supported`` answers the second,
load-bearing question — is the extracted value actually present in the
passage — and is recorded separately so the two claims never get conflated.

Pure string/offset logic only; no DB or LLM access, safe to import anywhere.
That purity is why the number/date parsing below is duplicated here in
miniature rather than imported from ``extraction_validation_service``, which
pulls in the engine, Beanie documents, and system config.
"""

import re
from datetime import date, datetime
from typing import Optional

# Reserved sidecar key on entity dicts: {field_name: source dict}. Every
# consumer that iterates entity items must skip it (normalize_results,
# draft hints, consensus votes, chunk merges).
SOURCE_KEY = "_field_sources"

# 1:1-or-expanding character folds applied to both document text and quotes
# before matching. LLM output routinely differs from PDF text layers by
# smart quotes, dash variants, NBSP, and ligatures.
_CHAR_MAP = {
    # curly quotes -> straight
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"',
    # hyphen/dash variants -> "-"
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-",
    "\u2014": "-", "\u2015": "-", "\u2212": "-",
    # NBSP / figure / thin / narrow no-break space -> " "
    "\u00a0": " ", "\u2007": " ", "\u2009": " ", "\u202f": " ",
    # ligatures
    "\ufb01": "fi", "\ufb02": "fl",
}

# Zero-width / joining characters dropped entirely: soft hyphen, BOM,
# zero-width space / non-joiner / joiner.
_DROP_CHARS = {"\u00ad", "\ufeff", "\u200b", "\u200c", "\u200d"}


def normalize_with_map(text: str) -> tuple[str, list[int]]:
    """Lowercase + fold + whitespace-collapse *text*.

    Returns ``(normalized, index_map)`` where ``index_map[i]`` is the offset
    in the original text of the character that produced ``normalized[i]``,
    so matches in normalized space can be projected back to real offsets.
    """
    out: list[str] = []
    index_map: list[int] = []
    last_was_space = True  # trims leading whitespace
    for i, ch in enumerate(text):
        if ch in _DROP_CHARS:
            continue
        folded = _CHAR_MAP.get(ch, ch)
        for c in folded:
            if c.isspace():
                if last_was_space:
                    continue
                out.append(" ")
                index_map.append(i)
                last_was_space = True
            else:
                out.append(c.lower())
                index_map.append(i)
                last_was_space = False
    if out and out[-1] == " ":
        out.pop()
        index_map.pop()
    return "".join(out), index_map


def find_quote_offset(doc_text: str, quote: str,
                      normalized: tuple[str, list[int]] | None = None) -> Optional[int]:
    """Locate *quote* in *doc_text*, returning the original char offset.

    Tries an exact match first, then a normalized match. Pass a pre-built
    ``normalize_with_map(doc_text)`` result via *normalized* to amortize the
    normalization cost across many quotes in the same document.
    """
    if not doc_text or not quote:
        return None
    idx = doc_text.find(quote)
    if idx != -1:
        return idx

    norm_doc, index_map = normalized if normalized is not None else normalize_with_map(doc_text)
    norm_quote, _ = normalize_with_map(quote)
    if not norm_quote:
        return None
    nidx = norm_doc.find(norm_quote)
    if nidx == -1:
        return None
    return index_map[nidx]


def page_marker_for_offset(offset: int, markers: list[dict]) -> Optional[dict]:
    """The most recent ``kind: "page"`` marker at or before *offset*.

    Returns the marker rather than just its number so callers can see where the
    boundary came from — OCR'd documents carry ``approximate: True`` because
    their page positions are interpolated, not measured (see #603).
    """
    found: Optional[dict] = None
    for m in markers or []:
        if m.get("char_offset", 0) > offset:
            break
        if m.get("kind") == "page" and isinstance(m.get("value"), int):
            found = m
    return found


def page_for_offset(offset: int, markers: list[dict]) -> Optional[int]:
    """Page number of the most recent ``kind: "page"`` marker at or before *offset*."""
    marker = page_marker_for_offset(offset, markers)
    return marker.get("value") if marker else None


def _doc_for_offset(offset: int, doc_spans: list[dict]) -> Optional[dict]:
    for span in doc_spans or []:
        if span.get("start", 0) <= offset < span.get("end", 0):
            return span
    return None


# ---------------------------------------------------------------------------
# Value support: is the extracted value actually present in its quote?
# ---------------------------------------------------------------------------

# Kept in sync with extraction_validation_service._NOT_FOUND_VARIANTS. A
# sentinel has no value to support, so it is never counted either way.
_NOT_FOUND_VARIANTS = frozenset({
    "", "n/a", "na", "n.a.", "not found", "not available",
    "not applicable", "none", "null", "nil", "unknown", "-", "--", "---",
    "nan", "no data", "no value", "not provided", "not specified",
    "not present", "not stated", "not mentioned", "not given",
    "no information", "no entry", "missing", "empty", "blank",
})

_CURRENCY_CHARS = "$€£¥%"
_NUMBER_IN_TEXT_RE = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?")

_MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec"
_DATE_IN_TEXT_RE = re.compile(
    r"\d{4}-\d{1,2}-\d{1,2}"
    r"|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}"
    rf"|(?:{_MONTHS})[a-z]*\.?\s+\d{{1,2}},?\s+\d{{4}}"
    rf"|\d{{1,2}}\s+(?:{_MONTHS})[a-z]*\.?,?\s+\d{{4}}",
    re.IGNORECASE,
)
_DATE_FORMATS = (
    "%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%m-%d-%y",
    "%B %d, %Y", "%B %d %Y", "%b %d, %Y", "%b %d %Y",
    "%d %B %Y", "%d %b %Y", "%d %B, %Y", "%d %b, %Y",
)


def _is_not_found(value) -> bool:
    if value is None:
        return True
    return str(value).strip().lower() in _NOT_FOUND_VARIANTS


def _as_number(text: str) -> Optional[float]:
    """Parse a whole string as a number, tolerating currency/percent/commas."""
    cleaned = text.strip()
    for ch in _CURRENCY_CHARS:
        cleaned = cleaned.replace(ch, "")
    cleaned = cleaned.replace(",", "").replace(" ", "")
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _numbers_in(text: str) -> set[float]:
    out: set[float] = set()
    for m in _NUMBER_IN_TEXT_RE.finditer(text):
        n = _as_number(m.group())
        if n is not None:
            out.add(n)
    return out


def _as_date(text: str) -> Optional[date]:
    s = text.strip().rstrip(".,").replace(".", "")
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _dates_in(text: str) -> set[date]:
    out: set[date] = set()
    for m in _DATE_IN_TEXT_RE.finditer(text):
        d = _as_date(m.group())
        if d is not None:
            out.add(d)
    return out


def same_value(a, b) -> bool:
    """Whether two extracted values are the same value.

    Formatting-tolerant in the same directions as the quote matcher: unicode
    folding, then numeric and date equivalence. Used to decide whether a
    quote captured for one pass's value may be carried onto another's.
    """
    a_nf, b_nf = _is_not_found(a), _is_not_found(b)
    if a_nf or b_nf:
        return a_nf and b_nf

    a_str, b_str = str(a).strip(), str(b).strip()
    norm_a, _ = normalize_with_map(a_str)
    norm_b, _ = normalize_with_map(b_str)
    if norm_a == norm_b:
        return True

    num_a, num_b = _as_number(a_str), _as_number(b_str)
    if num_a is not None and num_b is not None:
        return num_a == num_b

    date_a, date_b = _as_date(a_str), _as_date(b_str)
    if date_a is not None and date_b is not None:
        return date_a == date_b

    return False


def value_supported_by_quote(
    value, quote: Optional[str], *, enum_field: bool = False,
) -> tuple[Optional[bool], str]:
    """Is *value* actually supported by *quote*?

    Returns ``(supported, method)``. ``supported`` is None when the question
    does not apply — there is no quote, the value is a "not found" sentinel,
    or the field is an enum whose allowed values are a mapping of the prose
    rather than a span of it. ``method`` records how the answer was reached so
    the distribution can be measured before any of this drives a badge.

    Deliberately strict: only literal, numeric, and date equivalence count.
    A multi-part value assembled from a sentence ("Jane Smith, Chemistry")
    reads as unsupported. That is the conservative direction for a field that
    is recorded but not yet surfaced — if measurement shows it dominates, a
    partial-coverage rule can be added with evidence behind it.

    Two known weaknesses to read the measured distribution against. Very short
    values ("1", "A") match almost any passage by coincidence, so their
    ``True`` carries little evidence. And a value that is a judgment about the
    passage rather than a span of it ("Yes" for "cost sharing is required")
    reads as unsupported unless the field declares ``enum_values``.
    """
    if not quote or not quote.strip():
        return None, "no_quote"
    if _is_not_found(value):
        return None, "empty_value"
    if enum_field:
        return None, "enum_field"
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        # Lists/dicts/bools have no verbatim form to look for. Counting them
        # unsupported would load the measurement with a class that carries no
        # hallucination signal.
        return None, "non_scalar_value"

    value_str = str(value).strip()
    norm_value, _ = normalize_with_map(value_str)
    norm_quote, _ = normalize_with_map(quote)
    if not norm_value:
        return None, "empty_value"

    if norm_value in norm_quote:
        return True, "literal"

    num = _as_number(value_str)
    if num is not None and num in _numbers_in(quote):
        return True, "numeric"

    dt = _as_date(value_str)
    if dt is not None and dt in _dates_in(quote):
        return True, "date"

    return False, "no_match"


def resolve_entity_sources(
    entities: list,
    doc_text: str,
    doc_meta: dict,
    field_meta: Optional[dict] = None,
) -> None:
    """Verify and locate each entity's raw source quotes, in place.

    The engine attaches ``entity[SOURCE_KEY] = {field: {"quote": str}}``.
    This fills each entry out to::

        {"quote", "page", "document_uuid", "document_title", "verified",
         "value_supported", "value_support_method"}

    ``verified`` is unchanged: the quote was located in the document.
    ``value_supported`` is the separate, stronger claim that the value shown
    to the user actually appears in that quote (None when the check does not
    apply — see :func:`value_supported_by_quote`). Keeping them apart is
    deliberate: today's UI treats a located quote as proof of the value, and
    collapsing the two here would bake that error in permanently.

    *doc_meta* carries ``uuid``, ``title``, ``text_markers``, and (for
    combined-context runs over a merged text) optional ``doc_spans`` —
    ``[{"start", "end", "uuid", "title"}]`` — used to attribute an offset to
    the document that contributed it. *field_meta* is the engine's per-field
    metadata map (``{key: {"enum_values", "is_optional"}}``), used to skip the
    value check on enum fields.
    """
    markers = doc_meta.get("text_markers") or []
    doc_spans = doc_meta.get("doc_spans") or []
    normalized = normalize_with_map(doc_text) if doc_text else ("", [])

    for entity in entities:
        if not isinstance(entity, dict):
            continue
        sidecar = entity.get(SOURCE_KEY)
        if not isinstance(sidecar, dict):
            continue
        for field, src in list(sidecar.items()):
            quote = src.get("quote") if isinstance(src, dict) else None
            if isinstance(quote, str):
                quote = quote.strip() or None
            offset = find_quote_offset(doc_text, quote, normalized) if quote else None
            doc_uuid = doc_meta.get("uuid")
            doc_title = doc_meta.get("title")
            if offset is not None and doc_spans:
                span = _doc_for_offset(offset, doc_spans)
                if span:
                    doc_uuid = span.get("uuid")
                    doc_title = span.get("title")
            page_marker = (
                page_marker_for_offset(offset, markers) if offset is not None else None
            )
            # Only ask whether the value is supported once the quote is known
            # to exist — a fabricated passage that happens to contain the
            # value proves nothing, so an unlocated quote stays unassessed.
            meta = (field_meta or {}).get(field) or {}
            if offset is not None:
                supported, method = value_supported_by_quote(
                    entity.get(field), quote,
                    enum_field=bool(meta.get("enum_values")),
                )
            else:
                supported, method = None, "quote_not_located"
            sidecar[field] = {
                "quote": quote,
                "page": page_marker.get("value") if page_marker else None,
                "document_uuid": doc_uuid,
                "document_title": doc_title,
                "verified": offset is not None,
                "value_supported": supported,
                "value_support_method": method,
            }
            # Set only when true, so sidecars for measured pages keep the shape
            # they have always had and existing results stay comparable.
            if page_marker and page_marker.get("approximate"):
                sidecar[field]["page_approximate"] = True
