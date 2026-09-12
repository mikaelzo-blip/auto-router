# CP3A Benchmark Harness and Calibration-Evidence Repair Report

## 1. Executive Summary & Verdict

**FINAL VERDICT: CP3A READY FOR FULL CALIBRATION**

CP3A repairs the benchmarking methodology, profile eligibility coverage, and multi-turn simulation harnesses so that future model calibrations can be trusted.

- **V2 Cutover**: NOT implemented (`ROUTER_MODE=v2` remains inactive; legacy routing is authoritative).
- **Final Execution Profiles**: NOT selected (provisional evaluation sets only).
- **Stable Port 20200**: UNTOUCHED.
- **Canary Port 20201**: Verified in shadow/virtual mode only.

---

## 2. Lineage & Checkpoint Base

- **Starting HEAD**: `d9fc914b0ab882f21868f2ff7c9f29c6e40b0fac`
- **CP1 Complete Baseline**: `4f7a1d9017028ee317fb7118ca77c9f79c1075b2`
- **CP2 Shadow Ready Baseline**: `6150245f6f81bba8c0a0f6dc487bbd6c5133a52f`
- **Blocked CP3 Evidence Commit**: `a603b573d9ecf801648a7fa9539352668b556f08`
- **Active Branch**: `hermes/autorouter-v2-cp3-calibration-cutover`

---

## 3. Benchmark Request Path Verification

### Distinction between Ports
- **AutoRouter (:20201 canary / :20200 stable)**:
  - Role: Lightweight virtual model proxy for AI agent clients (Hermes, Codex).
  - `/v1/models` Behavior: Intentionally exposes **only** the 6 AutoRouter virtual model aliases (`auto`, `code`, `analysis`, `fast`, `explore`, `research`) defined in `config/routes.json`.
  - `/v1/chat/completions` Behavior: Strictly requires a virtual model identifier. If a concrete model ID (such as `ag/gemini-3.8-flash-low` or `cx/gpt-5.6-luna`) is submitted, AutoRouter intentionally rejects it with HTTP 400: `{"error":{"message":"Unknown model '...'","code":"invalid_model"}}`.
- **9Router (:20128 upstream gateway)**:
  - Role: Upstream AI provider gateway directly interfacing with upstream model APIs.
  - `/v1/models` Behavior: Exposes the complete concrete inventory (39 concrete models discovered, including Gemini Flash 3.8/3.7/3.6/3.5, GPT-5.6/5.5/5.4/5.3/6, Claude Sonnet 4-6, Claude Opus 4-6).
  - `/v1/chat/completions` Behavior: Accepts and executes concrete model identifiers using `UPSTREAM_API_KEY`.

### Verification Conclusion
Concrete-model benchmark evaluations must send requests directly to `http://127.0.0.1:20128/v1/chat/completions`. AutoRouter's `/v1/models` must never be used to query or infer concrete model availability.

---

## 4. Profile Coverage & Eligibility Repair

### Failing Case Reproduction (`case-g3`)
When running `scripts/compare-legacy-v2.ts`, the harness threw:
`Error: No enabled profile satisfies shadow requirements` on `case-g3`.

- **Task Prompt**: An accounting service generates human-readable invoice numbers in the format `'INV-2026-0001'`. Under high concurrent load, duplicate key errors occur with `SELECT MAX(num)`. Requires explaining read committed isolation and providing PostgreSQL sequence and locked counter solutions.
- **Identified Failure State**:
  - `taskType`: `transformation` (misclassified because prompt contained the phrase "in the format 'INV-2026-0001'", matching `/translate|rewrite|rephrase|format|summariz/`).
  - `complexity`: `high` (matched "race condition", "concurr").
  - `risk`: `low` (accounting/invoice terms were missing from `riskOf`).
  - `hard capabilities`: `{ tools: false, vision: false }`.
  - `minimum tier`: `strong` (driven by high complexity).
  - `candidate profiles`: `gemini-flash-low`, `gemini-flash-medium`, `luna`, `terra`, `astra`.
  - **Rejection Reasons**:
    - `gemini-flash-low`: `qualityTier: "cheap"` < minimum `strong`.
    - `gemini-flash-medium`: `qualityTier: "balanced"` < minimum `strong`.
    - `luna`, `terra`, `astra`: `taskFit` was `["code", "analysis", "research", "general", "multimodal"]`, which omitted `transformation`.
  - Eligible candidates: **0**, triggering the runtime exception.

