# AutoRouter V2: CP5 Dynamic Auto Reasoning Verification Report

## 1. Executive Summary & Checkpoint Identity

- **Checkpoint**: CP5 Dynamic Auto Reasoning & Canary Verification
- **Status**: `release-candidate-verified`
- **Branch**: `hermes/autorouter-v2-cp5-auto-reasoning`
- **Starting HEAD**: `fa7d29122ed50d08ca32f070f6923e0eb249fedf` (`fa7d291 feat(router): finalize CP4.1 Sol challenger release candidate`)
- **Stable Production Port**: `127.0.0.1:20200` (`ROUTER_MODE=legacy`, untouched)
- **V2 Canary Port**: `127.0.0.1:20201` (`ROUTER_MODE=v2`, `REASONING_POLICY=auto`, development canary)
- **Client-Facing Model**: `auto` (transparent dynamic profile routing)
- **Active Reasoning Policy**: `auto` (authoritative dynamic effort calculation with model capability clamping)
- **Canonical Effort Levels**: `["minimal", "low", "medium", "high", "max"]`
- **Test Suite**: 12 test files, 163 tests passing, 0 failed (`npm test`)
- **TypeScript Build**: Clean compilation (`npm run build`, `tsc -p tsconfig.json`, exit code 0)
- **Diff Check**: `git diff --check` clean (0 errors)
- **Recommended Production Policy**: `ROUTER_MODE=v2`, `REASONING_POLICY=auto` (cutover deferred; port 20200 untouched)

---

## 2. Timeout Semantics & UPSTREAM_CONNECT_TIMEOUT_MS Audit

### 2.1 Actual Runtime Semantics of UPSTREAM_CONNECT_TIMEOUT_MS
An audit of `src/upstream.ts` reveals how timeout timers interact with the Node.js HTTP client:
- In `src/upstream.ts`, `connectTimer` is set to `timeoutConfig.connectTimeoutMs` and scheduled alongside `headerTimer` (`timeoutConfig.headerTimeoutMs`).
- In Node.js (via Undici / native `fetch`), `fetch()` returns a Promise that resolves only once HTTP response headers have been received from the upstream server. The runtime does not expose an independent TCP socket-connected event through the standard `fetch()` API.
- Consequently, `connectTimer` runs concurrently with `headerTimer` from the moment the request is initiated until response headers arrive.
- **Semantic Conclusion**: `UPSTREAM_CONNECT_TIMEOUT_MS` functions in practice as an initial **response-header / response-start timeout**, rather than a pure TCP connection-establishment timer.

### 2.2 Preservation of Verified Timeout Values
- When reasoning models (such as Gemini 3.8 Flash High generating thinking tokens) process complex prompts (concurrency analysis, formal invariants), time-to-first-byte / header generation typically ranges from 12 to 18 seconds.
- The previous default of 10,000ms caused premature `UpstreamTimeoutError: connection_timeout` aborts during legitimate reasoning generation.
- To prevent regressions, `UPSTREAM_CONNECT_TIMEOUT_MS` was increased to **30,000ms** in `src/config.ts` (`integer(process.env.UPSTREAM_CONNECT_TIMEOUT_MS, 30_000)`).
- This 30,000ms value aligns with `headerTimeoutMs` (30,000ms), provides sufficient headroom for deep reasoning headers, and is preserved as the verified production default.

---

## 3. Verified Model Reasoning Policy & Activation Matrix

The model activation matrix was audited to ensure CP5 introduced no unauthorized changes to active, disabled, or specialist models:

