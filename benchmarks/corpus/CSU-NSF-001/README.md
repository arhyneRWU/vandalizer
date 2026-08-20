# CSU-NSF-001 Synthetic Proposal Benchmark (v0.5.0)

## Purpose

This package is a synthetic NSF proposal case for testing document ingestion, OCR, retrieval, context compression, citations, calculations, refusal behavior, and cross-document reasoning. It is not a valid proposal or institutional record. The institutions, sites, addresses, agreements, preliminary results, proposed experiments, and project records are fictional. Synthetic roles use stable non-person identifiers and do not represent real people. The scientific literature and open-license image sources cited in the revised narrative are real.

## What changed in v0.5.0

An external sponsor-policy review of v0.4.0 found that the packet modelled
requirements that the sponsor has since retired. Five findings were verified
independently against the NSF *Proposal & Award Policies & Procedures Guide*
(PAPPG 24-1) and the 2024 Uniform Guidance, and all five are corrected here.

- **The MTDC subaward threshold was the retired $25,000.** 2 CFR 200.1 (89 FR 30046, effective for rate proposals submitted on or after October 1, 2024) sets it at the first **$50,000** of each subaward, regardless of the period of performance. The rate agreement, budget policy, budget justification, and budget workbook now state and apply that rule, which moves the budget — see the table below.
- **The mentoring plan covered the postdoctoral scholar only.** PAPPG 24-1 II.D.2.i(i) requires one plan covering both postdoctoral scholars and graduate students, so `09_Postdoc_Mentoring_Plan` is replaced by a single one-page `09_Mentoring_Plan` with shared and group-specific components for each.
- **Facilities, Equipment and Other Resources carried dollar figures.** PAPPG 24-1 II.D.2.g bars quantifiable financial information there, so the $2.4 million genomics-core investment and the $62,000 instrument price are gone from `08_Facilities_Equipment_Resources`, which now describes the same resources narratively. Those institutional figures move to a new internal document, `16_CSU_Research_Infrastructure_Summary`, which is where the cross-document questions now find them.
- **Senior-personnel documents used the retired combined forms.** PAPPG 24-1 II.D.2.h(i–iv) requires four documents per person, so the combined `10_Biographical_Sketches` and `11_Current_Pending_Support` are replaced by per-person Biographical Sketches (10, 11), Current and Pending (Other) Support (12, 13) with no "recently completed" category, Synergistic Activities (14, 15), and a Collaborators and Other Affiliations workbook each.
- **The rate agreement imposed a provisional successor rate.** 2 CFR 200 Appendix III §C.7 applies negotiated rates for the life of each competitive segment, and Section III.D now states that instead.

The proposal is also framed explicitly as unsolicited under PAPPG 24-1 — the Budget Justification's cost-sharing statement follows from that framing — and §3 of the Project Description is retitled "Preliminary Studies".

### Corrected budget

| Line | v0.4.0 | v0.5.0 |
|---|---|---|
| Total direct costs | $807,485.77 | $807,485.77 |
| Subaward included in MTDC | $25,000 | **$50,000** — $30,000 in Year 1, $20,000 in Year 2 |
| Subaward excluded from MTDC | $35,000 | **$10,000** — Year 3 |
| MTDC exclusions | $182,636.20 | **$157,636.20** |
| MTDC base | $624,849.57 | **$649,849.57** |
| F&A at 58% of the MTDC base | $362,412.75 | **$376,912.75** |
| **Total amount requested** | $1,169,898.51 | **$1,184,398.51** |

The authoritative total is 1,184,398.51428; $1,184,398.51 is the displayed value, and every document, key, workbook cell, and validator constant agrees on it.

### Keys and comparability

The 30 question IDs and the question count are unchanged. Q021 is rewritten for the combined mentoring-plan requirement, and every answer, source page, and corroborating page was re-derived against the v0.5.0 renders rather than carried forward. **Published model-benchmark tables for this corpus were measured against the v0.3.3 answer key and predate this recomputation**, so they are not comparable on the budget questions or on the questions that cited the retired senior-personnel documents.