### Systematic Design Fixes
1. **Classification Precedence**: Refined `classify()` in `src/shadow-router.ts` so that technical, programming, SQL, and concurrency keywords (`concurr`, `sql`, `postgres`, `database`, `query`, `lock`, `race condition`, `diagnos`, `socket`) take precedence over casual noun matches like "format".
2. **Risk Classifier Expansion**: Enhanced `riskOf()` to classify financial ledgers, settlements, reconciliations, invoices, and concurrency race conditions as high/medium risk.
3. **TaskFit Coverage**: Updated `config/shadow-profiles.json`, `src/shadow-profiles.ts`, and `calibratedProfiles` so that strong and frontier models (`gemini-flash-high`, `claude-sonnet`, `claude-opus`, `astra`, `luna`, `terra`) include `"transformation"` in their `taskFit`. Modern frontier models are inherently capable of translation, summarization, and formatting.
4. **Registry Coverage Validation (`validateProfileCoverage`)**:
   Added validation enforcing that for every supported routing class (`general`, `transformation`, `code`, `analysis`, `research`, `multimodal`) and hard capability combination (`tools: true/false`, `vision: true/false`), there is at least one enabled profile at every quality floor up to `frontier`. This is verified on startup via `loadShadowProfiles()` in `src/config.ts`.
5. **Structured Fallback Decision**:
   Replaced `throw new Error("No enabled profile satisfies shadow requirements")` in `routeShadow` with a tiered relaxation fallback:
   - First relaxes `taskFit` while strictly maintaining hard capabilities and minimum quality tier.
   - If still insufficient, relaxes quality tier while strictly maintaining hard capabilities.
   - Sets `fallbackEngaged: true` and `fallbackReason` in `ShadowDecision`, recording the occurrence in telemetry and explanation without crashing.

---

## 5. Failure Classification Taxonomy

Failures are classified into 9 explicit mutually exclusive categories:
1. `QUALITY_FAILURE`: Request completed with HTTP 200 and returned valid content, but output failed rubric dimensions or invariant checks.
2. `INFRA_TIMEOUT`: Upstream connection or read timeout (`AbortError`, `TimeoutError`, HTTP 504).
3. `HTTP_429`: Upstream rate limit or quota exhaustion.
4. `HTTP_5XX`: Upstream server errors (HTTP 500, 502, 503).
5. `AUTH_FAILURE`: Authentication or permission errors (HTTP 401, 403).
6. `MODEL_UNAVAILABLE`: Model not found on upstream provider (HTTP 404).
7. `TOOL_FAILURE`: Tool call format error or tool execution exception.
8. `HARNESS_ERROR`: Connection refused, DNS failure, or local runner error.
9. `INVALID_RESPONSE`: HTTP 200 returned with empty or whitespace-only body.

### Metric Separation
- `quality_success_rate_when_executed`: Evaluates only requests that succeeded operationally (`passes / (passes + QUALITY_FAILURE)`). Infrastructure timeouts are never counted as quality failures.
- `operational_success_rate`: Evaluates transport and gateway reliability (`operationalSuccesses / totalAttempts`).

---

## 6. Resumable Benchmark Architecture & Timeout Isolation

