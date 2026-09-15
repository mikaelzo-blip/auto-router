# CP7.3 Sonnet Agentic Shadow Routing Validation Report

## 1. Executive Summary

This report documents the verification, benchmark results, and operational safety of the **CP7.3 Sonnet Agentic Shadow Routing Validation Checkpoint** on branch `hermes/autorouter-v2-cp7-3-sonnet-shadow`.

Following the decisive benchmark results in CP7.2 demonstrating Claude Sonnet 4.6's superiority on complex agentic coding tasks (91.7% task completion vs Gemini 3.8 Flash High's 50.0%), CP7.3 implements and validates **non-intrusive shadow evaluation** for the candidate profile `sonnet-agentic` (`ag/claude-sonnet-4-6`).

### Key Invariants & Results:
- **Production Forwarding Isolation**: Actual production routing on port `20200` remains authoritative on Gemini profiles (`ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto`). Under no circumstances is traffic forwarded to Sonnet. Sonnet execution is strictly disabled (`enabled: false`, `enabledForExecution: false`).
- **Deterministic Agentic Classifier**: Built on positive action signals (multi-file implementation, repo-wide changes, approved plan execution, large refactors, migration implementations, test-fix loops, repo repair) and strict negative exclusions (architecture design, PRD creation, explanations, code review, typos, simple coding snippets, brainstorming, general reasoning, documentation).
- **Corpus Accuracy**: Evaluated across 48 frozen test cases in `benchmark/cp7-3/agentic-routing-corpus.json`:
  - **16 True Agentic Cases**: 16 correctly identified (**100% sensitivity**, 0 false negatives).
  - **32 Non-Agentic Cases**: 32 correctly identified (**100% specificity**, 0 false positives).
  - **False Positive Rate**: **0.00%**.
  - **False Negative Rate**: **0.00%**.
- **Multi-Turn Stability**: Tested 4-turn trajectory (Turn 1: Architecture Design $\rightarrow$ Gemini High; Turn 2: Approved Migration Execution $\rightarrow$ Sonnet Shadow; Turn 3: Test Failure Diagnosis $\rightarrow$ Sonnet Sticky Shadow; Turn 4: Summary of Changes $\rightarrow$ De-escalate to Gemini Medium). No model flapping or sticky lock-in.
- **Quota Integration**: Reuses existing Antigravity multi-account quota monitoring. When Claude quota is in reserve, exhausted, or unavailable, Sonnet recommendations are automatically suppressed. Zero Claude quota was consumed by shadow routing.
- **50-Request Shadow Soak**: Representative workload generated a 20.0% Sonnet recommendation rate (10 of 50 requests) with 0 false positive candidates, 0 questionable hits, and 100% correct agentic matches.
- **Regression Testing**: All 24 test suites (**423 unit and integration tests**) passed green with clean TypeScript compilation.

**Final Recommendation**: **`READY_FOR_SONNET_CANARY`**.

---

## 2. Production Health & Shadow-Only Invariant Enforcement

Production operation on port `20200` was monitored throughout CP7.3:
- Endpoint `http://127.0.0.1:20200/health`: Status `200 OK`, `{"status":"ok","service":"auto-router"}`.
- Active Configuration: `ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto`.
- Zero production code was mutated to enable authoritative Sonnet routing.

### Shadow Invariant Guarantees
1. In `src/shadow-profiles.ts`, `sonnet-agentic` is declared as:
   ```typescript
   {
     id: "sonnet-agentic",
     model: "ag/claude-sonnet-4-6",
     enabled: false,
     enabledForShadow: true,
     enabledForExecution: false,
     profileClass: "specialist",
     role: "AGENTIC_EXECUTOR",
     ...
   }
   ```
2. In `src/app.ts`, runtime dispatch uses `selectionCandidates` which filters strictly on `profile.enabled`. Consequently, `sonnet-agentic` cannot be selected as an active execution target.
3. Tests in `test/agentic-shadow-app.test.ts` assert that neither `/debug/route` nor `/v1/chat/completions` alters `selectedProfile` or forwards `ag/claude-sonnet-4-6` to upstream providers.