### Packaging note

The DOCX and XLSX sources edited for this release keep the zip member timestamps they were written with. They were deliberately not re-saved to normalize those timestamps, because re-saving risks content and hash drift against renders that are already verified. One exception is metadata only: the budget workbook's `docProps` members were rewritten in place so that all three workbooks carry the same fixed document properties — a generic synthetic-generator creator and a fixed created and modified date of 2026-08-20 — in place of the build-time values a library had written. Only those two members changed; every other member of that file is byte-identical to the one the verified renders were made from, and no workbook was re-saved. The sha256 of every release asset is pinned in `manifest.json`.

## What changed in v0.4.0

- **Corroborating sources added.** Every question now carries a `corroborating_sources` field listing pages that also state the decisive fact but fall outside the minimal canonical `sources` set. The field is present on all 30 questions and populated on 15 of them — the questions whose decisive fact is restated on a page outside the canonical set; it is empty on the other 15.
- **Citation scoring made fair.** The key now records these pages so a scorer can accept a true citation to one instead of punishing it. This is the failure mode measured in `ui-insight/vandalizer#628`, where all five of one model's apparent citation failures were correct citations to unlisted pages.
- **Questions, answers, and existing sources lists are unchanged.** v0.3.3 benchmark results remain valid and comparable.
- **README caveats added.** The shipped README now states the synthetic-degradation, context-limit, and shared-GPU-latency caveats.

## What changed in v0.3.3

- **Synthetic identities removed.** PI, Co-PI, research-administration, and federal-negotiator roles now use stable non-person identifiers: `CSU-PI-001`, `CSU-COI-001`, `CSU-VPR-001`, and `FED-NEG-001`.
- **Fictional publication records made non-bibliographic.** Biosketch products now use `SYN-PUB-*` identifiers and are explicitly labeled as fictional benchmark products. They have no human authors, journal assignments, DOIs, volumes, or pages.
- **Metadata sanitized.** Personal names were removed from Word and Excel metadata. Generic synthetic-generator metadata is used instead.
- **Benchmark keys synchronized.** Q023 and Q030 were regenerated in both `ground_truth.json` and `benchmark_questions.csv` to use the new role identifiers.
- **Real scholarship preserved.** Verified authors in References Cited and genuine open-license figure credits remain accurately attributed.

## Identity-safety policy

No natural-person name may represent a synthetic investigator, administrator, negotiator, signatory, credential holder, project participant, or fictional publication author. Stable role identifiers are used instead. Real personal names are permitted only when accurately attributing a verified scholarly reference or an open-license source. This distinction is release-gating and is checked by `tools/validate_identity_safety.py`.

## Release validation

From the package root, run `python tools/validate_identity_safety.py .` and `python tools/validate_release.py .`. The first command checks identity policy across Word, PDF, Excel, JSON, CSV, and Markdown files. The second checks question-key parity, source-page bounds, fixed PDF pagination, the complete 24-reference citation set, manifest inputs, and the authoritative budget total. It also checks the `corroborating_sources` entries against six rules: every question carries the field; each listed document exists in the package; each listed page is an integer within that document's page range; no entry duplicates a document-and-page pair already in the question's canonical `sources`; an unanswerable question's list is empty; and a workbook entry carries no page number. With the documents present it also checks the sponsor-policy invariants this release turns on: that Facilities, Equipment and Other Resources states no dollar amount, that the subaward threshold stated in the rate agreement, the budget policy, and the budget justification is the same figure and matches the workbook's inclusion constant, and that neither Current and Pending document carries a "recently completed" category. (In the vandalizer repository the validators take explicit paths instead of a package directory — see `benchmarks/corpus/README.md`, *Running the validators*.)

## What changed in v0.3.2

- **Explicit citation token** added for reference [14] in Section 5.2. The earlier `[13-15]` range already included reference [14], but the validation-method citation now reads `[13,14,15]` so literal-token validators cannot misclassify the reference as uncited.
- **Word-first generation** repeated for the Project Description and References Cited, followed by fresh PDF rendering and full-page visual inspection.
- **Pagination and keys** remain unchanged. The Project Description is still 13 pages, and all existing ground-truth page mappings remain valid.

