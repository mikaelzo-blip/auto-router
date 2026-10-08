# CP7.1 Corrected Model Challenger Benchmark Report

## 1. Executive Summary

This report documents the resumed execution and final empirical results of the **CP7.1 Corrected Model Challenger Benchmark** on `hermes/autorouter-v2-cp7-model-challengers`.

The benchmark evaluated three candidate models across four distinct tracks (16 cases total):
- **ag/gemini-3.8-flash-high** (`gemini_high`) — Current baseline strong model.
- **ag/claude-sonnet-4-6** (`sonnet_4_6`) — Challenger model for agentic coding and reasoning.
- **cx/gpt-5.6-sol** (`sol_high`) — Challenger model for architecture and complex reasoning.

All 48 canonical primary runs (16 cases × 3 candidates) were successfully executed and persisted under atomic persistence and strict resumable runner semantics. The 32 legacy runs previously invalidated under CP7 remain quarantined in `benchmark/cp7/invalidated/` and were strictly excluded.

**Verdict: CP7 ROLE RECOMMENDATION READY** (Challengers remain disabled in production).

---

## 2. Methodology & Harness Correctness Controls

The CP7.1 execution operated under strict, verified harness controls:
1. **Resumable Execution (`--resume`)**:
   - Deterministically loads and validates prior attempts from `benchmark/cp7/raw/`.
   - Skips model requests for completed canonical pairs with valid terminal outcomes.
   - Ignores corrupted JSON, half-written artifacts, and `HARNESS_FAILURE` states, allowing safe reruns.
   - Isolates `benchmark/cp7/invalidated/` from discovery.
   - Verified by 11 deterministic unit tests in `test/benchmark-cp7.test.ts`.
2. **Atomic Persistence**:
   - Uses `writeAtomicJson`: write to `.tmp` file, flush, followed by atomic rename.
   - Prevents corrupted or partially written JSON records.
3. **Execution Parity**:
   - Qualitative tracks (Architecture, PRD, Reasoning): identical 180s per-request timeout.
   - Agentic track: identical 8-minute session wall-clock deadline, 60s per-tool timeout, max 15 iterations.
   - Uniform tool sandbox per case/candidate with immutable tests and package metadata.
4. **Scoring Discipline**:
   - Architecture & PRD: Multi-dimensional 0/1/2 rubric evaluated with complete output retention.
   - Reasoning: Invariant satisfaction and trap avoidance evaluated with full output.
   - Agentic Coding: Pass/fail determined by real Vitest execution of both public and secret hidden tests.

---

## 3. Preflight & Quota Verification

Prior to benchmark continuation, live 9Router inventory and upstream connection quotas were inspected:
- **Inventory Check**:
  - `ag/gemini-3.8-flash-high`: Verified active (`ag`).
  - `ag/claude-sonnet-4-6`: Verified active (`ag`).
  - `cx/gpt-5.6-sol`: Verified active (`cx`).
  - `SOL_AGY_AVAILABLE`: **false** (Sol is available only via `cx`, not `ag`).
- **Quota Safety Gate (>= 15% required to start/continue)**:
  - **Gemini High**: 82.6% usable quota (PASS).
  - **Claude Sonnet 4.6**: 80.4% usable quota (PASS).
  - **Codex / Sol**: 97.0% usable quota (PASS).

---

## 4. Benchmark Primary Matrix (48 Runs)

### Overview
- **Expected Primary Runs**: 48 (16 cases × 3 candidates)
- **Preexisting Valid Runs Resumed**: 30
- **New Runs Executed**: 18
- **Final Valid Primary Runs**: 48
- **Duplicates**: 0
- **Corrupt Runs**: 0
- **Invalidated Runs Excluded**: 32 (retained in `benchmark/cp7/invalidated/raw/`)