---

## 3. Deterministic Agentic Classification Signals

Rather than relying on prompt length or token count, agentic intent detection evaluates specific, verifiable structural signals in the user's latest message:

### Positive Deterministic Signals
- `multi_file_implementation`: Multi-file modifications across several source files (`multi-file`, `across several files`).
- `repo_wide_change`: Changes that span repository boundaries (`across the repository`, `codebase-wide`).
- `approved_plan_execution`: Explicit implementation of an approved architectural design or RFC (`implement approved plan`, `execute approved design`).
- `large_refactor_execution`: Structural refactoring across modules (`refactor multiple modules`, `extract base store`).
- `migration_implementation`: Executing multi-step schema or data migrations (`implement schema migration`, `migration implementation`).
- `test_fix_loop`: Test-driven repair loops (`fix failing tests`, `test-fix-test`, `run tests until green`).
- `implementation_with_verification`: Comprehensive diagnosis, repair, and test verification (`diagnose repo`, `update implementation and verify all tests`).
- `cross_module_bug_fix`: Tracing and resolving defects across distinct subsystem modules.

---

## 4. False-Positive Gate Verification & Negative Exclusions

Critical negative filters prevent Sonnet from being recommended for analytical, planning, or routine tasks:

| Gate | Description | Verified Behavior |
|---|---|---|
| **Architecture Design** | Prompts asking for architecture design, ADRs, or system blueprints | Excluded (`architecture_design_only`) $\rightarrow$ Routes to Gemini High |
| **PRD Creation** | Prompts asking for PRDs, product requirements, or specifications | Excluded (`prd_creation`) $\rightarrow$ Routes to Gemini High |
| **Explanation & Concepts** | Questions asking "how does", "explain why", race conditions | Excluded (`explanation`) $\rightarrow$ Preserves Gemini |
| **Code Review & Audits** | Requests to critique, audit, or review PR diffs or repos | Excluded (`code_review_only`) $\rightarrow$ Preserves Luna-Review |
| **Small Isolated Edits** | Typo fixes, README changes, single variable renames | Excluded (`small_isolated_edit`) $\rightarrow$ Routes to Gemini Low |
| **Simple Code Snippets** | Regex generation, sorting algorithms, one-line functions | Excluded (`simple_code_question`) $\rightarrow$ Routes to Gemini Medium |
| **Tool Availability** | Tools advertised in request payload without agentic prompt | Excluded $\rightarrow$ Does NOT trigger agentic recommendation |
| **Long Analytical Prompts** | Lengthy analytical questions without implementation requests | Excluded $\rightarrow$ Does NOT trigger agentic recommendation |

---

## 5. Plan vs Execute & Dominant Intent Handling

AutoRouter distinguishes between pure planning, pure execution, and mixed prompts:
1. **Pure Planning**: "Design a safe 3-phase schema migration architecture for user accounts."
   - Intent: `planning`
   - Exclusions: `architecture_design_only`
   - Shadow Recommendation: `wouldUseSonnet: false` (Gemini High preserved).
2. **Mixed Planning**: "Review this repo, choose the safest design, and write an implementation plan for my review. Do not write code yet."
   - Intent: `mixed_planning`
   - Exclusions: `prd_creation`
   - Shadow Recommendation: `wouldUseSonnet: false` (Gemini High preserved).
3. **Mixed Execution**: "Review this repo, choose the safest design, then implement it across the codebase and verify all tests pass."
   - Intent: `mixed_execution`
   - Signals: `repo_wide_change`, `implementation_with_verification`
   - Shadow Recommendation: `wouldUseSonnet: true` (Sonnet shadow candidate).
4. **Pure Execution**: "The plan is approved. Implement the migration across the repository and run tests until passing."
   - Intent: `execution`
   - Signals: `migration_implementation`, `repo_wide_change`
   - Shadow Recommendation: `wouldUseSonnet: true` (Sonnet shadow candidate).

---

## 6. Multi-Turn Trajectory, Stickiness & De-escalation

A stateful session store tracks session history with bounded capacity and a 120-second TTL. The 4-turn trajectory was validated:

