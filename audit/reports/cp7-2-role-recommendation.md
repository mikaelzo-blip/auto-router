# CP7.2 Role Recommendation: Claude Sonnet 4.6 as Dedicated AGENTIC_EXECUTOR

## 1. Executive Summary & Core Recommendation

Following the successful execution of the **CP7.2 Sonnet Agentic Executor Validation Checkpoint** on branch `hermes/autorouter-v2-cp7-2-sonnet-agentic`, this document formally recommends establishing a dedicated new execution profile:

- **Profile Identifier**: `agentic_executor`
- **Recommended Primary Model**: `ag/claude-sonnet-4-6` via Antigravity provider
- **Reasoning Policy**: `reasoning_effort: "high"`
- **Target Role Scope**: Long-running multi-file agentic engineering, complex architectural refactoring, failure recovery, schema migrations, and deep repository debugging.

The primary benchmark demonstrated that Claude Sonnet 4.6 achieved an **11 / 12 (91.7%)** completion rate across 6 distinct software-engineering task families (compared to **6 / 12 (50.0%)** for Gemini 3.8 Flash High), introducing **zero regressions**, experiencing **zero timeouts** (vs 50% timeouts on Gemini High), and achieving a **0.60x** wall-clock latency ratio (49.1s median vs 81.3s). It satisfied all 8 frozen Promotion Gates (**Criteria A through H**).

---

## 2. Model & Profile Specification

```json
{
  "profileId": "agentic_executor",
  "modelId": "ag/claude-sonnet-4-6",
  "provider": "antigravity",
  "profileClass": "specialist",
  "targetRole": "AGENTIC_EXECUTOR",
  "qualityTier": "strong",
  "reasoningEffort": "high",
  "timeoutSeconds": 300,
  "maxIterations": 25,
  "capabilities": [
    "multi_file_editing",
    "test_driven_diagnosis",
    "ast_refactoring",
    "concurrency_synchronization",
    "compensating_transactions",
    "safe_schema_migrations"
  ]
}
```

---

## 3. Trigger Conditions & Routing Invariants

### 3.1 Positive Activation Criteria (When to Route to Sonnet 4.6)
Traffic should route to `agentic_executor` **ONLY** when at least one of the following structural conditions is met:

1. **Multi-Step Agentic Workflows**: Requests originating from agent harnesses (e.g., Hermes, Claude Code, Codex, Antigravity) that provide tool loops (`read_file`, `write_file`, `patch_file`, `terminal`, `run_tests`) across multiple files.
2. **Failure Recovery & Bug Escalation**: Secondary or tertiary retry attempts following a failed test run or broken build where simple localized edits failed.
3. **Complex Architectural Tasks**:
   - Refactoring across $\ge 2$ modules under backward-compatibility constraints.
   - Concurrency, locking, mutex, or race-condition remediation.
   - Database schema migrations with backward-compatible phased rollouts.
   - Event-driven state machines and saga compensating workflows.
4. **Explicit Quality Floor Override**: When caller metadata sets `qualityFloor: "strong"` combined with `taskClass: "agentic_workflow"`.

### 3.2 Explicit Exclusions & Anti-Patterns (When NOT to Route to Sonnet 4.6)
To protect Antigravity quota and prevent unnecessary model overhead, Sonnet 4.6 **MUST NOT** be activated for:

1. **Simple / Single-File Edits**: Localized bug fixes, typo corrections, single-function implementations, or comments (use `gemini-flash-medium` or `gemini-flash-high`).
2. **Routine Code Generation**: Boilerplate generation, script authoring, simple HTML/CSS templates.
3. **Cheap / High-Volume Semantic Queries**: Embeddings, classification, summarize, sentiment, chat completions with no tool calls (use `gemini-flash-medium`).
4. **Specialist Security / Code Review**: Tasks requiring offline diff review or security auditing without tool execution (route to dedicated `-review` specialist profiles).
5. **Quota Conservation State**: When Claude pool usable capacity drops below 20%, routine agentic tasks must de-escalate to `gemini_high` to preserve reserve capacity for critical workflows.

---

## 4. Fallback Hierarchy & Resilience Architecture

If `ag/claude-sonnet-4-6` becomes unavailable, encounters HTTP 429 quota exhaustion, or fails pre-stream connection checks, the AutoRouter will fall back through the following resilient hierarchy:

```
[Agentic Task Triggered]
         │
         ▼
[1. Primary: ag/claude-sonnet-4-6]
         │ (Pre-stream 429, 5xx, or Quota < 10%)
         ▼
[2. Secondary: ag/gemini-3.8-flash-high]
         │ (Pre-stream 429, 5xx, or Quota < 10%)
         ▼
[3. Tertiary Resilience: custom/terra-flash]
         │ (All upstream pools degraded)
         ▼
[4. Fail-Open Safe Mode: Return structured upstream degradation error]
```

*Note on Stream Safety*: In accordance with AutoRouter Section 7 invariants, fallback is permitted **only prior to stream commitment or tool invocation**. Once the model emits partial output or executes a tool call, fallback is locked to prevent duplicate execution side effects.

---

## 5. Quota Impact & Multi-Account Mitigation

1. **Observed Burn Rate**:
   - Full 12-case benchmark + smoke + 2 stress cases consumed ~11.9% of the primary Claude account quota.
   - Average cost per solved agentic task: ~0.9% quota per full task resolution.
2. **Multi-Account Topologies**:
   - 9Router manages two distinct provider connections for Claude under Antigravity.
   - Both connections must be maintained in healthy status.
   - In accordance with CP6.5 findings, Priority Inversion ensures healthy accounts (Priority 1) serve traffic first, preserving reserve accounts (Priority 2) with Round Robin disabled.
3. **Quota Gates**:
   - Pre-dispatch gate: Usable pool capacity $\ge 20\%$ required to assign `agentic_executor`.
   - Cooldown isolation: 429 on Account 1 triggers localized cooldown without disabling Account 2.

---

## 6. Governed Next Steps: Shadow Deployment in CP7.3

**STRICT GOVERNANCE WARNING**: In accordance with CP7.2 constraints, no immediate cutover or production routing changes are authorized at this time.

- **Current Production Status**: Port 20200 remains in `ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto` running the baseline verified models with Sonnet strictly disabled.
- **Recommended CP7.3 Checkpoint**:
  1. Define `agentic_executor` profile in `src/shadow-profiles.ts`.
  2. Deploy in `ROUTER_MODE=shadow` on Canary Port 20202.
  3. Validate shadow routing decisions, switch rates, and telemetry on live agent workloads for $\ge 50$ real turns without mutating upstream traffic.
  4. Present CP7.3 Shadow Soak Audit to stakeholders prior to requesting production cutover authorization.