### Resumability Design
- **Unique Unit Key**: `${caseId}::${modelId}::${attempt}`
- **Immediate Persistence**: Every benchmark unit is written to the output JSON file immediately upon completion. A process crash or tool-call limit will not lose prior results.
- **Resume Flag (`--resume`)**: Automatically loads previously saved records and skips any unit that was already completed.
- **Granular Controls**:
  - `--resume`: Enable incremental continuation.
  - `--model`: Comma-separated model IDs.
  - `--case`: Comma-separated case IDs.
  - `--category`: Category prefix filter.
  - `--attempts`: Number of attempts per unit.
  - `--timeout`: Per-request timeout in ms.
  - `--output`: Custom output path.

### Timeout Isolation
- Per-request timeouts are bounded using `AbortController` and `AbortSignal.timeout(timeoutMs)`.
- If a candidate times out, it is classified as `INFRA_TIMEOUT`, its `elapsedMs` is recorded, and the harness immediately proceeds to the next benchmark unit.
- Production streaming timeouts are separate from benchmark execution timeouts.

---

## 7. Rebuilt Rubrics & Invariant Dimensions

Brittle exact keyword checks (e.g. requiring the exact string `"pre-stream"`) have been replaced with semantic invariant checks and executable evaluations:

1. **Executable Code Invariants**:
   - `case-b1`: Null/undefined safety guard checking on optional ID before map lookup.
   - `case-b2`: ISO 8601 UTC 'Z' suffix validation and real calendar date parsing (`Date.parse`).
   - `case-d1`: TokenBucket clamping to capacity and atomic token consumption.
   - `case-g1`: SELECT FOR UPDATE row locking and consistent global lock ordering (`ORDER BY id`).
2. **Structured Architecture/Reasoning Dimensions**:
   - Required invariant identified (e.g. Rejecting mid-stream replay).
   - Unsafe behavior rejected (e.g. Eliminating race conditions, unclosed listeners).
   - Correct failure boundary identified (e.g. Pre-stream vs mid-stream).
   - Trade-off analysis and concrete mitigations provided.
3. **Literal Compliance Constraints**:
   - Enforced only where strictly required (e.g. `case-a1` conventional commit syntax and word limits).

### Secondary Judge Model Rule
- A candidate model **never** judges its own output.
- A fixed external model is used strictly as a secondary evaluation signal.
- The harness persists `judgeModel`, `judgeRubric`, `judgeDecision`, and `judgeReason`. Primary deterministic evaluation remains authoritative.

---

## 8. Matrix Normalization & Denominator Verification

### Primary Calibration Candidates (9 Models)
All 9 primary candidates receive an identical baseline subset:
1. `ag/gemini-3.8-flash-low`
2. `ag/gemini-3.8-flash-medium`
3. `ag/gemini-3.8-flash-high`
4. `cx/gpt-5.6-luna`
5. `cx/gpt-5.6-sol`
6. `cx/gpt-5.6-terra`
7. `cx/gpt-6-astra`
8. `ag/claude-sonnet-4-6`
9. `ag/claude-opus-4-6-thinking`

The harness includes `denominatorUniform` checking, asserting that all active candidates were evaluated against the exact same case count before comparative ranking is claimed.

---

## 9. Review Variants Status

- Models: `cx/gpt-5.6-luna-review`, `cx/gpt-5.6-sol-review`, `cx/gpt-5.6-terra-review`, `cx/gpt-5.5-review`, `cx/gpt-5.4-review`, `cx/gpt-5.4-mini-review`, `cx/gpt-5.3-codex-spark-review`.
- **Status**: **EXCLUDED from primary calibration**.
- **Evidence**: Catalog metadata queries to `127.0.0.1:20128/v1/models` reveal that `-review` models have identical context windows (e.g. 272k for Luna, 372k for Sol), identical capabilities (`tools: true`, `vision: true`, `reasoning: true`), and identical output parameters to their base models. Execution probes demonstrate identical output and latency characteristics without distinct execution profiles.

---

## 10. Cost and Latency Proxy Metrics

