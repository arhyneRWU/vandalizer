# Per-model token calibration and estimate self-check

**Date:** 2026-08-11
**Status:** design approved, not yet implemented

## Problem

Chat budgets are computed from a token count. When that count reads low, the
planner believes a request fits, the model rejects it, and the user gets a hard
error with no answer — with the routing feature that exists to prevent exactly
that sitting idle, because it consults the same optimistic number.

Exact tokenization (commit `13604b52`) fixed this for models whose vocabulary
the deployment has on disk. Three gaps remain, all of which fail *silently*:

1. **Models with no local vocabulary** — hosted APIs — fall back to a guessed
   `DEFAULT_TOKEN_SAFETY_MARGIN` of 1.20. Measurement shows 1.20 is
   insufficient for numeric content, and no measurements exist for any hosted
   model on this deployment.
2. **Name mismatch degrades silently.** A model registered under an alias
   (`Qwen-30b`), a different case, or with trailing whitespace resolves no
   vocabulary and drops to the guessed margin with no log and no UI signal.
   Verified: `'Qwen/Qwen3-VL-30B-A3B-Instruct '` → `exact=NO, margin=1.2`.
3. **A stale or wrong-revision `tokenizer.json`** would produce confident,
   wrong counts that look exactly like correctness.

Underlying all three: nothing in the system ever checks its own estimate
against what the model actually charged, even though every successful response
already reports `usage.prompt_tokens`.

### Why a better constant is not the answer

Divergence between `cl100k_base` and a model's real vocabulary is driven by
content, not by model or request size. Measured against the models' own
`prompt_tokens`:

| Content | Ratio |
|---|---|
| Flowing prose | 1.000 |
| Project description | 1.019 |
| Real budget justification | 1.171 |
| Synthetic dense currency table | 1.455 |

Qwen tokenizes digits individually where cl100k groups them
(`$1,169,898.51` → 13 tokens vs 8), a deliberate choice that improves
arithmetic. So the correction factor is a property of the model *crossed with
the content*, and no single constant is safe across that range. Research
administration documents are the digit-dense end of it.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Calibration payloads | Baked-in fixtures | Works on a fresh install with no documents, deterministic across deploys, no user data sent to a model during a config action |
| Trigger | Admin-initiated, plus a continuous self-check on live traffic | Baseline is deliberate and predictable; drift is caught from data already arriving free |
| Authority of a result | Fills only the gaps exactness leaves | Keeps exact counts where we have them; replaces guessing where we do not |
| Surfacing | `QualityAlert`, deduped by unacknowledged | Reuses existing machinery; logs alone are how the bugs in this effort hid |
| Scope | Every model, including vocab-backed ones | Measures per-model overhead and verifies the vocab matches what the server serves |

## Architecture

`model_probe.py` is left untouched. It reads `/v1/models` metadata — cheap, no
inference, no GPU. Calibration sends real requests and reads `usage`, with a
different cost profile and blast radius on a shared GPU. Putting an inference
call behind a button labelled "probe" would be a bad boundary. Calibration is a
new sibling module, surfaced next to it in the same admin form.

| Component | Responsibility |
|---|---|
| `app/services/token_calibration_fixtures.py` | The payloads. Prose / mixed / numeric, two sizes each. Pure data. |
| `app/services/token_calibration.py` | Send fixtures, read `usage.prompt_tokens`, fit ratio + overhead, return `CalibrationResult`. No storage, no routing. |
| `app/routers/admin.py` | `POST /config/calibrate-tokens`. Decrypts the key, calls the service, returns an advisory result. Same contract as `probe_model`. |
| `app/services/context_budget.py` | Consumes stored calibration in the rung-2 slot. Already owns the ladder. |
| `app/services/token_estimate_check.py` | Compares estimate against `usage` on live responses; raises alerts. |
| `app/services/chat_service.py` | One call into the check where `usage` is already read. Nothing else changes. |

`CalibrationResult` mirrors `ProbeResult`: measured values, a `method` string,
and a human-readable `detail` explaining a miss.

### Two payload sizes, deliberately

Ratio (multiplicative) and overhead (fixed) are different quantities and one
measurement cannot separate them. Two sizes give two equations. Confirmed by
measurement: the delta between estimate and charge was **identical (+475) at
both a 25,000-token and a 50,000-token request**, which is only explicable as a
fixed cost, and which a single fudge factor would get wrong at one end.