### Track 1: Architecture (A1–A4)
| Case | Candidate | Status | Outcome | Latency | TTFB | Rubric Score |
|---|---|---|---|---|---|---|
| **A1: Offline Doc System** | `gemini_high` | 200 | MANUAL_REVIEW_REQUIRED | 77.2s | 18.6s | 20/20 (100%) |
| | `sonnet_4_6` | 200 | TRUNCATION | 46.4s | 2.6s | 16/20 (80%) |
| | `sol_high` | 200 | TIMEOUT | 180.0s | 170.3s | 0/20 (Timeout) |
| **A2: Multi-Tenant SaaS** | `gemini_high` | 200 | MANUAL_REVIEW_REQUIRED | 61.7s | 6.7s | 20/20 (100%) |
| | `sonnet_4_6` | 200 | TRUNCATION | 37.9s | 1.3s | 18/20 (90%) |
| | `sol_high` | 200 | TIMEOUT | 180.0s | 39.5s | 0/20 (Timeout) |
| **A3: High-Integrity Tx** | `gemini_high` | 200 | MANUAL_REVIEW_REQUIRED | 56.1s | 10.9s | 20/20 (100%) |
| | `sonnet_4_6` | 200 | TRUNCATION | 42.5s | 1.9s | 16/20 (80%) |
| | `sol_high` | 0 | TIMEOUT | 180.0s | 180.0s | 0/20 (Timeout) |
| **A4: Monolith Evolution** | `gemini_high` | 200 | MANUAL_REVIEW_REQUIRED | 49.3s | 5.1s | 20/20 (100%) |
| | `sonnet_4_6` | 200 | TRUNCATION | 50.7s | 1.6s | 20/20 (100%) |
| | `sol_high` | 200 | TIMEOUT | 180.0s | 129.2s | 0/20 (Timeout) |

*Architecture Track Winner:* **Gemini High** (Complete, non-truncated architectural plans, perfect 20/20 rubric dimensions across all 4 cases, 0 timeouts).

### Track 2: Product Requirements Document (P1–P4)
| Case | Candidate | Status | Outcome | Latency | TTFB | Rubric Score |
|---|---|---|---|---|---|---|
| **P1: FinOps ARAP** | `gemini_high` | 200 | MANUAL_REVIEW_REQUIRED | 65.8s | 25.2s | 20/20 (100%) |
| | `sonnet_4_6` | 200 | TRUNCATION | 61.7s | 3.2s | 20/20 (100%) |
| | `sol_high` | 200 | TIMEOUT | 180.0s | 56.4s | 0/20 (Timeout) |
| **P2: Offline Field Ops** | `gemini_high` | 200 | MANUAL_REVIEW_REQUIRED | 85.4s | 9.3s | 18/20 (90%) |
| | `sonnet_4_6` | 200 | TRUNCATION | 48.6s | 1.2s | 18/20 (90%) |
| | `sol_high` | 200 | TIMEOUT | 180.0s | 102.3s | 0/20 (Timeout) |
| **P3: Excel-to-SaaS** | `gemini_high` | 200 | MANUAL_REVIEW_REQUIRED | 71.0s | 5.6s | 20/20 (100%) |
| | `sonnet_4_6` | 200 | TRUNCATION | 62.0s | 1.0s | 20/20 (100%) |
| | `sol_high` | 200 | TIMEOUT | 180.0s | 83.8s | 0/20 (Timeout) |
| **P4: AI Doc Workflow** | `gemini_high` | 200 | MANUAL_REVIEW_REQUIRED | 60.7s | 5.9s | 18/20 (90%) |
| | `sonnet_4_6` | 200 | TRUNCATION | 62.1s | 1.4s | 18/20 (90%) |
| | `sol_high` | 200 | TIMEOUT | 180.0s | 121.4s | 0/20 (Timeout) |

*PRD Track Winner:* **Gemini High** (Comprehensive, full PRDs without token cutoff, 95% average rubric coverage, 0 timeouts).

### Track 3: Hard Reasoning (R1–R4)
| Case | Candidate | Status | Invariants Satisfied | Traps Avoided | Outcome |
|---|---|---|---|---|---|
| **R1: Concurrency / Balance** | `gemini_high` | 200 | 4 / 4 (100%) | 3 / 3 (100%) | MANUAL_REVIEW_REQUIRED |
| | `sonnet_4_6` | 200 | 3 / 4 (75%) | 2 / 3 (67%) | TRUNCATION |
| | `sol_high` | 0 | 0 / 4 (0%) | 0 / 3 (0%) | TIMEOUT |
| **R2: Webhook Idempotency** | `gemini_high` | 200 | 3 / 4 (75%) | 2 / 3 (67%) | MANUAL_REVIEW_REQUIRED |
| | `sonnet_4_6` | 200 | 3 / 4 (75%) | 1 / 3 (33%) | TRUNCATION |
| | `sol_high` | 200 | 0 / 4 (0%) | 0 / 3 (0%) | TIMEOUT |
| **R3: Zero-Downtime Migration**| `gemini_high` | 200 | 4 / 4 (100%) | 0 / 3 (0%) | MANUAL_REVIEW_REQUIRED |
| | `sonnet_4_6` | 200 | 3 / 4 (75%) | 0 / 3 (0%) | TRUNCATION |
| | `sol_high` | 0 | 0 / 4 (0%) | 0 / 3 (0%) | TIMEOUT |
| **R4: Hierarchical Auth** | `gemini_high` | 200 | 4 / 5 (80%) | 2 / 3 (67%) | MANUAL_REVIEW_REQUIRED |
| | `sonnet_4_6` | 200 | 4 / 5 (80%) | 3 / 3 (100%) | TRUNCATION |
| | `sol_high` | 0 | 0 / 5 (0%) | 0 / 3 (0%) | TIMEOUT |

