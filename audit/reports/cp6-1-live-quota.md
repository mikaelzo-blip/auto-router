# AutoRouter V2 — CP6.1 Live Quota Mapping & Shadow Soak Report

## 1. Executive Summary

Checkpoint **CP6.1** successfully resolves the live Antigravity quota mapping issue, integrates real-time quota telemetry from local 9Router (`127.0.0.1:20128`), and completes an empirical shadow soak without modifying or impacting the production router instance (`127.0.0.1:20200`).

- **Branch**: `hermes/autorouter-v2-cp6-quota-aware`
- **CP6 Baseline HEAD**: `83a5e4d2bfb99a6c42953e5e408ec210041e17cb`
- **Test Suite**: 227 passed / 227 tests across 16 test files; `tsc -p tsconfig.json` build clean.
- **Auto Readiness Gate**: **`NOT_READY`** (Telemetry is verified and accurate, but candidate pool constraints make immediate `QUOTA_POLICY=auto` unsafe under current 9.2% Gemini reserve conditions).

---

## 2. Reproduction & Root Cause Analysis

### The Observed Failure
Under CP6 initial implementation, querying `/debug/quota` produced:
- `providerHealth: { antigravity: "degraded", codex: "healthy" }`
- `candidateStates.gemini-flash-low: { status: "unknown", effectiveRemainingRatio: 1.0, reason: "no_telemetry" }`

### Root Cause
1. **Timeout Mismatch**:
   - Upstream 9Router handles `GET /api/usage/[connectionId]` for Antigravity by making real external HTTPS requests to Google Cloud Code Assist (`loadCodeAssist` and `quotaSummaryApiUrl`).
   - Measured latency for this endpoint ranges between **1,092 ms and 1,774 ms**.
   - AutoRouter's initial default `quotaSourceTimeoutMs` was hardcoded to `1000ms`.
   - Consequently, every call timed out with `AbortSignal.timeout(1000)`.
2. **Telemetry Drop & False Provider Degradation**:
   - The timeout exception was trapped in `NineRouterQuotaSource`'s generic `catch` block, setting `providerHealth.antigravity = "degraded"` and aborting before populating `buckets`.
   - Because no buckets were populated, `evaluateCandidateQuota` found zero applicable telemetry and failed open to `status: "unknown"` with `effectiveRemainingRatio: 1.0`.
3. **Provider Health vs Telemetry Separation**:
   - In reality, the Antigravity connection in 9Router was `healthy` (`testStatus: "active"`, `isActive: true`). Telemetry fetch latency was falsely marking the upstream model execution capability degraded.

---

## 3. 9Router Quota Tracker Architecture & Live Data Path

Analysis of 9Router's internal Next.js routes (`/app/.next-cli-build/server/app/api/usage/[connectionId]/route.js`) and UI components (`/dashboard/quota`) revealed the exact data contracts:

- **Endpoint**: `GET /api/usage/[connectionId]`
- **Discovery**: `GET /api/providers` (returns active connections filtered by `testStatus === "active" && isActive !== false`).
- **HTTP Method**: `GET`
- **Units**:
  - `used` / `total` counts (e.g., 908 / 1000)
  - `remainingPercentage` (0.0% to 100.0% float)
- **Reset Timestamps**: ISO 8601 UTC string (`2026-09-18T07:36:38.000Z`).
- **Quota Grouping**:
  - 9Router Quota Tracker aggregates all `gemini-*` (non-image) models under **"Gemini (Flash / Pro)"** (`modelKey: "gemini"`), computing the minimum remaining ratio.
  - In parallel, weekly budget is tracked under `gemini_weekly` ("Gemini (Weekly)").
  - Codex quotas are returned as `session` (e.g., 100/100) and `weekly` (e.g., 22/100).
- **Redaction Guarantee**: All account IDs, emails, and session tokens are strictly internal to 9Router connection IDs and are stripped from AutoRouter snapshots.

---

## 4. Normalization Fixes & Multi-Bucket Semantics

### Adapter Enhancements (`NineRouterQuotaSource`)
1. **Configurable Timeout & Polling**:
   - `QUOTA_SOURCE_TIMEOUT_MS` increased to default `5000ms`.
   - `QUOTA_REFRESH_TTL_MS` increased to default `30000ms`.