### The fit, stated explicitly

For each fixture family (prose, mixed, numeric) two payloads are sent, small
and large. For one family with counted sizes `c1 < c2` and charges `a1, a2`:

```
rate     = (a2 - a1) / (c2 - c1)      # multiplicative, per-token
overhead = a1 - rate * c1             # fixed, per-request
```

- **`overhead_tokens`** = the maximum overhead across the three families,
  rounded up. It should be near-identical across them; a large spread means the
  fit is unreliable and the result is returned as `method="unavailable"` with
  the spread in `detail` rather than stored.
- **`ratio`** = the maximum `rate` across the three families — the **worst**,
  not the mean. Costs are asymmetric: guessing high routes early, guessing low
  hard-fails. Calibrating on average content would under-count budget
  documents, which is the failure this exists to prevent.
- **`vocab_verified`** (vocab-backed models only) = whether the locally
  computed exact count reproduces the charge once overhead is subtracted,
  within ±1%. False means the on-disk vocabulary disagrees with what the server
  is serving — a stale or wrong-revision `tokenizer.json` — and the model is
  demoted to the measured ratio rather than trusted as exact.

## Data flow and storage

Stored on the model's own entry in `SystemConfig.available_models`, beside
`context_window` — same object the admin already edits, no new collection:

```python
"token_calibration": {
    "ratio": 1.0,              # multiplicative; 1.0 when vocab-exact
    "overhead_tokens": 37,     # fixed, measured
    "method": "exact_vocab" | "measured" | "unavailable",
    "vocab_verified": true,    # exact count agreed with what was charged
    "measured_at": "2026-08-11T21:04:00Z",
    "samples": [{"fixture": "numeric", "counted": 2011, "charged": 2354}]
}
```

`samples` is kept so anyone can re-derive the fit and see what it was measured
against. That is the difference between a measurement and a magic constant.

**Storage holds the measurement; the budget owns the policy.** We store the raw
measured 37, not a padded value. `context_budget` applies its own documented
headroom on top. Blending the pad into storage would make the number
un-auditable and impossible to re-fit.

### Resolution ladder

1. **Local vocabulary** → exact count, ratio 1.0 *(already built)*
2. **`token_calibration.ratio`** → measured, replaces the guessed margin
3. **`DEFAULT_TOKEN_SAFETY_MARGIN`** → last resort, and it announces itself
   instead of degrading silently

"Announces itself" means: a `logger.warning` naming the model and the reason
(no vocabulary found, no calibration stored), emitted **once per model name per
process lifetime** via a module-level `set`. Per-request logging would be noise
at chat volume; per-process is enough to be seen after a deploy or a config
change, and resets naturally on restart.

Timezone-aware UTC datetimes throughout (`datetime.now(tz=timezone.utc)`),
matching `QualityAlert` and the naive/aware fix in `5735b9c6`.

### Self-check

`chat_service` already reads `usage` after streaming. One call passes
`(estimate, charged, model)` to the checker. If the estimate is below the
charge, a `QualityAlert` is raised.

Two severities, reporting two different things:

- **warning** — estimate read low, but the request still fit. Latent.
- **critical** — the estimate said it fit and the charge exceeded the input
  budget. The bug #1 failure, caught on recurrence rather than months later.

**Dedupe follows the existing `quality_tasks.py` convention**: find an
unacknowledged alert with the same `(alert_type, item_kind, item_id)` and skip
if one exists. `QualityAlert` has no `occurrences`-style coalescing — that is
`Notification`'s mechanism, and duplicating it here would be a second way to do
one thing.

One deliberate addition: if an unacknowledged **warning** exists and a
**critical** occurs, escalate the existing alert's severity rather than
skipping. Otherwise the first mild case masks the real failure.

`alert_type="token_undercount"` joins `regression | stale | config_changed`.
`item_kind="model"` needs no schema change — `quality_tasks.py` already uses
`item_kind="system"` beyond the values named in the docstring.

## Error handling

- **Nothing calibration does may break chat.** The self-check runs after
  streaming completes, wrapped so any failure is swallowed and logged. A DB
  hiccup writing an alert must never surface as a chat error. Cost is one
  indexed read plus an occasional write, off the streaming path.
