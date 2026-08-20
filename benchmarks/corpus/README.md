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

- **tree-validate** (every PR/push touching `benchmarks/corpus/**`, or either
  of the two backend modules the corpus tools import): structural key checks,
  the retired-identity denylist, a structural person-name scan over every file
  in the corpus's own directory, and the unit tests in `tools/`.
- **asset-validate** (on publishing a `corpus-v*` release, or manually via
  workflow_dispatch): downloads the assets, verifies each sha256 against the
  manifest with `verify_assets.py` — a mismatch, a missing asset, or a tarball
  the manifest does not list fails before anything is scanned — then runs the
  person-name scan over the actual PDF/DOCX/XLSX binaries, verifies the
  scanned variants carry zero residual text, and re-verifies every answer-key
  citation against the extracted text using the product's own extraction
  helpers.

Both jobs are wired to CSU-NSF-001 by path: a second corpus added here needs
its own steps in `.github/workflows/corpus-validate.yaml` before anything
validates it.

`validate_keys.py` imports five symbols out of
`backend/app/services/document_readers.py` and
`backend/app/services/extraction_sources.py`, deliberately, so the keys are
checked against what the product actually extracts. That makes a backend
rename able to break a corpus tool from outside `benchmarks/`, which is why
both modules are in the workflow's paths filter and why
`tools/test_backend_contract.py` imports the same five and smoke-calls the
pure ones: a backend-only pull request runs the corpus job, and that test is
what fails there.

The gates are also tested against planted defects rather than only against a
clean corpus, in `tools/test_validator_failure_paths.py` — a corrupted byte, a
missing and an unlisted release asset, a corroborating page past the end of a
document, a corroborating source duplicating a canonical one, an unanswerable
question carrying corroboration, a deleted `corroborating_sources` key, a
retired identity, a new name-shaped string against a baseline, and a citation
no pass can verify that is not pinned. Both identity scanners are exercised on
generated `.docx` and `.xlsx` files as well as text, in each of the four shapes
the corpus itself once shipped: a name in a body paragraph, a name in a
signature-block table cell, a name in a section header, and a name present only
in `docProps` metadata. The table-cell case found a live bug in
`scan_person_names.py`, fixed here — `docx_lines()` yields a cell as one string
including its newlines, and `NAME` separated its groups on `\s+`, so a cell
reading `<name>` over `Vice President for Research` matched First-Middle-Last
across the line break, landed the last group on a non-person token, and dropped
the candidate. `NAME` now separates on `[ \t]+`. Every fixture is generated at
test time in a temporary directory: a checked-in file carrying a retired name or
a broken key would be scanned by the tree gates themselves.

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

Two of the nine need only pypdf and python-docx, so they run from the
repository root against an ephemeral environment. Five need PyMuPDF —
`scan_person_names.py`, `check_references.py`, `check_scans.py`,
`validate_keys.py`, and `validate_keys2.py` — and `validate_keys.py`
additionally imports the product's own extraction helpers, so all five run from
`backend/` against its environment. The remaining two, `citation_accuracy.py`
and `verify_assets.py`, import only the standard library and run anywhere —
`verify_assets.py` by design, since it is what stands between a downloaded
tarball and anything that parses it.

Keys only — everything a pull request can check without the assets:

```bash
uv run --with pypdf --with python-docx python $KEYS/tools/validate_release.py --keys $KEYS
uv run --with pypdf --with python-docx python $KEYS/tools/validate_identity_safety.py $KEYS

cd backend
uv run python ../$KEYS/tools/scan_person_names.py ../$KEYS \
  --baseline ../$KEYS/tools/name_scan_baseline_tree.json
```

With the release assets — hashes first, since every check below reads what is
inside these tarballs (`ASSETS` is the directory the tarballs were downloaded
to):

```bash
python3 $KEYS/tools/verify_assets.py --manifest $KEYS/manifest.json --assets-dir $ASSETS

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

The tools carry 69 unit tests in three files — `test_citation_accuracy.py`
(the scorer's document attribution and outcome ladder),
`test_backend_contract.py` (the five backend symbols `validate_keys.py`
depends on), and `test_validator_failure_paths.py` (each validator against a
planted defect). CI runs the directory, so a new `test_*.py` here needs no
workflow change; the tool scripts themselves are never imported by collection.

```bash
cd backend && uv run --with pytest pytest ../benchmarks/corpus/CSU-NSF-001/tools/ -q
```

`test_validator_failure_paths.py` runs each tool as a subprocess. It uses the
backend environment where that is enough and falls back to the same ephemeral
environment the workflow uses for the pypdf-only tools, so `uv` must be on
`PATH`.

## Running a corpus against a deployment

The benchmark harness (upload → ingest → chat → score) is deliberately not
in-tree — it is deployment-specific. The keys are the contribution: any
harness that produces `{id, got}` rows per question can be scored with
`tools/citation_accuracy.py`.