## What changed in v0.3.1

- **References Cited** audited against publisher, DOI, and official agency records. Incorrect author lists and titles were corrected, missing persistent identifiers were added, and a generic quality-control webpage was replaced with a specific NOAA manual.
- **NSF reference completeness** improved by listing every author for all 24 references instead of abbreviating author lists with *et al.*
- **Narrative-reference consistency** verified so that all 24 listed sources are cited in the Project Description and every in-text citation resolves to a listed source.
- **Formatting** standardized to 11-point Times New Roman in the References Cited document. The Project Description remains 13 pages, so benchmark ground-truth page mappings are unchanged.

## What changed in v0.3.0

- **Project Description** rewritten as a realistic 13-page NSF-style narrative using 11-point Times New Roman, one-inch margins, four figures, real peer-reviewed literature, and explicit intellectual-merit and broader-impacts arguments.
- **Scientific scope** now separates organism detection from toxin measurement and treats autonomous molecular observations as an advisory data stream, not an automated regulatory decision.
- **Methods** now include multiplex-qPCR validation, inhibition and contamination controls, field blanks, blinded external verification, daily event-window sampling, missingness categories, and a pre-registered Bayesian state-space analysis.
- **Model evaluation** now uses held-out site-years, prevents tuning leakage, and includes a frozen prospective Year 3 evaluation.
- **Feasibility** now correctly states that 28 multiplex cartridges at four cycles per day support seven days and therefore require weekly service.
- **Figures and references** now include three open-license taxon images, three original benchmark diagrams or plots, and 24 real scientific or operational sources.
- **Ground-truth citations** were updated to match the revised Project Description pagination.

## What changed in v0.2.0

The packet was revised for realism in formatting and content while keeping every v0.1.0 dollar figure, rate, date, and answer intact:

- **Project Description** expanded from ~2.5 pages to a full-length 13-page NSF-style narrative with numbered literature citations, preliminary results, embedded figures and tables, and detailed methods.
- **F&A rate agreement** reformatted in federal NICRA style (Sections I–IV, rate table, special remarks).
- **Budget policy** rewritten as a proposal-agnostic institutional policy (CSU-RSP-204). Proposal-specific figures now live only in the proposal documents, so policy questions require genuine cross-document reasoning.
- **Five documents added** that a real NSF packet would include: References Cited, Facilities/Equipment/Other Resources, Postdoctoral Mentoring Plan (required when a postdoc is budgeted), Biographical Sketches, and Current & Pending Support.
- **Prominent "SYNTHETIC" banner tables removed** from body content; every page now carries a discreet footer disclaimer instead, so document appearance matches real proposals.
- **Ten new questions (Q021–Q030)** covering the new documents, including new distractor, unanswerable, and cross-document items. Q001–Q020 are unchanged in wording and answer; their source page citations were updated to the new layouts.

## Case design

- Fictional applicant: Coastal State University; synthetic investigator roles use non-person identifiers; fictional subrecipient
- Three-year organized-research project, 09/01/2027–08/31/2030
- 58% MTDC F&A rate (predetermined, on-campus organized research)
- $62,000 equipment purchase (excluded from MTDC)
- $30,000 participant-support program, 20 non-CSU participants (excluded from MTDC)
- $55,636.20 graduate tuition remission (excluded from MTDC)
- $60,000 subaward with the first $50,000 included in MTDC as incurred — $30,000 in Year 1 and $20,000 in Year 2 — and the remaining $10,000 (Year 3) excluded
- $34,000 internal service-center charges (included in MTDC)
- Formula-driven authoritative budget total: $1,184,398.51
- Distractor figures: $1.25 million economic-loss example, $20,000 prior internal seed award, $2.4 million institutional genomics-core investment. The seed award is stated in the Project Description and the internal Research Infrastructure Summary; the genomics-core investment now only in the latter

