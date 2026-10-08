# CP7 Model Challenger Benchmark Methodology

## 1. Executive Purpose & Scope

This benchmark is an evidence-backed evaluation to determine whether:
1. **GPT-5.6 Sol** deserves a dedicated **ARCHITECT / DECISION-MAKING / HEAVY-REASONING** role.
2. **Claude Sonnet 4.6** deserves a dedicated **AGENTIC EXECUTOR / SOFTWARE-ENGINEERING** role.
3. **Gemini 3.8 Flash High** should remain the default **STRONG** model.

**Governance Boundary**:
- This is a **CHALLENGER BENCHMARK**, NOT a production model activation checkpoint.
- Production AutoRouter on port `20200` remains strictly untouched (`ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto`).
- Round Robin remains disabled (`false`) and upstream account priorities remain untouched.
- No challenger receives live production traffic.

---

## 2. Model Inventory & Provider Discovery

Live structured inspection of 9Router (`http://127.0.0.1:20128/v1/models` and `/api/providers`) established the factual concrete model identities:

1. **Baseline**: `ag/gemini-3.8-flash-high`
   - Upstream model: `gemini-3.8-flash`
   - Provider: Antigravity (`ag`)
   - Reasoning format: `gemini-level`

2. **Challenger B**: `ag/claude-sonnet-4-6`
   - Upstream model: `claude-sonnet-4-6`
   - Provider: Antigravity (`ag`)
   - Reasoning format: `claude-adaptive`

3. **Challenger A**: `cx/gpt-5.6-sol`
   - Upstream model: `gpt-5.6-sol`
   - Provider: Codex (`cx`)
   - Reasoning format: `openai`

### Sol Provider-Path Rule & Quota Preflight
- **Antigravity Sol Discovery**: No Sol model exists under Antigravity (`ag/gpt-5.6-sol` = `NOT FOUND`). Therefore:
  `SOL_AGY_AVAILABLE = false`.
- **Codex Quota Inspection**: The only available Sol model is hosted on Codex (`cx/gpt-5.6-sol`).
  - Session quota: `100 / 100` (100% remaining).
  - Weekly quota: `6 / 100` remaining (`6.0%` remaining ratio, `94` used, reset at `2026-09-19T08:39:48.000Z`).
- **Benchmark Safety Gate**: The safety rule mandates not starting a full candidate run below 15% usable quota, and stopping if usable quota falls below 10%. With weekly quota at 6.0% and reset 5 days away:
  - Verdict: `SOL_FULL_BENCHMARK_BLOCKED_BY_PROVIDER_QUOTA`.
  - Non-scored warm-up inference was successfully verified for Sol (HTTP 200, TTFB 4045ms, latency 4341ms).
  - Full multi-case benchmark execution is blocked for Sol to preserve critical reserve quota.
  - Primary head-to-head benchmark proceeds for **Gemini 3.8 Flash High** vs **Claude Sonnet 4.6**, both of which have healthy quota (>77% and 100% on Priority 1 account).

---

## 3. Four Benchmark Tracks & 16 Synthetic Cases

The benchmark corpus consists of 16 synthetic, non-sensitive cases across four tracks:

### Track A: Architecture Cases (A1–A4)
Evaluated across 10 anchored dimensions (0 = absent/incorrect, 1 = partial/materially weak, 2 = correct/sufficient):
- **A1**: Offline / Delayed-Processing Document Architecture
- **A2**: Multi-Tenant SaaS Architecture with Audit & Background Jobs
- **A3**: High-Integrity Transaction Architecture (Double-Spend / Concurrency)
- **A4**: Evolution & Migration Architecture (Monolith to Modular/Event-Driven)

### Track B: PRD Cases (P1–P4)
Evaluated across 10 anchored dimensions (0/1/2):
- **P1**: Financial Operations SaaS Requirements Decomposition
- **P2**: Offline-Capable Field Operations App Product Brief
- **P3**: Spreadsheet-to-SaaS Migration Product Specification
- **P4**: AI-Assisted Document Workflow Product Requirements

### Track C: Hard Reasoning Cases (R1–R4)
Evaluated strictly on deterministic invariant satisfaction, known trap avoidance, and decision correctness:
- **R1**: PostgreSQL Concurrency & Balance Reservation Invariants
- **R2**: Distributed Idempotency & Webhook Retry Correctness
- **R3**: Zero-Downtime Database Migration & Phased Rollback Invariants
- **R4**: Hierarchical Authorization & Privilege Escalation Boundary Analysis

### Track D: Agentic Software Engineering Cases (E1–E4)
Evaluated inside isolated worktree copies of a deterministic fixture repository:
- **E1**: Rate Limiter Window Boundary Bug Fix & Regression Test
- **E2**: Multi-File Wildcard Event Bus Subscription Feature Implementation
- **E3**: Cache Manager Eviction Failure Recovery
- **E4**: Order Service Multi-File Strategy Refactoring Under Constraints

Primary Agentic Metrics:
- Public unit tests passing
- Hidden acceptance tests passing
- Model iterations / tool calls
- Unnecessary file edits / regressions
- Wall clock duration & TTFB

---

## 4. Evaluation Discipline & Parity Rules

1. **Parity**:
   - Candidates receive identical prompt instructions, identical tool schemas (`read_file`, `write_file`, `patch_file`, `run_tests`, `list_files`), identical iteration budgets (max 15 iterations), a 180-second qualitative-call deadline, a 60-second agentic model-call deadline, and one 8-minute agentic-session wall-clock deadline.
   - Each candidate runs in a freshly initialized isolated worktree copy (`tmp/cp7-agentic/{caseId}-{candidate}`). Tool paths are validated with `path.relative`; operations escaping that worktree are rejected. Model writes and patches are restricted to `src/`; package metadata, public tests, and hidden tests are immutable.
   - Execution order is rotated across cases to prevent time-order and provider bias.
2. **Scoring and Evidence**:
   - Rubrics and invariants are committed before candidate runs begin.
   - Every qualitative response is persisted in full in its UTF-8 raw-attempt artifact with a SHA-256 hash; the raw result records the evaluator version and exact output hash.
   - Qualitative results are provisional unless all mandatory case invariants are independently verified; no role conclusion may be derived from mere keyword coverage or a partial anchored score.
   - Coding tasks are scored by public and hidden deterministic test exit codes, source-only diffs (tests and package metadata are immutable), and immutable final-worktree patch hashes.
3. **Attempts and Persistence**:
   - Every attempt is appended immediately as `benchmark/cp7/raw/{caseId}_{candidate}_attempt-{N}.json`; cached success is never reused as a substitute for a declared single attempt.
   - A manifest records all case/model/attempt combinations, output hashes, patch hashes, and evaluator version. `results.json` and `summary.json` are generated only from that manifest.

## 5. Prior Execution Invalidation

The initial CP7 execution artifacts under `benchmark/cp7/invalidated/` are retained for audit only. They are **not valid benchmark evidence** because their qualitative evaluator was permissive keyword scoring, full outputs and source/test diffs were not preserved, retry handling was asymmetric, and documented timeouts did not match the implemented semantics. No production-role promotion may rely on those artifacts. The current CP7 conclusion is `BENCHMARK_INCOMPLETE` pending a rerun under the corrected methodology and a fresh independent review.
