# CP7 — Model Challenger Role Recommendation & Routing Analysis

## 1. Overview & Policy Objective

Following the execution of the 48-run corrected CP7.1 benchmark matrix across Architecture (A1-A4), PRD (P1-P4), Hard Reasoning (R1-R4), and Agentic Coding (E1-E4), this document provides empirical role assignments for each evaluated candidate.

In accordance with CP7 governance:
- **No candidate roles are activated in production by this checkpoint.**
- Production AutoRouter (`http://127.0.0.1:20200`) remains strictly isolated on baseline routing policies (`ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto`).

---

## 2. Model Evidence & Role Decisions

### 1. GPT-5.6 Sol (`cx/gpt-5.6-sol`)
- **Empirical Findings**:
  - Timed out on 13 out of 16 benchmark cases (81.3% timeout rate).
  - 12 out of 12 qualitative tasks (Architecture, PRD, Hard Reasoning) failed to complete within the 180s timeout.
  - Succeeded in Agentic Refactoring (E4) in 56.9s, demonstrating strong code reasoning when interactive responses complete, but tool loop network instability caused timeouts in E1 and E2.
  - Median latency of 180,000 ms and average TTFB of 100,640 ms make it completely unviable for production routing.
- **Decision**: **KEEP_DISABLED**
  - Not eligible for promotion to Architect or Escalation.
  - Remains disabled across all routing pools.

### 2. Claude Sonnet 4.6 (`ag/claude-sonnet-4-6`)
- **Empirical Findings**:
  - Outperformed all models in Agentic Coding (E1-E4): 50% pass rate across public and secret hidden tests (passed E2 and E4).
  - Fastest tool loop convergence (average 10.25 iterations, vs 15 iterations for Gemini).
  - Cleanest code refactoring and correct implementation of complex distributed event busses.
  - In qualitative tasks, truncated at 3,000 tokens (75% truncation rate), though its pre-truncation drafting achieved high rubric scores.
  - Lowest TTFB in the benchmark (1,880 ms average).
- **Decision**: **PROMOTE_TO_AGENTIC_EXECUTOR (Candidate Recommendation; KEEP_DISABLED in Production)**
  - Qualified as a designated specialist executor for agentic coding and complex implementation tasks.
  - Requires cutover gating and prompt token adjustment (raising max_tokens or streaming handling) before any live traffic enablement.

### 3. Gemini High (`ag/gemini-3.8-flash-high`)
- **Empirical Findings**:
  - Flawless qualitative execution: 100% completion across all 12 Architecture, PRD, and Reasoning cases without a single timeout or truncation.
  - Highest rubric scores in Architecture (20/20 on all 4 cases, 100%) and PRD (95% average).
  - Strongest invariant compliance in Hard Reasoning (88.2% invariant satisfaction).
  - Succeeded in E4 agentic refactoring.
  - Highly dependable 100% HTTP 200 rate with 0% provider failure.
- **Decision**: **KEEP_STRONG_DEFAULT**
  - Retains its role as the primary, default strong model for architecture, complex system design, reasoning, and difficult queries.

---

## 3. Proposed Future Role Matrix (Pre-Activation Specification)

When future cutover checkpoints authorize candidate activation, the target routing matrix is designated as:

| Virtual Role | Recommended Target Model | Justification |
|---|---|---|
| **CHEAP** | `ar-fast` / `ag/gemini-3.8-flash-low` | Ultra-low latency, token conservation for trivial queries. |
| **BALANCED** | `ar-analysis` / `ag/gemini-3.8-flash-medium` | General analysis and everyday development tasks. |
| **STRONG** | `ag/gemini-3.8-flash-high` | Dominant generalist, 100% completion rate, 0 timeouts. |
| **ARCHITECT** | `ag/gemini-3.8-flash-high` | Won all 4 Architecture cases (100% 20/20 rubric dimensions). |
| **AGENTIC_EXECUTOR** | `ag/claude-sonnet-4-6` | Won Agentic track (50% hidden pass rate, fast tool loop). |
| **SPECIALIST_REVIEW** | `ag/claude-sonnet-4-6` | Strong bug identification and test decomposition skills. |
| **RESILIENCE / RESERVE**| Healthy Secondary Antigravity Connection | Automatic quota-aware failover pool. |

---

## 4. Production Isolation Sign-Off

- Production AutoRouter port `20200` was tested and confirmed operational with zero regressions.
- No production routing files (`src/routes/*`, `src/routing/*`, `src/app.ts`) were modified.
- All candidate models remain disabled in production configuration.