## Files supplied to the system under test

1. `01_CSU_Synthetic_FA_Rate_Agreement.pdf`
2. `02_CSU_Synthetic_Budget_Policy.pdf`
3. `03_Project_Summary.pdf`
4. `04_Project_Description.pdf`
5. `05_Budget_Justification.pdf`
6. `06_Data_Management_Plan.pdf`
7. `07_References_Cited.pdf`
8. `08_Facilities_Equipment_Resources.pdf`
9. `09_Mentoring_Plan.pdf`
10. `10_Biographical_Sketch_PI.pdf`
11. `11_Biographical_Sketch_CoPI.pdf`
12. `12_Current_Pending_PI.pdf`
13. `13_Current_Pending_CoPI.pdf`
14. `14_Synergistic_Activities_PI.pdf`
15. `15_Synergistic_Activities_CoPI.pdf`
16. `16_CSU_Research_Infrastructure_Summary.pdf`
17. `CSU_NSF_001_Budget.xlsx`
18. `COA_PI.xlsx`
19. `COA_CoPI.xlsx`

Sixteen PDFs, 42 pages, plus three workbooks. Editable DOCX versions are included for controlled scan generation and later revisions.

## Files withheld from the system under test

- `ground_truth.json`
- `benchmark_questions.csv`
- `manifest.json`

## Recommended test modes

1. Clean digital PDF and XLSX files
2. PDFs printed and scanned at 300 dpi
3. Moderately degraded scans at 200 dpi with slight skew and contrast loss
4. Severe but readable scans at 150 dpi
5. Full-document chat
6. Knowledge-base retrieval
7. Current Vandalizer context truncation
8. Experimental Headroom compression

## Scoring dimensions

- Answer correctness
- Numeric exactness
- Citation document correctness
- Citation page correctness
- Refusal on unanswerable questions
- Preservation of distinctions among requested funds, prior support, contextual figures, and institutional investments
- OCR transcription accuracy
- Tokens and processing time

## Synthetic-data notice

Every institution, address, agreement, preliminary result, proposed experiment, and project record in this package is fictional. Synthetic investigator and administrative roles use non-person identifiers. Biosketch products are explicitly labeled synthetic benchmark records rather than publications. References Cited and open-license image sources in the Project Description are real and accurately attributed. Sponsor forms and policies used as design references are not reproduced as purported official documents. Every page carries a synthetic-document footer.

## Limits — read before citing results from this corpus

- **The scanned variants are synthetic degradation, not scanner output.** They
  rasterize the digital PDFs with per-page seeded blur, noise, skew, uneven
  illumination, and JPEG compression, and no text layer survives at any level —
  so they genuinely force the OCR path. But they are not paper that passed
  through a physical scanner: no real sensor noise, feed distortion, staples,
  or toner artifacts. Do not cite OCR results from these files as real-scan
  performance.
- **Context-limit behaviour is not exercised.** The whole packet is ~26k
  tokens and fits a 32k window, so long-document routing, compaction, and
  silent-truncation failures cannot reproduce against it. A result on this
  corpus says nothing about behaviour past the context limit.
- **Latency must not be measured on a shared or single-GPU host.** Timings
  there are bimodal — warm inference is sub-2s while a cold model load is
  minutes — so any speed number includes the scheduler, not the model.
  Measured during the #628 benchmark: 139 of 350 timings were model-load.
- **Answer accuracy has no headroom.** Strong models answer 30/30; the corpus
  detects breakage but cannot rank good configurations. Citation accuracy and
  refusal on unanswerable questions are the discriminating columns.

## Planned for the next release

- A question set weighted toward absence: measured across five models,
  recall-style questions were at ceiling (2-point spread) while negative
  controls spread 25 points — absence is the only question type that ranked
  anything.
- One oversize document per packet, so context-limit behaviour becomes
  testable.
- Additional packets in distinct sponsor styles (federal-vs-match budget
  columns, modular budgets, cost-share commitments, multi-institution
  subawards).
