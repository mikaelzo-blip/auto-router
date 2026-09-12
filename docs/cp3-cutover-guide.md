# AutoRouter V2: CP3 Calibration, Execution Profiles & Canary Cutover Guide

## 1. Overview & Architecture

AutoRouter V2 introduces dynamic execution profile selection behind the stable client-facing model alias:
```
model: "auto"
```

Clients continue sending requests to `model: "auto"`. AutoRouter dynamically inspects the request intent, current-step requirements, complexity, risk, and session history to map requests to calibrated, concrete execution profiles.

Upstream transport, account rotation, and provider resilience remain the exclusive responsibility of 9Router (`127.0.0.1:20128`).

---

## 2. Routing Modes

AutoRouter supports three operational modes via the environment variable `ROUTER_MODE`:

| Mode | Behavior | Forwarded Model | Diagnostic Headers |
|---|---|---|---|
| `legacy` (default) | Standard production combo routing | `ar-fast`, `ar-code`, `ar-analysis`, `ar-research` | `x-auto-router-route` |
| `shadow` | Legacy serves traffic; V2 calculates routing in background | Legacy combo model | `x-auto-router-route`, shadow logged |
| `v2` | Calibrated execution profile is authoritative | Concrete profile model (e.g. `ag/gemini-3.8-flash-low`) | `x-auto-router-mode`, `x-auto-router-profile`, `x-auto-router-model`, `x-auto-router-tier`, `x-auto-router-switch-reason` |

**Safe Default**: If `ROUTER_MODE` is unset or unrecognized, AutoRouter defaults to `legacy`.

---

## 3. Calibrated Execution Profiles

Based on empirical benchmarking across the 20-case evaluation corpus (100 full evaluations and 45 subset evaluations):

| Role | Profile ID | Concrete Model | Reasoning Level | Quality Tier | Cost Class | Latency Class | Benchmark Pass Rate | Typical Use Cases |
|---|---|---|---|---|---|---|---|---|
| **CHEAP** | `gemini-flash-low` | `ag/gemini-3.8-flash-low` | `low` (0 reasoning tokens) | `cheap` | `very_low` | `fast` (~2,801ms) | 95.0% (19/20) | Fast text transformation, simple refactors, git commits, summaries |
| **BALANCED** | `gemini-flash-medium` | `ag/gemini-3.8-flash-medium` | `medium` (~1,000-2,000 reasoning tokens) | `balanced` | `low` | `fast` (~7,782ms) | 80.0% (16/20) | Normal code implementation, multi-file refactors, unit tests, rate limiters |
| **STRONG** | `gemini-flash-high` | `ag/gemini-3.8-flash-high` | `high` (deep reasoning) | `strong` | `medium` | `medium` (~9,669ms) | 80.0% (subset) | PostgreSQL concurrency, deadlock prevention, financial reconciliation |
| **RESILIENCE** | `terra` | `cx/gpt-5.6-terra` | standard | `strong` | `medium` | `medium` (~15,517ms) | 45.0% | Cross-provider resilience alternative for strong workloads |
| **FRONTIER** | `astra` | `cx/gpt-6-astra` | `high` | `frontier` | `very_high` | `slow` (~16,135ms) | 30.0% | Critical high-risk architecture, multi-turn escalation with generous timeouts |
| **SPECIALIST REVIEW** | `luna-review` | `cx/gpt-5.6-luna-review` | review | `strong` | `medium` | `medium` | - | Specialist code review (kept outside primary execution pool) |

---

## 4. Quality Floors & Policy Boundaries

Quality floors enforce minimum tier thresholds that cannot be lowered by economy policy:
- **Trivial / Low-Risk**: `cheap` eligible (e.g. `gemini-flash-low`)
- **Normal Coding / Implementation**: `balanced` minimum (e.g. `gemini-flash-medium`)
- **Complex Debugging / Multi-file Refactor**: `balanced` minimum, escalates to `strong` on failure
- **Concurrency / Data Integrity / Financial / Security**: `strong` minimum (e.g. `gemini-flash-high`)
- **Critical Unresolved High-Risk**: `frontier` eligible (strictly reserved, 0% on standard corpus)

---

## 5. Session Stickiness, Escalation & De-escalation

1. **Stickiness (Hysteresis)**:
   - A session maintains its active execution profile across multiple turns unless a material change occurs.
   - Material triggers: capability change, quality tier increase, task type change requiring different tools, or execution failure.
   - Marginal differences or slight wording shifts do not cause profile switching.
   - Bounded multi-turn sessions average ~2 switches per 6-turn task.

2. **Execution-Feedback Escalation**:
   - Escalates on observable task failure signals: repeated test failures, build errors, tool failures, or verification rejections.
   - Infrastructure errors (HTTP 429, gateway timeouts, connection resets) do NOT escalate quality tier; they trigger pre-stream transport fallback.

3. **De-escalation**:
   - Passing tests or positive verification resets failure counters.
   - Follow-up routine steps (e.g. documentation, comments) de-escalate back to `balanced` or `cheap` with anti-oscillation guards.

---

## 6. Pre-Stream Fallback & Stream Safety Invariants

1. **Pre-Stream Fallback**:
   - Before the first byte or chunk is transmitted to the client, if the primary profile model returns HTTP 429, 502, 504, or network timeout, AutoRouter automatically attempts ranked alternative profile models.
2. **Mid-Stream Safety (No Replay Invariant)**:
   - Once any client-visible output, SSE chunk, or tool call is emitted, NO cross-model replay is permitted under any condition.
   - Mid-stream network drops terminate cleanly with logged metrics.
3. **Client Cancellation**:
   - Client disconnection triggers an `AbortController` signal that cancels the upstream request immediately.

---

## 7. Canary Deployment & Verification

- **Stable Instance**: Runs on `127.0.0.1:20200` (`ROUTER_MODE=legacy`). Unmodified and untouched throughout CP3.
- **Canary Instance**: Runs on `127.0.0.1:20201` (`ROUTER_MODE=v2`).
- Both instances coexist safely on localhost without port or session collision.

---

## 8. Rollback Procedure

Rollback is **100% configuration-only** and requires NO git revert:

```bash
# To roll back canary to legacy behavior:
export ROUTER_MODE=legacy
# Restart the service
```

Stable production on port `20200` remains unaffected at all times.
