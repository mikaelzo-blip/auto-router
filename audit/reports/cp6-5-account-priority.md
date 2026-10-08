# Checkpoint CP6.5: Account Priority Validation & Quota Auto Cutover Readiness

## Executive Summary

Checkpoint **CP6.5** executes the final operational validation of 9Router upstream account priorities and evaluates readiness for enabling `QUOTA_POLICY=auto`. The evaluation establishes empirical observations across 9Router's structured local APIs, measures live account dispatch behavior under production shadow policy, executes a 50-request shadow soak, verifies multi-account pool semantics and Codex exhaustion handling, simulates scenarios A through F under auto policy, and evaluates the 10-point Auto Readiness Gate.

**Key Finding**: While software-level quota-aware pooling, review fallbacks, and canary auto functionality pass all invariants, **9Router retains `account_1` at Priority 1 and `account_2` at Priority 2**. Empirical measurement demonstrates that 9Router's native fill-first priority dispatch routes 100% of live traffic to the reserve account (`account_1`), continuing to consume its scarce remaining quota (~2.46%) while the healthy secondary account (`account_2`, 98.99% quota) remains completely idle (0 requests served).

In strict accordance with the Checkpoint Gate rules:
> *If account_1 continues being consumed materially: STOP. Do not recommend quota auto.*

**Final Recommendation: KEEP QUOTA_POLICY=shadow**. Do not enable production quota auto cutover until 9Router account priorities are inverted so that `account_2` serves Priority 1 and `account_1` is preserved at Priority 2.

---

## 1. Baseline Verification

- **Branch**: `hermes/autorouter-v2-cp6-quota-aware`
- **Starting HEAD**: `1992b08f94c5fbb6127a7ac3964b899bb6e55bc8`
- **Working Tree**: Clean (`git status --short` empty)
- **Unit Test Suite**: 18 test files, 304 tests passed (`vitest run`)
- **TypeScript Build**: `tsc -p tsconfig.json` exit code 0
- **Diff Check**: `git diff --check` clean (zero whitespace defects)
- **Production Port 20200**: Retained active on `QUOTA_POLICY=shadow`, `ROUTER_MODE=v2`, `REASONING_POLICY=auto` without disruption.

---

## 2. 9Router Priority Inspection

Structured local 9Router APIs (`GET http://127.0.0.1:20128/api/providers`) and SQLite diagnostics (`C:/Users/Fikri/AppData/Roaming/9router/db/data.sqlite`) were inspected using sanitized anonymized aliases only:

| Account Alias | Role | Configured Priority | Active | Test Status | Quota Ratio | Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **`account_1`** | Reserve | **1** | `true` | `active` | 0.02458 (2.46%) | `reserve` |
| **`account_2`** | Healthy | **2** | `true` | `active` | 0.98990 (98.99%) | `healthy` |
| **Round Robin** | - | **OFF** | - | - | - | Priority Fill-First |

- **Security & Identity Redaction Guarantee**: All raw connection IDs, email addresses, and OAuth credentials were strictly excluded from logs, telemetry, and artifacts.
- **Priority Change Status**: The manual priority swap has **not** taken effect in 9Router. `account_1` remains Priority 1; `account_2` remains Priority 2.

---

## 3. Live Account Selection & Dispatch Behavior

Five bounded safe Gemini completion requests were sent through the router to measure actual 9Router connection dispatch.

- **Observed Dispatch**:
  - `account_1` served: **5 / 5 requests (100.0%)**
  - `account_2` served: **0 / 5 requests (0.0%)**
- **Dispatch Pattern**: 9Router continues strict priority-based fill-first dispatch to Priority 1 (`account_1`). It does not divert routine requests to `account_2` while Priority 1 responds successfully.

---

## 4. Reserve Account Conservation Assessment

Normalized quota tracking via `GET /api/usage/[connectionId]` captured starting and ending quota levels across the request batch:

| Metric | `account_1` (Reserve) | `account_2` (Healthy) | Delta Assessment |
| :--- | :--- | :--- | :--- |
| **Starting Normalized Ratio** | 0.024585217 (2.4585%) | 0.989900000 (98.99%) | Baseline established |
| **Ending Normalized Ratio** | 0.024571016 (2.4571%) | 0.989900000 (98.99%) | `account_1` consumed: -0.0014% |
| **Serving Count Delta** | +5 requests | +0 requests | 100% load on reserve |
| **Conservation Outcome** | **VIOLATED** | **IDLE** | Reserve capacity burning |

**Gate Rule Check**: Because `account_1` continues being consumed materially while `account_2` serves zero traffic, the reserve conservation gate fails.

---

## 5. Multi-Account Gemini Pool Status

Live evaluation via `NineRouterQuotaSource` and `evaluateCandidateQuota`:

- **Pool Status**: `healthy`
- **Total Accounts**: 2
- **Usable Accounts**: 2
- **Constrained Accounts**: 1 (`account_1` in reserve at 2.46%)
- **Exhausted Accounts**: 0
- **Best Remaining Ratio**: 0.9899 (sourced from `account_2`)
- **Profile Eligibility**:
  - `gemini-flash-low`: `healthy` (eligible)
  - `gemini-flash-medium`: `healthy` (eligible)
  - `gemini-flash-high`: `healthy` (eligible)

---

## 6. Codex Pool Exhaustion & Preemptive Fallback

Live evaluation of Codex provider connection:

- **Codex Connection Status**: `unavailable` / `exhausted`
- **Usable Accounts**: 0 / 1
- **Candidate States**:
  - `terra`: `status: exhausted`, `limitingBuckets: ["codex_unavailable"]`
  - `luna-review`: `status: exhausted`, `limitingBuckets: ["codex_unavailable"]`
- **Preemptive Review Fallback**:
  - Standard Review Selection: `luna-review`
  - Quota-Aware Routing: Preemptively substitutes `gemini-flash-high`
  - Reason: `quota_exhausted`
  - Effect: `avoided_exhausted_luna-review`
  - Doomed Upstream Requests: **0** (no requests sent to Codex)

---

## 7. Production Shadow Soak (50 Requests)

A 50-request shadow soak was executed on isolated port 20205 (`PORT=20205`, `ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=shadow`) across 5 workload domains (10 routine, 10 coding, 10 hard concurrency, 10 high-risk financial, 10 review):

- **Requests Observed**: 50
- **Telemetry Errors**: 0
- **Telemetry Timeouts**: 0
- **Actual Profile Distribution**:
  - `gemini-flash-low`: 14
  - `gemini-flash-medium`: 18
  - `gemini-flash-high`: 9
  - `luna-review`: 9
- **Hypothetical Auto Profile Distribution**:
  - `gemini-flash-low`: 14
  - `gemini-flash-medium`: 24
  - `gemini-flash-high`: 12
- **Would-Switch Count**: 9 (Rate: 18.0%)
- **Switch Reason Breakdown**:
  - `quota_exhausted` (Codex `luna-review` -> `gemini-flash-medium`): 6
  - `quota_exhausted` (Codex `luna-review` -> `gemini-flash-high`): 3
  - `none`: 41
- **Gemini Divergence**: 0 switches away from Gemini. Because the Gemini pool is healthy, routine and coding traffic remain locked to Gemini.

---

## 8. Auto Policy Simulation (Scenarios A through F)

Simulations under `QUOTA_POLICY=auto` validated expected deterministic behavior across all topology scenarios:

| Scenario | Conditions | Expected Pool / Profile Outcome | Result |
| :--- | :--- | :--- | :---: |
| **A** | `account_1` reserve + `account_2` healthy | Gemini pool `healthy` (ratio 0.98) | **PASS** |
| **B** | `account_1` exhausted + `account_2` healthy | Gemini pool `healthy` (ratio 0.95) | **PASS** |
| **C** | `account_2` unavailable + `account_1` reserve | Gemini pool `reserve` (ratio 0.05) | **PASS** |
| **D** | Both Antigravity accounts exhausted | Gemini pool `exhausted` | **PASS** |
| **E** | Codex exhausted | `terra` and `luna-review` excluded | **PASS** |
| **F** | All general providers exhausted | Explicit `no_eligible_candidate` returned | **PASS** |
| **Guards** | Sol and Astra profiles | Strictly excluded / disabled (`enabled: false`) | **PASS** |