2. **Dual Gemini Buckets**:
   - `gemini_flash_pro`: Normalized minimum across all active Gemini models (`scope: "model_shared"`).
   - `gemini_weekly`: Normalized weekly budget (`scope: "weekly"`).
3. **Factual Verification of Shared Gemini Quota Pool**:
   - Live telemetry confirmed that `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, and `gemini-3.8-flash-high` all returned identical `used: 908, total: 1000, remainingRatio: ~0.0925, resetAt: 2026-09-18T07:36:38.000Z`.
   - All three profiles draw from the same Google Cloud Code Assist quota pool. All three candidate states now map to both `gemini_flash_pro` and `gemini_weekly`.
4. **Multi-Window Minimum Selection**:
   - Candidate evaluation inspects all applicable buckets and computes `minRatio = min(b.remainingRatio)`.
   - If `gemini_flash_pro` is 9.2% and `gemini_weekly` is 10.2%, effective remaining is **9.2%** (`reserve`), with limiting bucket `gemini_flash_pro` and resetAt preserved.

---

## 5. Live Shadow Validation: 5 Scenarios

A non-production CP6.1 instance was started on `127.0.0.1:20205` with `ROUTER_MODE=v2`, `REASONING_POLICY=auto`, and `QUOTA_POLICY=shadow`. Production instance (`127.0.0.1:20200`) remained untouched.

### Live Telemetry Snapshot
- `providerHealth`: `{ antigravity: "healthy", codex: "healthy" }`
- `gemini_flash_pro`: `used: 908, total: 1000, remaining: 92 (9.25%), resetAt: 2026-09-18T07:36:38.000Z`
- `gemini_weekly`: `used: 908, total: 1000, remaining: 92 (9.25%), resetAt: 2026-09-18T07:36:38.000Z`
- `codex_weekly`: `used: 78, total: 100, remaining: 22 (22.00%), resetAt: 2026-09-19T08:39:48.000Z`
- `codex_session`: `used: 0, total: 100, remaining: 100 (100.00%), resetAt: 2026-09-14T13:41:12.000Z`

### Scenario Evaluation Results

| Scenario | Actual Profile | Actual Model | Quota Status | Remaining Ratio | Limiting Buckets | Hypothetical Profile | Hypothetical Model | Would Switch? | Switch Reason | Selection Effect |
|---|---|---|---|---|---|---|---|---|---|---|
| **A. Routine Transformation** | `gemini-flash-low` | `ag/gemini-3.8-flash-low` | `reserve` | 9.25% | `gemini_flash_pro`, `gemini_weekly` | `terra` | `cx/gpt-5.6-terra` | **True** | `quota_reserve` | `conserved_reserve_gemini-flash-low` |
| **B. Normal Coding** | `gemini-flash-medium` | `ag/gemini-3.8-flash-medium` | `reserve` | 9.25% | `gemini_flash_pro`, `gemini_weekly` | `terra` | `cx/gpt-5.6-terra` | **True** | `quota_reserve` | `conserved_reserve_gemini-flash-medium` |
| **C. Hard Concurrency** | `gemini-flash-high` | `ag/gemini-3.8-flash-high` | `reserve` | 9.25% | `gemini_flash_pro`, `gemini_weekly` | `terra` | `cx/gpt-5.6-terra` | **True** | `quota_reserve` | `conserved_reserve_gemini-flash-high` |
| **D. High-Risk Financial** | `luna-review` | `cx/gpt-5.6-luna-review` | `conserve` | 22.00% | `codex_weekly` | `luna-review` | `cx/gpt-5.6-luna-review` | **False** | `none` | `preserved_for_strong_task` |
| **E. Code Review Task** | `luna-review` | `cx/gpt-5.6-luna-review` | `conserve` | 22.00% | `codex_weekly` | `luna-review` | `cx/gpt-5.6-luna-review` | **False** | `none` | `preserved_for_strong_task` |

---

## 6. Empirical Shadow Soak Telemetry

A 50-request bounded shadow soak was executed against the CP6.1 shadow instance (`scripts/shadow-soak-cp6-1.py`):

- **Total Requests**: 50
- **Successful Requests**: 50 (100.0%)
- **Failed Requests**: 0 (0.0%)
- **Duration**: 2.85 seconds
- **Hypothetical Switches**: 41 of 50 requests (82.0%)
- **Actual Selections Dispatched**:
  - `gemini-flash-medium`: 17 (34%)
  - `gemini-flash-low`: 14 (28%)
  - `gemini-flash-high`: 10 (20%)
  - `luna-review`: 9 (18%)
- **Hypothetical Quota-Aware Selections**:
  - `terra`: 41 (82%)
  - `luna-review`: 9 (18%)
- **Switch Reasons**:
  - `quota_reserve`: 41 (82%)
  - `none`: 9 (18%)
- **Limiting Buckets**:
  - `gemini_flash_pro`: 41
  - `gemini_weekly`: 41
  - `codex_weekly`: 9
- **Average Usable Ratio**: 11.54%
- **Cooldown Events**: 0
- **Stale Snapshot Occurrences**: 0
- **Telemetry Errors**: 0

*Verification*: In all 50 requests, the actual model and profile selected strictly matched standard V2 routing. Zero requests were altered or interrupted.

---

## 7. Threshold & Hysteresis Review

Configured thresholds:
- `healthyMin`: 0.30 (30%)
- `conserveMin`: 0.10 (10%)
- `reserveMin`: 0.00 (0%)
- `hysteresis`: 0.03 (3%)

**Evaluation**:
- With Gemini currently at **9.25%**, the ratio is strictly below `conserveMin = 0.10`.
- It reliably enters `reserve` status.
- Under hysteresis rules, exiting `reserve` back into `conserve` requires `ratio > 0.13` (13%).
- Unit test 16 and Acceptance Test 23 confirmed that a model at 11% previously in `reserve` remains in `reserve`. Flapping is mathematically prevented.
- **Verdict**: **`CONFIRMED_SOUND`**.

---

## 8. Polling Load Review

- **Measured Upstream Latency**:
  - Antigravity: `1,219ms`, `1,092ms`, `1,774ms` (average ~1,360ms)
  - Codex: `553ms`
- **Upstream Caching**:
  - 9Router caches weekly summary for 180 seconds, but per-model quotas hit Google Cloud Code Assist directly.
- **Interval Adjustment**:
  - Baseline polling interval: 20 seconds (180 requests/hour).
  - Recommended & configured interval: **30 seconds** (120 requests/hour).
  - This 33% reduction eliminates upstream 429 rate-limiting pressure while maintaining fresh telemetry well within interactive session time scales.

---

## 9. Auto Readiness Gate Assessment

### Readiness Verdict: **`NOT_READY`**

While telemetry ingestion and multi-bucket quota normalization are fully verified, enabling `QUOTA_POLICY=auto` today would create severe production risks due to candidate pool limitations:

1. **Severe Model Concentration (82% Diverted to Terra)**:
   - In the active pool, `gemini-flash-low`, `gemini-flash-medium`, and `gemini-flash-high` are all in `reserve` (~9.2%).
   - The only enabled non-Gemini alternative is `terra` (`cx/gpt-5.6-terra`), with `luna-review` restricted to specialist tasks.
   - `QUOTA_POLICY=auto` would immediately divert 82% of all traffic to `terra`.
2. **Cascading Codex Exhaustion**:
   - `terra` operates on the Codex provider (`codex_weekly`), which is currently at **22%** (`conserve`).
   - Flooding `terra` with 82% of all requests (including low-tier routine transformations) would exhaust Codex weekly quota within hours, leaving AutoRouter with **zero** available models.
3. **Inappropriate Routine Escalation**:
   - Routine cheap tasks (simple string formatting, CSV parsing) should not escalate to high-cost frontier-class models (`terra`) purely to conserve low-tier quota when no low-cost alternative exists.

### Actionable Blocking Prerequisites:
1. Calibrate and enable a low/balanced cost alternative (e.g., `sol` or `astra`) to absorb routine traffic.
2. Await the Gemini quota reset on `2026-09-18T07:36:38.000Z` to restore Google Cloud Code Assist pool health.
3. Implement a protective guardrail that blocks escalation of routine tasks to strong tier when alternate providers are below 30%.
