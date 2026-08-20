# Benchmark corpora

Shareable synthetic document sets with verified answer keys, for measuring
ingestion, OCR, retrieval, page-citation accuracy, and refusal behaviour
against known-correct answers. Everything here is synthetic — see each
corpus's README and IDENTITY_SAFETY.md. Contributed via
[#628](https://github.com/ui-insight/vandalizer/issues/628).

## Layout

What lives in the tree is what people need to read, review, and diff: each
corpus's README, manifest, blind question set, answer key, and validators.
The documents themselves (PDF/DOCX/XLSX and the rasterized scanned variants)
are **release assets**, listed by name and sha256 in the corpus manifest and
attached to the release tagged in it (`corpus-v*`). They stay out of the tree
deliberately: they are large binaries, and they look exactly like the real
proposals search engines index.

## Validation

`.github/workflows/corpus-validate.yaml` runs two jobs:

- **tree-validate** (every PR/push touching `benchmarks/corpus/**`):
  structural key checks, the retired-identity denylist, a structural
  person-name scan over every file in the corpus's own directory, and the
  citation-scorer unit tests.
- **asset-validate** (on publishing a `corpus-v*` release, or manually via
  workflow_dispatch): downloads the assets, verifies each sha256 against the
  manifest — a mismatch fails before anything is scanned — then runs the
  person-name scan over the actual PDF/DOCX/XLSX binaries, verifies the
  scanned variants carry zero residual text, and re-verifies every answer-key
  citation against the extracted text using the product's own extraction
  helpers.

Both jobs are wired to CSU-NSF-001 by path: a second corpus added here needs
its own steps in `.github/workflows/corpus-validate.yaml` before anything
validates it.

The person-name scan is the load-bearing check: the denylist can only catch
names already known to be wrong, while the structural scan finds every
name-shaped string in text, tables, headers, footers, and metadata and
subtracts the permitted locations (genuine scholarly attribution in
References Cited). See each corpus's IDENTITY_SAFETY.md for why this policy
exists.

## Running the validators

These are the in-tree tools, which take every path as an argument. Note that a
corpus's own README describes the **unpacked release package** — a single flat
directory holding the documents, the keys, and a bundled copy of the validators
— and the tools bundled there take that package directory positionally
(`python tools/validate_release.py .`); the in-tree tools below do not, because
in the tree the keys and the documents live in different places.

Set `KEYS=benchmarks/corpus/CSU-NSF-001`, and `BIN` to the directory the release
tarballs were unpacked into (holding `pdf/`, `source/`, `scanned/`). `BIN` must
be an **absolute** path: the examples below `cd backend` partway through, so a
relative `BIN` would resolve against the wrong directory.

Two of the eight need only pypdf and python-docx, so they run from the
repository root against an ephemeral environment. Five need PyMuPDF —
`scan_person_names.py`, `check_references.py`, `check_scans.py`,
`validate_keys.py`, and `validate_keys2.py` — and `validate_keys.py`
additionally imports the product's own extraction helpers, so all five run from
`backend/` against its environment. The eighth, `citation_accuracy.py`, imports
only the standard library and runs anywhere.

Keys only — everything a pull request can check without the assets:

```bash
uv run --with pypdf --with python-docx python $KEYS/tools/validate_release.py --keys $KEYS
uv run --with pypdf --with python-docx python $KEYS/tools/validate_identity_safety.py $KEYS

cd backend
uv run python ../$KEYS/tools/scan_person_names.py ../$KEYS \
  --baseline ../$KEYS/tools/name_scan_baseline_tree.json
```

With the release assets:

```bash
uv run --with pypdf --with python-docx python $KEYS/tools/validate_release.py --keys $KEYS --binaries $BIN
uv run --with pypdf --with python-docx python $KEYS/tools/validate_identity_safety.py $KEYS $BIN

cd backend
uv run python ../$KEYS/tools/check_references.py --binaries $BIN
uv run python ../$KEYS/tools/check_scans.py --binaries $BIN
uv run python ../$KEYS/tools/scan_person_names.py $BIN \
  --baseline ../$KEYS/tools/name_scan_baseline_assets.json
uv run python ../$KEYS/tools/validate_keys.py --keys ../$KEYS --binaries $BIN
uv run python ../$KEYS/tools/validate_keys2.py --keys ../$KEYS --binaries $BIN \
  --allow Q021:04_Project_Description.pdf:11
```

Scoring a harness run — `raw.json` is a list of `{"id": ..., "got": ...}` rows:

```bash
python $KEYS/tools/citation_accuracy.py --keys $KEYS raw.json
```

Every tool exits non-zero on failure. Three carry a reviewed exception set, so
that a *new* exception is the thing that fails rather than the standing ones:
`scan_person_names.py --baseline` (name-shaped strings already read and cleared
— invented place names, mostly), `validate_keys2.py --allow QID:FILE:PAGE`
(citations already adjudicated), and `validate_keys.py --allow-unverifiable
QID:FILE`, which extends a set pinned in the tool itself. Widening any of the
three is a visible diff.

`tools/test_citation_accuracy.py` covers the scorer's document attribution and
its outcome ladder:

```bash
uv --directory backend run pytest ../benchmarks/corpus/CSU-NSF-001/tools/test_citation_accuracy.py -q
```

## Running a corpus against a deployment

The benchmark harness (upload → ingest → chat → score) is deliberately not
in-tree — it is deployment-specific. The keys are the contribution: any
harness that produces `{id, got}` rows per question can be scored with
`tools/citation_accuracy.py`.