- **Calibration failure is a result, not an exception.** Unreachable endpoint,
  a model that will not load, a response without `usage` → `method="unavailable"`
  with a readable `detail`. `anthropic_no_probe` is the precedent.
- **Never overwrite good data with a failed measurement.** A failed calibration
  leaves the stored value untouched.
- **GPU awareness.** Calibration sends real inference and can trigger a model
  reload on the shared GPU. Acceptable because it is admin-initiated and rare.
  Fixtures are small; models are calibrated sequentially, never in parallel.

## Testing

Unit and integration tests mock **only** the HTTP boundary. No mocked
tokenizers: a weak test earlier in this effort passed while the tokenizer was
bypassed, because the assertion could not distinguish the two implementations.

- Fixtures: assert measured ratios span the range (prose ≈ 1.0, numeric ≥ 1.4)
  so a future edit cannot quietly flatten the calibration signal
- The ratio/overhead fit is pure arithmetic → unit-test against real measured
  numbers (2,011 → 2,354; +475 at both 25k and 50k)
- Ladder resolution: vocab beats calibration beats default; every rung,
  including the loud-fallback log
- Self-check: warning vs critical split, dedupe-by-unacknowledged, severity
  escalation, and that a raising alert-writer cannot break a chat response
- Each guard verified by sabotage — reintroduce the fault, watch the test fail

### End-to-end (Playwright)

`frontend/e2e/model-calibration.spec.ts`, following existing specs including
the `test.skip(!process.env.E2E_TEST_USER || ...)` guard from
`context-dialog.spec.ts`. Split by whether the GPU is required, so regression
value lands in CI rather than depending on a free GPU:

| Scenario | Live model? | Proves |
|---|---|---|
| Calibrate → ratio/overhead/method render → save → persists across reload | yes | The whole path works for real |
| Calibrate an unreachable endpoint → honest failure, stored values untouched | no | "Never overwrite good data" holds in the UI |
| Seed an under-count alert → appears in admin quality view → acknowledge → does not reappear | no | Dedupe behaves as designed |
| A model with no vocabulary shows it is on the estimated path | no | The loud-fallback requirement is visible to a human |

Every unit test here mocks the HTTP boundary, so nothing else proves an admin
can actually *see* a result, or that a failed probe does not blank the form.

**Operational note:** the repo brief prescribes a container for frontend tests
because there is no node on the host, but that recipe covers Vitest. Playwright
additionally needs browser binaries, so it requires the Playwright image rather
than `node:22-alpine`:

```bash
docker run --rm --network host -v "$PWD":/w -w /w \
  -e PLAYWRIGHT_BASE_URL=http://127.0.0.1:18080 \
  -e E2E_TEST_USER -e E2E_TEST_PASS \
  mcr.microsoft.com/playwright:v1.50.0-noble \
  sh -c 'npm ci --ignore-scripts --no-audit --no-fund && npx playwright test e2e/model-calibration.spec.ts'
```

The image tag must match the repo's Playwright version; confirm before use.

## Out of scope

- **Provider-native token counting.** Some providers expose a token-counting
  endpoint, which would be exact for hosted models and better than calibrating
  around them. Worth checking per provider; not assumed here.
- **The model server's `/tokenize`.** Deliberately not used: a call landing on
  a released model would queue behind a ~36 GB reload and take the GPU claim,
  which is the same contention that silently fails OCR uploads.
- **Multimodal token accounting.** These are vision-language models. Image
  tokens appear in `prompt_tokens` but in none of the strings we count. This is
  an untested and potentially large under-count, and it is a separate piece of
  work — the self-check will surface it rather than fix it.
- **Auto-widening a margin in response to an alert.** Rejected: a system that
  mutates its own budgeting is harder to audit, and a bad measurement could
  ratchet permanently.

## Success criteria

- Every model either counts exactly, carries a measured calibration, or is
  visibly on the estimated path. No silent third state.
- An alias-named model no longer degrades silently.
- An estimate that reads low raises an alert on first occurrence.
- Live verification after deploy: estimate vs `prompt_tokens` on rows
  L1/L2/R1/R2, all on the safe side, as in commit `13604b52`.