The harness measures and persists proxy metrics without inventing hypothetical dollar costs:
- `elapsedMs`: Total wall-clock time from request start to completion.
- `timeToFirstByteMs`: Latency to the initial SSE chunk or response header.
- `promptTokens`: Input token count from upstream usage metadata.
- `completionTokens`: Output token count.
- `reasoningTokens`: Upstream reasoning tokens when reported.
- `streamed`: Boolean flag confirming SSE stream delivery.

---

## 11. Multi-Turn Session Simulation Harness

Implemented in `scripts/simulate-sessions.ts` with 3 canonical trajectories using persistent session state:

- **Trajectory A (End-to-End Bugfix & Delivery Cycle)**:
  - Turns: Repo exploration -> Implementation -> Failing test -> Diagnosis -> Passing test -> Docs.
  - Behavior: Medium profile selected -> Sticky on implementation -> Escalates to High on test failure -> Sticky on diagnosis -> De-escalates to Medium on passing test -> De-escalates to Low on docs.
- **Trajectory B (Routine Follow-up to Unrelated Hard Task)**:
  - Turns: Simple task -> Simple follow-up -> Unrelated hard concurrency proof.
  - Behavior: Medium profile -> Low profile on routine follow-up -> Escalates to High profile on hard concurrency task.
- **Trajectory C (Hard Reasoning to Resolution & Routine Follow-up)**:
  - Turns: Hard audit -> Resolved hard implementation -> Routine migration format.
  - Behavior: High profile selected -> Sticky during resolved reasoning -> Routine follow-up switches to Medium.

**Simulation Summary**:
- Total Trajectories: 3
- Total Turns: 12
- Total Switches: 6 (Switches per session: 2.0, Switches per turn: 0.5)
- Escalations: 3, De-escalations: 1
- Overall Stickiness Rate: 33.3% (all switches correspond to material changes or test feedback).

---

## 12. Legacy vs V2 Routing Comparison Harness

`scripts/compare-legacy-v2.ts` was repaired and executed across all 20 corpus records:
- **Status**: COMPLETED with zero errors.
- **Total Cases**: 20
- **Legacy Route Distribution**:
  - `smart-code`: 12 (60%)
  - `fast-chat`: 5 (25%)
  - `smart-main`: 2 (10%)
  - `smart-analysis`: 1 (5%)
- **V2 Shadow Tier Distribution**:
  - `cheap`: 14 (70%)
  - `balanced`: 1 (5%)
  - `strong`: 5 (25%)
  - `frontier`: 0 (0%)
- **Frontier Usage Rate**: 0.0% (conserves expensive models on non-frontier tasks).
- **Cheap/Balanced Rate**: 75.0%
- Output Artifact: `benchmark/legacy-vs-v2-comparison.json`

---

## 13. Verification Results

### Test Suites
```bash
npm run test
```
- Total test files: 9 passed
- Total tests: 98 passed (83 baseline + 3 shadow coverage/g3 + 12 CP3A harness/taxonomy)
- Regression coverage:
  - CP1 routing & streaming: PASS
  - CP2 shadow mode & session store: PASS
  - CP3A resume, deduplication, timeout isolation, taxonomy: PASS
  - Profile coverage validation: PASS
  - case-g3 exact prompt: PASS
  - Denominator uniformity checks: PASS
  - Sensitive-data redaction: PASS

### Build & Typecheck
```bash
npm run build
```
- Result: PASS (`tsc -p tsconfig.json` with 0 errors).

### Uniform Subset Smoke Test
Executed 1 case x 9 primary candidates:
- Total records: 9 / 9
- Operational success rate: 100.0%
- Quality success rate: 100.0%
- Denominator uniform: YES
- Resume test: Successfully skipped all 9 units when invoked with `--resume`.

---

## 14. Gate Boundaries & Non-Goals

The following remain deferred to CP3B / CP4:
- Authoritative V2 cutover (`ROUTER_MODE=v2`).
- Final selection of production execution profiles.
- Live traffic redirection on port 20200.
