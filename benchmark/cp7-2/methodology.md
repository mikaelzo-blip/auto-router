# CP7.2 Sonnet Agentic Executor Validation Methodology

## 1. Executive Summary & Purpose

The objective of **CP7.2** is to determine whether **Claude Sonnet 4.6 via Antigravity (`ag/claude-sonnet-4-6`)** deserves a dedicated production role as **`AGENTIC_EXECUTOR`** for long-running repository and software-engineering work, evaluated against the strong baseline **Gemini 3.8 Flash High (`ag/gemini-3.8-flash-high`)**.

This is a focused specialist validation checkpoint. It is NOT:
- a general model benchmark
- an Architecture benchmark
- a PRD benchmark
- a Sol benchmark
- a production activation task

Production on port 20200 remains untouched (`ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto`). Claude Sonnet remains strictly a benchmark/challenger profile and is disabled in production.

---

## 2. Candidates & Evaluation Setting

| Role | Candidate Alias | Exact Model ID | Provider Gateway | Reasoning Setting |
|---|---|---|---|---|
| **Baseline** | `gemini_high` | `ag/gemini-3.8-flash-high` | Antigravity via 9Router | `reasoning_effort: "high"` |
| **Challenger** | `sonnet_4_6` | `ag/claude-sonnet-4-6` | Antigravity via 9Router | `reasoning_effort: "high"` |

Excluded from this benchmark: Sol, Astra, Luna Review, Terra, Gemini Medium, Gemini Low.

---

## 3. Strict Predefined Promotion Gate (Frozen Criteria)

Sonnet may be recommended as `AGENTIC_EXECUTOR` only if **ALL** of the following criteria are met:

1. **Criterion A (Completion Advantage)**: Sonnet completes at least 2 more tasks than Gemini across the 12-case corpus, OR achieves at least a 15 percentage-point higher completion rate if some cases become invalid.
2. **Criterion B (Hidden-Test Success)**: Sonnet hidden-test success rate is $\ge$ Gemini.
3. **Criterion C (Regression Safety)**: Sonnet introduces no more regressions than Gemini.
4. **Criterion D (Timeout Rate)**: Sonnet timeout rate $\le 10\%$.
5. **Criterion E (Tool Reliability)**: Sonnet tool/harness failure rate is not materially worse than Gemini.
6. **Criterion F (Iteration Efficiency)**: Sonnet does not require materially more model iterations than Gemini.
7. **Criterion G (Latency Boundedness)**: Sonnet median wall-clock latency is no worse than 1.5× Gemini unless the quality advantage is substantial.
8. **Criterion H (Task-Family Diversity)**: Sonnet wins across more than one type of agentic task.

Possible outcomes:
- `PROMOTE_TO_AGENTIC_EXECUTOR`
- `SPECIALIST_ONLY`
- `KEEP_DISABLED`
- `BENCHMARK_INCOMPLETE`

---

## 4. 12-Case Corpus Across 6 Task Families

The corpus contains exactly 12 realistic software-engineering tasks organized into 6 families (2 cases per family):