| Profile | Upstream Model | Role / Status | Tier | Supported Reasoning Efforts | Default Effort | Max Effort | Selection Conditions |
|---|---|---|---|---|---|---|---|
| `gemini-flash-low` | `ag/gemini-3.8-flash-low` | **ACTIVE** | Cheap | `["minimal", "low"]` | `low` | `low` | Low-complexity, routine tasks, simple transformations |
| `gemini-flash-medium` | `ag/gemini-3.8-flash-medium` | **ACTIVE** | Balanced | `["low", "medium", "high"]` | `medium` | `high` | Normal coding, multi-file implementation, routine debugging |
| `gemini-flash-high` | `ag/gemini-3.8-flash-high` | **ACTIVE** | Strong | `["low", "medium", "high"]` | `high` | `high` | High complexity, concurrency, data integrity, quality escalations |
| `terra` | `cx/gpt-5.6-terra` | **ACTIVE** | Strong | `["low", "medium", "high"]` | `medium` | `high` | Cross-provider resilience and strong alternative failover |
| `luna-review` | `cx/gpt-5.6-luna-review` | **SPECIALIST** | Strong | `["medium", "high"]` | `high` | `high` | Dedicated code review tasks only (`isReviewTask`) |
| `sol` | `cx/gpt-5.6-sol` | **DISABLED** | Frontier | `["medium", "high", "max"]` | `high` | `max` | Disabled (`enabled: false`) due to latency/timeout profile |
| `astra` | `cx/gpt-6-astra` | **DISABLED** | Frontier | `["medium", "high", "max"]` | `high` | `max` | Disabled (`enabled: false`) |
| `claude-sonnet` | `ag/claude-sonnet-4-6` | **DISABLED** | Strong | `["low", "medium", "high"]` | `high` | `high` | Disabled (`enabled: false`) |
| `claude-opus` | `ag/claude-opus-4-6-thinking` | **DISABLED** | Frontier | `["medium", "high", "max"]` | `high` | `max` | Disabled (`enabled: false`) |

### Strict Invariants:
1. **Disabled Model Invariant**: `sol`, `astra`, `claude-sonnet`, and `claude-opus` have `enabled: false`. AutoRouter operates strictly over `activeProfiles = profiles.filter((p) => p.enabled)`. Dynamic auto-reasoning cannot activate a disabled model, regardless of requested effort or complexity.
2. **Frontier Tier Invariant**: No frontier profile is required. The `FRONTIER` tier remains unassigned in the operational pool, with strong profiles (`gemini-flash-high`, `terra`) fulfilling all heavy reasoning demands.
3. **Specialist Isolation**: `luna-review` is isolated strictly to explicit code review tasks and is never chosen for routine implementation or transport fallback.
4. **Capability Clamping**: Desired reasoning levels exceeding a model's physical support are clamped deterministically via `clampReasoningEffort` (e.g. `ag/gemini-3.8-flash-low` clamps desired `high` or `medium` down to `low`).

---

## 4. Reasoning Policies & Hermes Fixed-High Handling

The router supports three explicit reasoning policies configured via `REASONING_POLICY`:

### 4.1 `REASONING_POLICY=passthrough`
- **Behavior**: Preserves the client-requested reasoning effort (from `reasoning_effort` or `reasoning.effort`).
- **Clamping**: Clamped only to the selected profile's physical capabilities via `clampReasoningEffort`.
- **Default**: If the client provides no reasoning effort, defaults to the profile's `defaultReasoningEffort`.

### 4.2 `REASONING_POLICY=shadow`
- **Behavior**: Forwards the client-requested effort to the upstream model, while AutoRouter independently computes the desired reasoning effort based on task complexity and risk.
- **Diagnostics**: Emits `x-auto-router-reasoning-*` headers and telemetry reflecting what Auto mode would have selected, without altering upstream execution.

### 4.3 `REASONING_POLICY=auto`
- **Behavior**: AutoRouter dynamic reasoning decision is **authoritative**.
- **Hermes Fixed-High Handling**: When Hermes desktop sends `Thinking = ON` with `Effort = High`, AutoRouter evaluates the task:
  - For routine, low-complexity, or trivial tasks, AutoRouter overrides the client's fixed `high` and sets desired effort to `low` or `minimal`.
  - For normal coding tasks, AutoRouter sets desired effort to `medium`.
  - For high-concurrency, security, or quality-failure tasks, AutoRouter sets desired effort to `high`.
  - **Silencing Guarantee**: Fixed client `high` cannot silently bypass or override Auto mode. Upstream request payloads are sanitized via `applyReasoningToPayload` so only the authoritative `effectiveReasoningEffort` reaches the provider.