- **Turn 1 (Architecture Design)**:
  - User: "Design a safe 3-phase schema migration architecture for user accounts."
  - Actual: `gemini-flash-high`
  - Shadow: `gemini-flash-high` (`wouldUseSonnet: false`)
- **Turn 2 (Approved Plan Execution)**:
  - User: "The plan is approved. Implement the migration across the repository and run tests until passing."
  - Actual: `gemini-flash-high`
  - Shadow: `sonnet-agentic` (`wouldUseSonnet: true`, `reason: migration_implementation_repo_wide_change`)
- **Turn 3 (Sticky Test Failure Loop)**:
  - User: "Tests failed with Assertion error in test/migrator.test.ts line 45. Fix it and rerun tests."
  - Context: `recentTestOutcome: "failed"`
  - Actual: `gemini-flash-high`
  - Shadow: `sonnet-agentic` (`wouldUseSonnet: true`, `reason: agentic_loop_stickiness_recovery`)
- **Turn 4 (De-escalation)**:
  - User: "Tests pass. Summarize what changed across the repository."
  - Context: `recentTestOutcome: "passed"`
  - Actual: `gemini-flash-medium`
  - Shadow: `gemini-flash-medium` (`wouldUseSonnet: false`, `reason: de_escalation_after_verification`)

No unprovoked model flapping occurred; stickiness safely maintained Sonnet during debugging and cleanly de-escalated upon passing tests.

---

## 7. Quota Awareness & Antigravity Claude Quota Integration

AutoRouter integrates with the 9Router usage endpoint to extract Claude quota metrics (`claude_short` and `claude_weekly`).
- **Healthy Quota (> 30%)**: Claude quota is healthy (currently 100% on short-term window, 69.1% on weekly window). Sonnet shadow recommendation is permitted.
- **Reserve Quota (< 10%)**: If Claude quota drops into reserve, Sonnet recommendation is suppressed (`shadowAgenticReason: claude_quota_reserve`).
- **Exhausted Quota (0%)**: Suppresses Sonnet recommendation (`shadowAgenticReason: claude_quota_exhausted`).
- **Provider Unavailable**: Suppresses Sonnet recommendation.
- **Account Selection Separation**: AutoRouter chooses profile and model alias; downstream 9Router selects the specific Antigravity OAuth connection.

---

## 8. CP7.3 Routing Corpus Benchmark (48 Cases)

The frozen corpus `benchmark/cp7-3/agentic-routing-corpus.json` was evaluated via `scripts/evaluate-agentic-corpus.ts` and automated test `test/agentic-corpus.test.ts`:

```
=== CP7.3 AGENTIC ROUTING CORPUS EVALUATION ===
Total Cases: 48
TRUE_AGENTIC: 16
CORRECTLY_IDENTIFIED: 16
NON_AGENTIC: 32
FALSE_POSITIVES: 0
FALSE_NEGATIVES: 0
FALSE_POSITIVE_RATE: 0.00%
FALSE_NEGATIVE_RATE: 0.00%
ACCURACY_RATE: 100.00%
```

Every single case passed with zero misclassifications.

---

## 9. Representative 50-Request Shadow Soak Observation

A 50-request shadow soak (`scripts/run-cp7-3-shadow-soak.ts`) was executed against the live application router:
- **Workload Composition**:
  - 10 Routine transformation and utility requests
  - 10 Normal single-file coding requests
  - 10 Architecture and PRD design requests
  - 10 Code review and security audit requests
  - 10 Complex multi-file agentic execution requests
- **Results**:
  - Total Requests: **50**
  - Agentic Eligible: **10**
  - Would Use Sonnet: **10**
  - Would Use Sonnet Rate: **20.0%**
  - False Positive Candidates: **0**
  - False Negative Candidates: **0**
  - Actual Profile Distribution:
    - `gemini-flash-low`: 10 (20%)
    - `gemini-flash-medium`: 30 (60%)
    - `gemini-flash-high`: 7 (14%)
    - `luna-review`: 3 (6%)
  - Shadow Profile Distribution:
    - `gemini-flash-low`: 9 (18%)
    - `gemini-flash-medium`: 23 (46%)
    - `gemini-flash-high`: 5 (10%)
    - `luna-review`: 3 (6%)
    - `sonnet-agentic`: 10 (20%)
  - Recommended Model Transitions: **10**
  - Claude Quota Consumed: **0**