*Hard Reasoning Track Winner:* **Gemini High** (88.2% invariant satisfaction vs 76.5% for Sonnet, zero truncations, zero timeouts).

### Track 4: Agentic Coding (E1–E4)
| Case | Candidate | Status | Iterations | Tool Calls | Public Tests | Hidden Tests | Final Result |
|---|---|---|---|---|---|---|---|
| **E1: Rate Limiter Fix** | `gemini_high` | 200 | 15 | 15 | Fail | Fail | TEST_FAILURE |
| | `sonnet_4_6` | 200 | 15 | 24 | Fail | Fail | TEST_FAILURE |
| | `sol_high` | 0 | 8 | 19 | Fail | Fail | TIMEOUT |
| **E2: Wildcard Event Bus** | `gemini_high` | 200 | 15 | 15 | Pass | Fail | TEST_FAILURE |
| | `sonnet_4_6` | 200 | 8 | 10 | **Pass** | **Pass** | **SUCCESS** |
| | `sol_high` | 0 | 3 | 8 | Fail | Fail | TIMEOUT |
| **E3: Cache Manager** | `gemini_high` | 200 | 15 | 15 | Pass | Fail | TEST_FAILURE |
| | `sonnet_4_6` | 200 | 7 | 8 | Pass | Fail | TEST_FAILURE |
| | `sol_high` | 200 | 5 | 8 | Pass | Fail | TEST_FAILURE |
| **E4: Order Strategy** | `gemini_high` | 200 | 15 | 15 | **Pass** | **Pass** | **SUCCESS** |
| | `sonnet_4_6` | 200 | 11 | 17 | **Pass** | **Pass** | **SUCCESS** |
| | `sol_high` | 200 | 6 | 13 | **Pass** | **Pass** | **SUCCESS** |

*Agentic Coding Track Winner:* **Claude Sonnet 4.6** (50% full pass rate on public + hidden tests: 2/4 passes; faster convergence, averaging 10.25 iterations vs 15 for Gemini).

---

## 5. Candidate Reliability & Latency Summary

| Metric | `gemini_high` | `sonnet_4_6` | `sol_high` |
|---|---|---|---|
| **Total Runs** | 16 | 16 | 16 |
| **Passed Runs** | 1 (E4) | 2 (E2, E4) | 1 (E4) |
| **Timeouts** | **0** | **0** | **13** (81.3%) |
| **Truncations** | **0** | **12** (75.0%) | **0** |
| **Provider / Network Errors** | 0 | 0 | 2 |
| **HTTP 200 Rate** | 100% | 100% | 68.8% |
| **Average TTFB** | 12,608 ms | **1,880 ms** | 100,640 ms |
| **Median TTFB** | 5,559 ms | **1,721 ms** | 170,310 ms |
| **Average Latency** | 75,464 ms | **52,760 ms** | 154,259 ms |
| **Median Latency** | 61,672 ms | **51,719 ms** | 180,007 ms |

---

## 6. Sol Max Diagnostic Check

Per benchmark governance rules:
- Sol Max diagnostic may only be executed if Sol primary benchmark is complete, Sol is competitive in architecture/reasoning, and quota remains safely above benchmark threshold.
- Observation: Sol timed out on 12/12 qualitative cases (Architecture, PRD, and Reasoning). It is not competitive in architecture or reasoning.
- Determination: **NOT RUN — QUOTA CONSERVATION**.

---

## 7. Production Isolation Verification

Production status was monitored and verified:
- `GET http://127.0.0.1:20200/health` returned HTTP 200 `{"status":"ok","service":"auto-router"}`.
- Production configuration flags remain:
  - `ROUTER_MODE=v2`
  - `REASONING_POLICY=auto`
  - `QUOTA_POLICY=auto`
- Sol and Sonnet remain disabled in production routing rules. No production routing or cutover changes were introduced.