| Case ID | Family | Title | Task Focus |
|---|---|---|---|
| **A1** | Family A (Bug Diagnosis & Repair) | Localized Bug with Misleading Symptom | Sliding window rate limiter boundary calculation |
| **A2** | Family A (Bug Diagnosis & Repair) | Cross-Module Defect | Session lifecycle and token verification synchronization |
| **B1** | Family B (Multi-File Feature) | Wildcard Event Bus | Single- and multi-level wildcard topic subscriptions |
| **B2** | Family B (Multi-File Feature) | Feature with Validation & Failure Semantics | Payment processor ISO validation and idempotency keying |
| **C1** | Family C (Refactor Under Constraints) | Billing Calculator Strategy Decomposition | Decomposing monolithic calculations into strategies |
| **C2** | Family C (Refactor Under Constraints) | Extract Storage Abstraction | Extracting shared Key-Value store base class |
| **D1** | Family D (Failure Recovery) | Replace Bogus Cache Eviction Patch | Reversing broken map purge fix and implementing real LRU |
| **D2** | Family D (Failure Recovery) | Enterprise Resilient Retry Contract | Enforcing unretryable error fast-fail and backoff ceilings |
| **E1** | Family E (Data & Concurrency) | 3-Phase Safe Schema Migration | Zero-downtime NOT NULL column addition with backfill |
| **E2** | Family E (Data & Concurrency) | Concurrency & Anti-Double-Allocation | Race condition serialization and idempotency replay |
| **F1** | Family F (Repository Maintenance) | Local Dependency API Upgrade | Upgrading legacy callback client adapter to modern async client |
| **F2** | Family F (Repository Maintenance) | Pipeline Architecture Cleanup | Decoupling pipeline steps and structuring error aggregation |

---

## 5. Execution Environment & Sandboxing

1. **Deterministic Isolation**:
   - Each candidate run executes in a freshly initialized isolated worktree (`tmp/cp7-2-agentic/{caseId}-{candidate}`).
   - The base repository fixture is copied from `benchmark/cp7-2/fixtures/base/` and overlaid with `benchmark/cp7-2/fixtures/cases/{caseId}/`.
   - Candidates never inherit changes from prior runs.
2. **Immutable Test Boundaries**:
   - Write and patch tools are strictly restricted to `src/` and `migrations/`.
   - Tool execution attempts targeting `test/`, `test-hidden/`, `package.json`, or escaping the sandbox via directory traversal are rejected immediately.
3. **Execution Order Alternation**:
   - Alternating candidate execution order reduces provider/temporal bias:
     - A1: Gemini $\to$ Sonnet
     - A2: Sonnet $\to$ Gemini
     - B1: Gemini $\to$ Sonnet
     - B2: Sonnet $\to$ Gemini
     - C1: Gemini $\to$ Sonnet
     - C2: Sonnet $\to$ Gemini
     - D1: Gemini $\to$ Sonnet
     - D2: Sonnet $\to$ Gemini
     - E1: Gemini $\to$ Sonnet
     - E2: Sonnet $\to$ Gemini
     - F1: Gemini $\to$ Sonnet
     - F2: Sonnet $\to$ Gemini
4. **Timeouts & Iteration Budgets**:
   - Per-request HTTP timeout: 60 seconds
   - Total agentic session wall-clock timeout: 8 minutes (480,000 ms)
   - Max meaningful model iterations: 25 turns
5. **Tooling Available to Candidates**:
   - `read_file(path: string)`
   - `write_file(path: string, content: string)` (restricted to `src/`)
   - `patch_file(path: string, old_string: string, new_string: string)` (restricted to `src/`)
   - `list_files(dir?: string)`
   - `run_tests()` (executes the visible test suite for the current case)

---

## 6. Verification & Evaluation Protocol

1. **Visible Test Execution**:
   - After candidate signals completion or iteration budget ends, the visible public test suite (`node --import tsx --test <testFile>`) is executed.
2. **Hidden Test Execution**:
   - The authoritative hidden test file (`benchmark/cp7-2/fixtures/hidden/{hiddenTestFile}`) is copied into `test-hidden/hidden.test.ts` in the worktree and executed.
   - Hidden tests verify edge cases, boundary conditions, anti-cheating, and regression safety.
3. **Primary Success Definition**:
   A run passes if and only if:
   - Visible public tests pass ($exitCode = 0$)
   - Hidden acceptance tests pass ($exitCode = 0$)
   - No prohibited files were modified
   - No timeout or truncation occurred
4. **Persistence & Resume**:
   - Every completed run is written atomically as `benchmark/cp7-2/raw/{caseId}_{candidate}_attempt-{N}.json`.
   - `--resume` skips already-valid terminal attempts without rerunning expensive LLM calls.
