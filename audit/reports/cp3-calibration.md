# AutoRouter V2: CP3 Calibration & Controlled Canary Cutover Report

## 1. Executive Summary & Verdict

- **Checkpoint**: CP3 CALIBRATION & CONTROLLED CUTOVER
- **Branch**: `hermes/autorouter-v2-cp3-calibration-cutover`
- **Starting Lineage HEAD**: `d9fc914b0ab882f21868f2ff7c9f29c6e40b0fac` (Corrected CP2 recovery HEAD)
- **CP1 Implementation Baseline**: `4f7a1d9017028ee317fb7118ca77c9f79c1075b2`
- **Status**: `canary-ready`
- **Final Verdict**: **V2 READY FOR CANARY** (on port `20201` only; port `20200` remains stable production).

---

## 2. Gate Verification & Authentication Audit

1. **Gate 0 Lineage**: Verified `d9fc914b0ab882f21868f2ff7c9f29c6e40b0fac` as true starting HEAD. Baseline tests passed (`8 files, 83 tests`). TypeScript build passed.
2. **Gate 1 Authenticated Canary**: Started V2 on port `20201` with secure local upstream (`127.0.0.1:20128/v1`). Minimal completion returned HTTP 200 with valid choices. Zero secrets logged or committed.
3. **Stable Port Isolation**: Port `20200` was verified healthy and remained completely untouched throughout CP3.

---

## 3. Candidate Model Benchmarking (Phases 1, 5, 6, 7)

### Full Corpus Benchmark (20 cases x 5 surviving candidates = 100 records)
Executed across 10 non-sensitive task categories (A through J).

| Model Candidate | Full Pass Rate | Timeouts (>20s) | Rubric Issues | Avg Latency | Prompt Tokens | Completion Tokens | Reasoning Tokens | Operational Cost Class |
|---|---|---|---|---|---|---|---|---|
| `ag/gemini-3.8-flash-low` | **95.0%** (19/20) | 0 | 1 | **2,801ms** | 41,876 | 27,461 | 123 | `very_low` |
| `ag/gemini-3.8-flash-medium` | **80.0%** (16/20) | 2 | 2 | **7,782ms** | 35,638 | 44,009 | 22,210 | `low` |
| `cx/gpt-5.6-luna` | **45.0%** (9/20) | 9 | 2 | **12,819ms** | 28,186 | 3,169 | 0 | `medium` |
| `cx/gpt-5.6-terra` | **45.0%** (9/20) | 9 | 2 | **15,517ms** | 28,415 | 5,476 | 0 | `medium` |
| `cx/gpt-6-astra` | **30.0%** (6/20) | 13 | 1 | **16,135ms** | 17,974 | 1,479 | 0 | `very_high` |

### Subset Benchmark (5 representative cases x 9 candidates = 45 records)
| Candidate | Pass Rate | Avg Latency | Notes |
|---|---|---|---|
| `ag/gemini-3.8-flash-low` | 100% (5/5) | 1,921ms | Zero timeouts, fast execution |
| `ag/gemini-3.8-flash-medium` | 100% (5/5) | 3,859ms | Balanced reasoning tokens |
| `ag/gemini-3.8-flash-high` | 80% (4/5) | 9,669ms | 1 timeout on simple code, strong on concurrency |
| `cx/gpt-5.6-luna` | 100% (5/5) | 11,577ms | High quality, slower response |
| `cx/gpt-5.6-terra` | 100% (5/5) | 12,154ms | High quality, slower response |
| `cx/gpt-5.6-sol` | 80% (4/5) | 14,538ms | 1 timeout |
| `cx/gpt-6-astra` | 80% (4/5) | 15,962ms | 1 timeout |
| `ag/claude-opus-4-6-thinking` | 60% (3/5) | 1,519ms | Fast, 2 rubric issues on PostgreSQL / analysis |
| `ag/claude-sonnet-4-6` | 40% (2/5) | 1,501ms | Fast, 3 rubric issues |

### Empirical Findings:
1. **Name Rank Fallacy Disproven**: Astra does not outperform Terra or Sol; in fact, Astra exhibited a 65% timeout rate under 20s operational limits due to massive chain-of-thought latency.
2. **Gemini Dominance on Routine & Balanced Tasks**: `gemini-3.8-flash-low` and `medium` achieved 95% and 80% completion with ultra-fast latency (2.8s and 7.7s).
3. **Review Variants**: `*-review` variants in 9Router inventory represent specialist reviewer model quotas, not general execution engines. Kept outside primary candidate pool.