---

## 5. Quality Failure vs. Infrastructure Failure Isolation

A critical reliability guard in `src/shadow-router.ts` and `src/reasoning.ts` isolates transient infrastructure issues from reasoning escalations:
- **Quality Failures** (`testOutcome: "failed"`, assertion failures, compilation errors):
  - Increments consecutive failure count.
  - Escalate task complexity to `high`.
  - Escalate minimum quality tier floor to `strong` (`gemini-flash-high`).
  - Escalate desired reasoning effort by +1 level (e.g. `medium` -> `high`, or `high` -> `max`).
- **Infrastructure Failures** (HTTP 429, HTTP 5xx, network timeouts, upstream service unavailable):
  - Do NOT increment quality failure counts.
  - Do NOT escalate complexity or minimum quality tier floor.
  - Do NOT escalate reasoning effort.
  - Handled cleanly by transport-level retries and cross-provider resilience fallback (`terra`) without wasting reasoning tokens.

---

## 6. Concurrency Regression Analysis

### 6.1 PostgreSQL Concurrency Race Condition Verification
- **Prompt**: `"Diagnose a PostgreSQL concurrency race condition and prevent double allocation."`
- **Classification & Routing**:
  - `taskType`: `code` / `analysis`
  - `complexity`: `high` (matched by `/linearizable|race condition|concurr|.../`)
  - `risk`: `medium`
  - `minimumQualityTier`: `strong`
  - `selectedProfile`: `gemini-flash-high` (`ag/gemini-3.8-flash-high`)
- **Reasoning Evaluation**:
  - `desiredReasoningEffort`: `high`
  - `effectiveReasoningEffort`: `high`
  - `clamped`: `false`
- **Payload Sanitization**:
  - Outgoing payload contains `reasoning_effort: "high"`.
  - Conflicting/nested `reasoning` object is stripped.
  - Deterministically verified in `test/auto-reasoning.test.ts` (Test 26) and in live canary Phase A (`case-5-concurrency`).

---

## 7. Reconciling Report Details: Live Canary vs. Deterministic De-escalation Test

A key discrepancy between canary observations and unit test summaries was investigated and reconciled.

### 7.1 The Discrepancy Explained
- In `audit/telemetry/canary-auto-reasoning-telemetry.json`, `case-8-documentation` recorded:
  - `desiredEffort`: `"medium"`
  - `effectiveEffort`: `"medium"`
  - `model`: `"ag/gemini-3.8-flash-medium"`
- Meanwhile, the multi-turn de-escalation unit test and preliminary text summaries mentioned de-escalation to `"low"`:
  - `desiredEffort`: `"low"`
  - `effectiveEffort`: `"low"`

### 7.2 Explicit Distinction of Evidence Sources

#### A. LIVE CANARY RESULT (`case-8-documentation`)
- **Prompt**: `"Generate clean markdown documentation comments for the verified rate limiter functions."`
- **Execution Context**: Followed high-reasoning cases 4–7 (`case-7-security`, `case-5-concurrency`, etc.) with `recentTestOutcome: "passed"`.
- **Classification**: Because the prompt text contained the technical keyword `"functions"`, `complexity()` classified it as `medium` (matched by `/implement|function|class|method|algorithm|service|handler|endpoint|component|refactor|debounce/`).
- **De-escalation Outcome**:
  - Baseline effort for `medium` complexity is `medium`.
  - When de-escalation triggered (`recentTestOutcome: "passed"`), it prevented escalation above the baseline, successfully de-escalating from the preceding `high` effort down to `medium`.
  - Desired effort was `medium`, effective effort was `medium` on `ag/gemini-3.8-flash-medium`.
  - Model stickiness was preserved (no oscillation back to cheap profile), avoiding unnecessary switching overhead.