---

## 10. Review of Shadow Hits

All 10 hits where `wouldUseSonnet = true` were individually audited:
1. `SOAK_41` (Event Bus): Multi-file feature $\rightarrow$ **CORRECT_AGENTIC_MATCH**
2. `SOAK_42` (Migration): Approved schema migration $\rightarrow$ **CORRECT_AGENTIC_MATCH**
3. `SOAK_43` (Architecture Exec): Approved architecture implementation $\rightarrow$ **CORRECT_AGENTIC_MATCH**
4. `SOAK_44` (Test-Fix Loop): Repository diagnosis and repair $\rightarrow$ **CORRECT_AGENTIC_MATCH**
5. `SOAK_45` (Refactor): Cross-module abstraction extraction $\rightarrow$ **CORRECT_AGENTIC_MATCH**
6. `SOAK_46` (Repo Repair): Build failure diagnosis and fix $\rightarrow$ **CORRECT_AGENTIC_MATCH**
7. `SOAK_47` (Cross-Module Defect): Authentication/session/middleware defect $\rightarrow$ **CORRECT_AGENTIC_MATCH**
8. `SOAK_48` (Worker Replacement): Approved plan execution across files $\rightarrow$ **CORRECT_AGENTIC_MATCH**
9. `SOAK_49` (OAuth PKCE): Multi-file implementation $\rightarrow$ **CORRECT_AGENTIC_MATCH**
10. `SOAK_50` (Saga Compensation): Multi-module transactional verification $\rightarrow$ **CORRECT_AGENTIC_MATCH**

- **Correct Agentic Matches**: 10 (100%)
- **Questionable Matches**: 0 (0%)
- **False Positives**: 0 (0%)

---

## 11. Preservation of Existing Execution Roles

Existing production roles remain intact:
- `gemini-flash-low` $\rightarrow$ **CHEAP** (routine tasks, utility scripts, typos).
- `gemini-flash-medium` $\rightarrow$ **BALANCED** (standard single-file coding, general tasks).
- `gemini-flash-high` $\rightarrow$ **STRONG / ARCHITECT / PRD / HARD REASONING** (system design, ADRs, PRDs, high-risk concurrency).
- `luna-review` $\rightarrow$ **SPECIALIST REVIEW** (code reviews, security audits).
- `terra` $\rightarrow$ **RESILIENCE** (cross-provider resilience fallback).
- `sol` $\rightarrow$ **DISABLED**.
- `astra` $\rightarrow$ **DISABLED**.
- `sonnet-agentic` $\rightarrow$ **SHADOW AGENTIC EXECUTOR ONLY** (not enabled for execution).

---

## 12. Independent Review Findings

An independent architectural and safety review evaluated the CP7.3 changes:
- **High Severity**: 0
- **Medium Severity**: 0
- **Low Severity**: 0
- **Informational**: 1
  - *INFO-1*: In future CP8 canary cutover, verify upstream streaming response headers before promoting `sonnet-agentic` to active execution.

---

## 13. Test Suite & Build Verification

- Vitest Suite: **24 test files, 423 tests passed** (0 failures).
- TypeScript Compiler: `tsc -p tsconfig.json` $\rightarrow$ Exit Code **0** (clean).
- Git Diff Check: `git diff --check` $\rightarrow$ Exit Code **0** (clean).

---

## 14. Final Recommendation & Next Steps

All 20 acceptance criteria and safety gates for CP7.3 have passed without defect.

**Verdict**: **`READY_FOR_SONNET_CANARY`**.

Sonnet agentic routing is ready for controlled canary observation on an isolated test port in CP8, under explicit operator authorization. In accordance with safety policies, authoritative Sonnet forwarding in production remains strictly disabled.