---

## 4. Curated Execution Profiles (Phases 8 & 9)

| Role | Profile ID | Concrete Model | Quality Tier | Cost Class | Latency Class | Selected Rationale |
|---|---|---|---|---|---|---|
| **CHEAP** | `gemini-flash-low` | `ag/gemini-3.8-flash-low` | `cheap` | `very_low` | `fast` | 95% pass rate, 0 timeouts, 2.8s avg latency |
| **BALANCED** | `gemini-flash-medium` | `ag/gemini-3.8-flash-medium` | `balanced` | `low` | `fast` | 80% pass rate, 7.7s avg latency, strong coding |
| **STRONG** | `gemini-flash-high` | `ag/gemini-3.8-flash-high` | `strong` | `medium` | `medium` | Concurrency, deadlock, financial logic |
| **RESILIENCE** | `terra` | `cx/gpt-5.6-terra` | `strong` | `medium` | `medium` | Cross-provider resilience alternative |
| **FRONTIER** | `astra` | `cx/gpt-6-astra` | `frontier` | `very_high` | `slow` | Reserved strictly for critical high-risk work |
| **SPECIALIST** | `luna-review` | `cx/gpt-5.6-luna-review` | `strong` | `medium` | `medium` | Specialist review mode |

---

## 5. Quality Floors, Stickiness & Session Feedback (Phases 10–13)

- **Quality Floors**:
  - Low-risk / trivial: `cheap` floor
  - Normal coding: `balanced` minimum
  - Difficult debugging: `balanced` minimum (escalates to `strong` on test failure)
  - Concurrency / Security / Ledger: `strong` minimum
  - Critical unresolved high-risk: `frontier` eligible
- **Session Stickiness (Hysteresis)**:
  - Multi-turn synthetic Hermes trajectories demonstrated **2.0 switches per session** across a 6-turn task.
  - Profile switching requires material changes (task-type change, capability requirement, quality floor increase, or repeated test failure).
  - No per-turn oscillation between cheap and balanced.
- **Escalation & De-escalation**:
  - Consecutive test/build failures escalate tier (`cheap` -> `balanced` -> `strong`).
  - Infrastructure errors (HTTP 429, timeouts) do NOT escalate quality tier; they trigger pre-stream transport fallback.
  - Passing verification permits controlled de-escalation back to balanced.

---

## 6. Legacy vs V2 Comparison (Phase 14 & Gate 2)

Evaluated across the complete 20-case corpus:
- **V2 Tier Distribution**: 14 Cheap (70%), 1 Balanced (5%), 5 Strong (25%), 0 Frontier (0%)
- **Frontier Usage Rate**: **0.0%** on standard corpus (properly reserved).
- **Cheap / Balanced Rate**: **75.0%** of all workloads handled by cost-effective profiles.
- **Latency Advantage**: Routine work completes in 2.8s (V2 Cheap) vs 5-10s (Legacy combo).
- **Gate 2 Decision**: **PASS**. V2 provides a measurable, defensible improvement in latency, cost efficiency, and failure resilience over static legacy combos.

---

## 7. Router Modes & Safe Execution (Phases 15–18)

- **Modes**: `ROUTER_MODE=legacy` (default), `shadow`, `v2`.
- **Pre-Stream Fallback**: If primary profile returns 429, 502, or connection error before first byte, alternative candidate profile is attempted immediately.
- **Mid-Stream Safety Invariant**: Once first byte / SSE chunk / tool call is sent, NO cross-model replay is allowed. Preserves CP1 invariants.
- **Failure Suite**: 8 explicit tests in `test/cp3-failure.test.ts` verified 100% passing.

---

## 8. Canary Verification & Rollback (Phases 17 & 21)

- **Canary Port 20201**: Started in `ROUTER_MODE=v2`.
  - Health check: HTTP 200 OK.
  - Authenticated completion: HTTP 200 OK via `ag/gemini-3.8-flash-low`.
  - Streaming completion: HTTP 200 text/event-stream with `x-auto-router-mode: v2`.
  - Client cancellation & stream safety verified.
- **Stable Port 20200**: Kept untouched on `ROUTER_MODE=legacy`.
- **Rollback**: 100% configuration-only via `ROUTER_MODE=legacy`. Zero git revert needed.
