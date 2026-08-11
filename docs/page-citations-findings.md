# Page citations in document chat — what worked, what didn't

Engineering notes from building and measuring the page-citation feature
(#603 → #604, #626). Written for whoever touches `annotate_pages`,
`text_markers`, or any benchmark that scores citations, so the dead ends here
don't get walked twice.

Everything below was measured on a synthetic 11-document, 36-page NSF proposal
packet against local models (Qwen3-VL-30B-A3B, Qwen3-VL-8B, Qwen3.5-9B) served
by vLLM at temperature 0.

---

## The short version

| | Outcome |
|---|---|
| `[p. N]` markers inserted into document context | **Shipped.** 31/31 citations correct on the 30B |
| `[p. ~N]` tilde for OCR-estimated pages | **Shipped.** Interpolated markers are only 84% accurate |
| `[05_Budget_Justification p. N]` self-identifying markers | **Built, measured, rejected.** Made the flagship model *worse* |
| Automated citation scoring | **Abandoned.** Three separate bugs; all citation numbers are hand-scored |

---

## What worked

### Page structure was already there — chat was the one consumer dropping it

`SmartDocument.text_markers` is computed at ingest and already consumed by
extraction sources, KB chunking and search sets. Document chat sent `raw_text`
as one flat block. The fix was not to compute anything new; it was to stop
throwing away what ingest already produced.

If you are adding a feature that needs document structure, check `text_markers`
before building a parallel path.

### A plain `[p. N]` marker is enough

Inserting `[p. N]` at each page boundary, plus a one-line note telling the model
it may cite pages, produced correct, natural citations without any further
prompting — *"stated in the Senior Personnel section of the Budget
Justification (p. 1)"*. On the 30B, **31 of 31 citations were correct**, each
one read by hand against the page it named. The 8B managed 21 of 26.

The note is omitted entirely for documents with no page structure (DOCX, and
PDFs ingested before markers existed), so the model is never invited to cite
page numbers it cannot see.

### Marking estimates as estimates

PDFs reach markers three ways. Two of them *measure* real page boundaries
(`_local_markdown_extract_from_pdf`, `_pymupdf_extract_with_pages`). The third,
`_interpolate_page_markers`, *estimates* them by spreading the page count evenly
across OCR text, because OCR services return text with no page structure.

All three used to emit the same shape, so nothing downstream could tell an
estimate from a measurement. Measured on a 36-page scanned packet, interpolated
markers place text under the right page only **84%** of the time — which is why
they now carry `approximate: True` and render as `[p. ~N]`.

That 84% is the whole justification for the tilde. If OCR ever starts returning
real page structure, re-measure before removing it.

---

## What didn't work

### Self-identifying markers — the obvious idea, and it backfired

Eleven documents get concatenated into one prompt and every one of them restarts
at page 1, so `[p. 2]` is ambiguous on its face. The natural fix is to name the
document in the marker: `[05_Budget_Justification p. 2]`.

It was built (with tests), measured against an identical baseline, and reverted.

| Qwen3-VL-30B-A3B | `[p. N]` | `[05_Budget_Justification p. N]` |
|---|---|---|
| Questions citing a page | 17 / 30 | 19 / 30 |
| Citations emitted | 31 | 35 |
| **Hand-verified correct** | **31 (100%)** | 30 (86%) |
| **Hand-verified wrong** | **0** | 5 (14%) |
| Input tokens | 24,001–24,017 | 24,535–24,548 |

Models *do* adopt the label — the 30B copies it verbatim, and the 8B more than
doubled its citation volume (26 → 60 citations, 13 → 25 questions covered). But
on the 30B the four extra citations arrived with five new errors, every one an
off-by-one page slip:

- the subaward section *begins* on p. 2, and it cited p. 2 for a figure stated
  on p. 3;
- Broader Impacts cited to Project Description p. 11 instead of p. 12;
- the equipment threshold cited to Budget Policy p. 2 instead of p. 1 — which
  the unlabelled baseline got right.

**The reading:** naming the document appears to lower the model's bar for citing
at all, and those marginal citations are much worse than the base rate. For a
research-administration tool that trade is backwards — a citation someone checks
and cannot find costs more trust than a fact with no citation at all.

**Before rebuilding it,** note that the recall gain on small models is real (the
8B's correct citations roughly doubled). If you revisit, pair the label with an
instruction to cite only what the model can point at, and re-measure.

---

## Measurement lessons — read this before scoring citations

More time went into fixing the *measurement* than the feature. Every number in
this document is hand-scored, for reasons that generalise.

### 1. Pooled scoring is not scoring

The first scorer collected every ground-truth source page for a question and
asked whether a cited *number* appeared in that set. It never checked which
document the model named. On a packet where nearly every document has a page 1
and a page 2, that is close to free marks. It reported 90%.

### 2. "Nearest document" is not "first document"

The document a citation belongs to is the one named immediately *before* it.
Scanning a lookback window with `re.search` returns the *earliest* match, which
mis-attributes every citation after the first in a bulleted, multi-document
answer. This alone moved one model from 3 apparent wrong pages to 1 real one.

### 3. Recognising a document name is harder than it looks

The same scorer required a `.pdf` extension. A model writing
`05_Budget_Justification` — the form it copies out of a self-identifying marker,
which strips the extension — scored as having named no document at all.

This bug did not just distort a number; **it invented a problem that did not
exist.** It reported that small models emit page numbers with no document
attached, which was the entire motivation for the self-identifying-marker
experiment. Corrected, the 8B has *zero* unattributed citations.

### 4. Ground truth lists minimal sources, not every supporting page

An answer key's `sources` field lists the pages *needed* to answer a question,
not every page that corroborates it. A model that cites a supporting document
therefore scores as wrong. **All five of the 30B's apparent failures were
correct citations** to documents the key doesn't enumerate — verified page by
page.

This one cannot be fixed in the scorer. Automated citation scoring needs a
separate "corroborating pages" field in ground truth before it means anything.

### 5. Check that the baseline reproduces before believing an A/B

At temperature 0 these runs are deterministic: a full baseline re-run from a
stashed working tree reproduced **30/30 answers byte-for-byte**. That control is
what makes the self-identifying-marker comparison above trustworthy rather than
a story about sampling noise. Run it before attributing any difference to a
change.

### 6. Watch for the context-budget confound

A naive digital-vs-scanned comparison looks like an OCR-quality story and is
mostly a context-budget story: the scanned packet is larger, triggers
compaction, and loses the middle of the longest document. Any citation
benchmark must either fit the window or report compaction alongside the
numbers. The clean control is the *same* OCR text with page structure stripped —
identical size, identical compaction, only the markers differ.

---

## Reproducing

The benchmark harness runs the product's own code for everything up to the HTTP
boundary — `extract_text_with_markers`, `build_document_segments`,
`plan_and_compact_context`, and the real `DOCUMENT_CHAT_SYSTEM_PROMPT`. Only
auth, upload and streaming are bypassed, so a change to any of those functions
flows straight through to the numbers.

The corpus is synthetic — fictional institutions, sites and figures, with real
published literature for the references, and non-person role identifiers
(`CSU-PI-001`) rather than names. It contains no real sponsor data and is
shareable. See #609 for the related OCR grading set.