---

## 9. Non-Production Canary Auto Testing (Port 20206)

To test the software cutover path without risking production 20200, an isolated canary server was initialized on port 20206 with `ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto`:

- **`routine`**: Routed to `gemini-flash-low` (`ag/gemini-3.8-flash-low`) -> HTTP 200 OK.
- **`normal coding`**: Routed to `gemini-flash-medium` (`ag/gemini-3.8-flash-medium`) -> HTTP 200 OK.
- **`hard`**: Routed to `gemini-flash-high` (`ag/gemini-3.8-flash-high`) -> HTTP 200 OK.
- **`review`**: Standard selection `luna-review` preemptively substituted with `gemini-flash-high` (`ag/gemini-3.8-flash-high`) -> HTTP 200 OK (`switchReason: quota_exhausted`, `selectionEffect: avoided_exhausted_luna-review`).
- **Canary Teardown**: Canary listener was cleanly stopped via PowerShell `Stop-Process -Force`. Production port 20200 remained completely untouched.

---

## 10. Auto Readiness Gate Evaluation

| Gate Criterion | Verification Method | Status | Notes |
| :--- | :--- | :---: | :--- |
| **1. `account_2` actually serves requests** | Live 9Router completions & SQLite | **FAIL** | Served 0 requests (0%); all traffic went to `account_1` |
| **2. `account_1` reserve is conserved** | Normalized quota delta tracking | **FAIL** | Quota decreased from 2.4585% to 2.4571% |
| **3. Multi-account Gemini pool healthy** | Live snapshot evaluation | **PASS** | Evaluates to `healthy` (0.9899 best ratio, 2 usable) |
| **4. Codex exhaustion respected** | Quota policy & provider health | **PASS** | Terra and Luna-review marked `exhausted` |
| **5. No doomed Codex requests sent** | Preemptive fallback inspection | **PASS** | Substitutes `gemini-flash-high` upfront |
| **6. Shadow decisions stable** | 50-request soak metrics | **PASS** | 0 telemetry errors, 0 timeouts, 18.0% switch rate |
| **7. No specialist leakage** | Shadow & canary distributions | **PASS** | Luna-review restricted strictly to review tasks |
| **8. No quota/reasoning coupling** | Header & effort inspection | **PASS** | Reasoning effort dynamically decoupled from quota |
| **9. No identity leaks** | Sanitization audits | **PASS** | Zero tokens, emails, or raw IDs in telemetry/reports |
| **10. Tests and build pass** | Vitest & tsc verification | **PASS** | 19 test files, 310 tests pass, build clean |

---

## 11. Final Recommendation

```
==================================================
FINAL RECOMMENDATION:
KEEP QUOTA_POLICY=shadow
==================================================
```

### Justification
AutoRouter's internal quota policy and multi-account pool logic are fully validated and ready for auto mode. However, AutoRouter intentionally abstracts upstream accounts and relies on 9Router to perform connection-level dispatch. Because 9Router's configured priority currently places the reserve account (`account_1`) at Priority 1 and the healthy account (`account_2`) at Priority 2, fill-first routing continues burning scarce reserve quota.

**Required Action Before Cutover**:
1. In 9Router, update Antigravity connection priorities:
   - Set healthy `account_2` to **Priority 1**.
   - Set reserve `account_1` to **Priority 2**.
2. Keep Round Robin **OFF**.
3. Verify that new Gemini requests increment `account_2`'s serving count while `account_1` remains frozen.
4. Once `account_2` serving is verified, production cutover to `QUOTA_POLICY=auto` may proceed safely.
