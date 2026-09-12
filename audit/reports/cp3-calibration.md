# CP3 Calibration Report — Blocked

## Decision

**CALIBRATION BLOCKED**

V2 cutover is not justified. The stable legacy router on port `20200` remains the control path. No V2 authoritative serving mode was enabled.

## Lineage and gates

- Branch: `hermes/autorouter-v2-cp3-calibration-cutover`
- Starting HEAD: `d9fc914b0ab882f21868f2ff7c9f29c6e40b0fac`
- Required CP1 baseline: `4f7a1d9017028ee317fb7118ca77c9f79c1075b2`
- CP1: `complete`
- CP2: `shadow-ready`
- CP2 corrected lineage derives from CP1: verified by `audit/checkpoints/cp2.json` and Git history
- Baseline test suite: PASS, 8 files / 83 tests
- Build: PASS (`tsc -p tsconfig.json`)
- Stable port `20200`: not modified
- Canary port `20201`: health endpoint responded successfully and `/v1/models` returned 6 models
- Authenticated canary completion: previously recorded PASS, HTTP 200 with choices; credentials were not recorded

## Corpus and rubric

- Corpus: `benchmark/corpus.json`
- Corpus version: `cp3-v1`
- Cases: 20
- Categories: A through J, including transformation, code, repository exploration, implementation, refactoring, debugging, concurrency, architecture/review, analysis, and research/synthesis
- Rubric: `benchmark/rubric.md`
- Grading is deterministic keyword/required-symbol checking; models do not grade themselves.
- Limitation: the corpus cases are prompt/output evaluations, not executable repository patches or tool-call sessions. They are useful routing evidence but insufficient alone to prove Hermes tool execution quality.

## Candidate evidence

### Complete subset: `benchmark/subset-results.json`

The subset contains 5 cases × 9 candidates = 45 records.

| Candidate | Pass | Fail | Total latency | Input tokens | Output tokens | Reasoning tokens |
|---|---:|---:|---:|---:|---:|---:|
| `ag/gemini-3.8-flash-low` | 5 | 0 | 9,604 ms | 10,626 | 2,715 | 0 |
| `ag/gemini-3.8-flash-medium` | 5 | 0 | 19,293 ms | 10,626 | 10,170 | 7,627 |
| `ag/gemini-3.8-flash-high` | 4 | 1 | 48,343 ms | 8,558 | 8,517 | 5,251 |
| `cx/gpt-5.6-luna` | 5 | 0 | 57,884 ms | 12,957 | 2,700 | 0 |
| `cx/gpt-5.6-sol` | 4 | 1 | 72,690 ms | 10,387 | 1,677 | 0 |
| `cx/gpt-5.6-terra` | 5 | 0 | 60,768 ms | 12,957 | 2,453 | 0 |
| `cx/gpt-6-astra` | 4 | 1 | 79,812 ms | 10,387 | 1,311 | 0 |
| `ag/claude-sonnet-4-6` | 2 | 3 | 7,507 ms | 10,678 | 1,574 | 0 |
| `ag/claude-opus-4-6-thinking` | 3 | 2 | 7,596 ms | 10,678 | 1,569 | 0 |

Subset failures included timeouts for Gemini High, Sol, and Astra; rubric misses for Claude Sonnet and Claude Opus on the PostgreSQL case and for Claude Sonnet on the financial reconciliation case. These are observations, not a final ranking because the sample is small and the rubric is text-based.

### Full corpus attempt: incomplete

The full runner targeted 20 cases × 6 candidates = 120 records. The provided process output stopped during `case-b1` at record 15 after a timeout from Gemini Medium. The resumable artifact subsequently contained 44 records spanning only 9 cases and 5 candidates; it did not contain a complete candidate-by-case matrix.

The partial artifact showed the following non-final observations:

- Gemini Flash Low: 8 passes / 9 records
- Gemini Flash Medium: 7 passes / 9 records, 2 timeout failures
- GPT-5.6 Luna: 6 passes / 8 records, one timeout and one rubric failure
- GPT-5.6 Terra: 5 passes / 8 records, two timeouts and one rubric failure
- GPT-6 Astra: 5 passes / 8 records, two timeouts and one rubric failure

The record count and candidate set changed during resumed execution, so this artifact cannot support a full-corpus comparison or curated ranking.

## Cost and reasoning evidence

Only measured proxy metrics are recorded: latency, input tokens, output tokens, reasoning tokens when surfaced, and timeout/request failure observations. No dollar cost is claimed because provider billing was not available.

Supported operational observations:

- Gemini Low surfaced zero reasoning tokens and had the lowest measured latency in the completed subset.
- Gemini Medium surfaced reasoning tokens and had materially higher output/reasoning volume than Gemini Low.
- CX candidates had materially higher latency in the completed subset than Gemini Low/Medium.
- Provider/model timeout behavior was observed for multiple candidates.

Cost classes and reasoning profiles remain provisional; they must not be treated as production calibration without a complete controlled run.

## Review variants

The inventory lists `cx/gpt-5.6-luna-review`, `cx/gpt-5.6-sol-review`, and `cx/gpt-5.6-terra-review`, plus other `-review` variants. The available evidence proves registry presence only. No reliable behavioral or upstream documentation comparison was captured. They remain excluded from the primary candidate pool.

## Provisional profile hypothesis — not selected

The following was used only for local comparison tooling and is explicitly not approved for V2:

- Cheap: Gemini Flash Low
- Balanced: Gemini Flash Medium
- Strong: a CX 5.6 candidate or Gemini Flash High
- Frontier: Astra or Claude Opus
- Specialist: not justified
- Resilience: not justified

No model was promoted into a final curated profile because the complete benchmark and legacy comparison gates did not pass.

## Routing calibration findings

The current CP2 shadow router preserves current-step awareness, bounded session state, quality floors, and shadow fail-open behavior. Its current classifier has calibration defects exposed by the corpus:

- `case-g3` could not find an eligible profile under the provisional profile set.
- Several repository/debugging prompts were classified as `code` or `general` in ways that do not consistently match their category.
- The comparison runner failed with `No enabled profile satisfies shadow requirements` before producing `benchmark/legacy-vs-v2-comparison.json`.
- Session simulation and escalation/de-escalation were not converted into an accepted calibration report with predefined thresholds.

These are blockers, not reasons to broaden eligibility or enable V2 speculatively.

## Legacy versus V2

No valid comparison exists. The intended comparison could not be completed because the V2 decision runner failed on profile eligibility and the full corpus execution was incomplete. Therefore there is no defensible result for task success, latency, token proxy, model-tier distribution, failure rate, frontier usage, or switches per session.

## Deferred phases

Because Gate 2 did not pass, the following were intentionally not implemented:

- `ROUTER_MODE=legacy|shadow|v2` serving-mode cutover
- V2 authoritative forwarding
- cross-model pre-stream fallback in V2
- CP3 canary traffic through an authoritative V2 mode
- CP3 failure-test suite for V2 fallback/stream safety
- rollback smoke test for a V2 mode
- final curated profile registry

The documented safe rollback concept remains configuration-only: `ROUTER_MODE=legacy`, but the variable is not currently an implemented CP3 serving-mode switch.

## Required next evidence

1. Run one fixed, immutable candidate set against all 20 cases with a bounded timeout and deterministic resume key `(corpusVersion, caseId, model)`.
2. Capture complete matrices for the nine subset candidates before excluding any model.
3. Correct and test the shadow eligibility mismatch, especially `case-g3`, without weakening quality floors.
4. Add executable fixture tasks and tool-use/session scenarios; text keyword checks alone are insufficient.
5. Produce a valid legacy-versus-shadow report before reconsidering Gate 2.

## Files and safety

All CP3 artifacts are currently uncommitted on the calibration branch. No secret values were placed in source, reports, or audit artifacts. The stable port `20200` was left untouched.