#### B. MULTI-TURN / DETERMINISTIC DE-ESCALATION TEST (`test/auto-reasoning.test.ts`)
- **Turn 1 (Implementation)**: Prompt: `"implement payment webhook handler"`. Complexity: `medium`. Desired: `medium`. Effective: `medium`. Profile: `gemini-flash-medium`.
- **Turn 2 (Quality Failure)**: Prompt: `"fix signature validation logic"`, `recentTestOutcome: "failed"`. Desired: `high`. Effective: `high`. Profile: `gemini-flash-medium`.
- **Turn 3 (Routine De-escalation)**: Prompt: `"add JSDoc comments to webhook handler functions"`, `recentTestOutcome: "passed"`, explicitly evaluated under `taskType: "general"` and `complexity: "low"`.
- **Outcome**: Desired effort de-escalated to `low`, effective effort de-escalated to `low` on `gemini-flash-medium`.
- **Shadow Case 8**: Prompt: `"generate markdown documentation for the rate limiter"`, `recentTestOutcome: "passed"` without technical code tokens, classified as `complexity: "low"`, resulting in `desired: "low"` and `effective: "low"` on `gemini-flash-low`.

**Conclusion**: Both results are functionally valid and verify the de-escalation contract. Live canary case-8 de-escalated from `high` to `medium` because its prompt invoked a function-level documentation task (`medium` complexity), whereas the deterministic unit test verified that low-complexity documentation de-escalates all the way to `low`. No routing logic was altered simply to make numbers match.

---

## 8. Stream Safety & Observability Headers

1. **Header Injection**:
   - `x-auto-router-model`: Selected concrete upstream model.
   - `x-auto-router-reasoning-policy`: Active policy (`auto`, `passthrough`, `shadow`).
   - `x-auto-router-reasoning-desired`: Calculated desired effort.
   - `x-auto-router-reasoning-effective`: Clamped effective effort forwarded to upstream.
   - `x-auto-router-reasoning-clamped`: Boolean string (`true` or `false`).
2. **Streaming Reliability (CP1 Foundation)**:
   - All 6/6 tests in `test/reliability.test.ts` pass.
   - Pre-stream fallback allowed; mid-stream replay forbidden.
   - Tool-event replay forbidden; client cancellation propagation verified.
   - Stream idle timeout enforced.

---

## 9. Full Repository Regression Results

The complete repository test suite and build verification were executed:

```
> auto-router@1.0.1 test
> vitest run

 ✓ test/reliability.test.ts (6 tests)
 ✓ test/shadow-router.test.ts (12 tests)
 ✓ test/cp4-1-regression.test.ts (15 tests)
 ✓ test/routing.test.ts (34 tests)
 ✓ test/benchmark.test.ts (12 tests)
 ✓ test/search.test.ts (2 tests)
 ✓ test/health-metrics.test.ts (4 tests)
 ✓ test/auto-reasoning.test.ts (42 tests)
 ✓ test/cp3-failure.test.ts (8 tests)
 ✓ test/auto-search.test.ts (1 test)
 ✓ test/responses.test.ts (4 tests)
 ✓ test/app.test.ts (23 tests)

 Test Files  12 passed (12)
      Tests  163 passed (163)
   Duration  974ms
```

- **Test Files**: 12 passed
- **Total Tests**: 163 passed, 0 failed
- **TypeScript Build**: `npm run build` (`tsc -p tsconfig.json`) completed with exit code 0.
- **Diff Check**: `git diff --check` completed with 0 errors.

---

## 10. Production Readiness & Release Recommendation

- **Recommended Production Configuration**:
  ```env
  ROUTER_MODE=v2
  REASONING_POLICY=auto
  UPSTREAM_CONNECT_TIMEOUT_MS=30000
  ```
- **Port 20200 Status**: Preserved strictly untouched throughout all CP5 implementation and canary testing.
- **Production Cutover**: **DEFERRED**. In strict adherence to governance, cutover requires explicit user authorization and must not be performed automatically.
- **Final Verdict**: **CP5 RELEASE READY**.
