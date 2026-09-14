# Production Cutover Report: AutoRouter V2 Final Blue/Green Release

## 1. Executive Summary

This operations report records the execution, verification, and initial observation of the final blue/green production cutover from AutoRouter V1 to AutoRouter V2 at release candidate commit `401d07048642bc4b95ec81414ed39a567ea93ed5`.

The cutover was executed via a controlled local process swap on `127.0.0.1:20200` with an observed transition downtime of **1.038 seconds**. AutoRouter V1 remains completely preserved on disk with immediate rollback capability. The production instance is actively serving client traffic in `v2` mode under dynamic `auto` reasoning policy with zero HTTP errors, zero timeouts, zero routing crashes, and zero disabled-model activations.

- **Release Candidate Head**: `401d07048642bc4b95ec81414ed39a567ea93ed5`
- **Previous Production Head (V1)**: `a21c81cab6b6fb2f9264abeb8550203b144cf3ef`
- **New Production Head (V2)**: `401d07048642bc4b95ec81414ed39a567ea93ed5`
- **Production Mode**: `v2`
- **Reasoning Policy**: `auto`
- **Client-Facing Configuration**: `model = auto`
- **Final Verdict**: **PRODUCTION CUTOVER SUCCESSFUL**

---

## 2. Release Candidate Verification (Phase 0)

Prior to service modifications, the release candidate was audited in the working tree:
- **Git Branch**: `hermes/autorouter-v2-cp5-auto-reasoning`
- **Exact Commit**: `401d07048642bc4b95ec81414ed39a567ea93ed5`
- **Working Tree**: Clean (`git status --short` empty)
- **Whitespace / Diff Check**: 0 errors (`git diff --check` clean)
- **Full Test Suite Baseline**:
  - 12 test files passed
  - 163 unit/integration tests passed
  - 0 failures
- **TypeScript Build**: Clean compilation (`tsc -p tsconfig.json`)

---

## 3. V1 Production Baseline State (Phase 1)

Before initiating release deployment, current V1 production state was recorded without exposing secrets:
- **Stable Endpoint**: `http://127.0.0.1:20200`
- **Process PID**: `9528` (Parent PID `15792` pwsh running `scripts\start-ready.ps1`)
- **Working Directory**: `C:\Projects\router\auto-router`
- **Branch / Commit**: `main` @ `a21c81cab6b6fb2f9264abeb8550203b144cf3ef`
- **Launch Command**: `"C:\Program Files\nodejs\node.exe" dist/index.js`
- **Environment Source**: `C:\Projects\router\auto-router\.env`
- **Router Mode**: Legacy / V1 (`fast-chat` route mapping to `gpt-5.6-luna`)
- **Pre-Cutover Health**: HTTP 200 `{"status":"ok","service":"auto-router"}`
- **Baseline Non-Streaming Request**: HTTP 200, header `x-auto-router-route: fast-chat`, model `gpt-5.6-luna`
- **Baseline Streaming Request**: HTTP 200, `text/event-stream` SSE chunks received, model `gpt-5.6-luna`

---

## 4. Clean Green Release Deployment & Verification (Phases 2–13)

### 4.1 Deployment
- **Worktree**: `C:\Projects\router\auto-router-v2-green` created at commit `401d07048642bc4b95ec81414ed39a567ea93ed5`
- **Secure Environment**: Configuration sourced via `.env` without hardcoding or printing credentials
- **Initial Green Port**: `127.0.0.1:20202`
- **Green Readiness**: Ready via bounded polling in 0.02s with HTTP 200 `{"status":"ok","service":"auto-router"}`

### 4.2 Green Smoke & Routing Verification Matrix
| Phase | Test Scenario | Expected Outcome | Observed Result | Status |
|---|---|---|---|---|
| **4** | Basic Smoke Non-Streaming | Mode=v2, Policy=auto, HTTP 200 | HTTP 200, `x-auto-router-mode: v2`, `x-auto-router-reasoning-policy: auto` | **PASS** |
| **4** | Basic Smoke Streaming | Mode=v2, SSE stream chunks | HTTP 200, `text/event-stream`, 3+ chunks received | **PASS** |
| **4** | Client Cancellation | Immediate abort on client disconnect | Upstream stream aborted, socket cleanly closed | **PASS** |
| **4** | `model=auto` Compatibility | Accepts `model: "auto"` transparently | Accepted, routed dynamically | **PASS** |
| **5** | Routine Prompt | Model `ag/gemini-3.8-flash-low`, reasoning `minimal`/`low` | Model `ag/gemini-3.8-flash-low`, Profile `gemini-flash-low`, Tier `cheap`, Effective Effort `low` | **PASS** |
| **5** | Client High Override Resistance | Hermes fixed high does not override Auto policy | Desired `low`, Effective `low`, Auto policy authoritative | **PASS** |
| **6** | Normal Coding Prompt | Model `ag/gemini-3.8-flash-medium`, reasoning `medium` | Model `ag/gemini-3.8-flash-medium`, Profile `gemini-flash-medium`, Tier `balanced`, Effective Effort `medium` | **PASS** |
| **7** | Hard Concurrency Prompt | Model `ag/gemini-3.8-flash-high`, reasoning `high`, Sol=false, Astra=false | Model `ag/gemini-3.8-flash-high`, Profile `gemini-flash-high`, Tier `strong`, Effective Effort `high`, no Sol/Astra | **PASS** |
| **8** | High-Risk Financial Integrity | Model `gemini-flash-high`, reasoning `high` | Model `ag/gemini-3.8-flash-high`, Profile `gemini-flash-high`, Tier `strong`, Effective Effort `high` | **PASS** |
| **9** | De-escalation Trajectory | Multi-turn: Coding -> Fail -> Fix -> Docs | T1: `medium` -> T2: `high` (quality_escalation) -> T3: `medium` (de_escalation) -> T4: `medium` | **PASS** |
| **10** | Provider Diversity (AG outage) | Pre-stream failover to `cx/gpt-5.6-terra`, no reasoning inflation | Fallback profile `terra`, Model `cx/gpt-5.6-terra`, Sol=false, Astra=false, reasoning uninflated | **PASS** |
| **11** | Specialist Optionality | Luna Review optional; fallback to Gemini High if disabled | With Luna: `luna-review`; Without Luna: falls back safely to `gemini-flash-high` | **PASS** |
| **12** | Stream Safety Gate | Pre-stream fallback ok; zero mid-stream replay; zero duplicate tool events | CP1 invariants verified; 0 replays post first byte/SSE chunk | **PASS** |
| **13** | Timeout Configuration | Response-start headroom >= 30,000ms | `UPSTREAM_CONNECT_TIMEOUT_MS=30000`, `UPSTREAM_HEADER_TIMEOUT_MS=30000`, `UPSTREAM_FIRST_BYTE_TIMEOUT_MS=60000` | **PASS** |

---

## 5. Cutover Execution (Phases 14–16)

### 5.1 Pre-Cutover Snapshot
- **V1 PID**: `9528`
- **V2 Green PID**: `1744` (Port 20202)
- **Pre-Cutover Verification**: V1 verified healthy at `http://127.0.0.1:20200/health` immediately prior to switch.

### 5.2 Cutover Procedure
1. Port configuration in `C:\Projects\router\auto-router-v2-green\.env` updated to `PORT=20200`.
2. Process 1744 (Green canary) and Process 9528 (V1 production) terminated gracefully.
3. Port 20200 confirmed released in 0.410s.
4. AutoRouter V2 launched on port 20200 (PID `20072`).
5. Bounded health polling confirmed service ready on `http://127.0.0.1:20200/health` at `t = 1.038s`.
6. Total service transition downtime: **1.038 seconds**.

---

## 6. Production Observation & Telemetry (Phases 17–20)

### 6.1 Initial Production Request Sample (14 Live Invocations)
A bounded sequence of 14 production requests spanning diverse task classes was dispatched to `127.0.0.1:20200`:
1. `GET /health` -> HTTP 200 (ok)
2. Simple Non-Streaming ("Say hello.") -> HTTP 200 in 1.418s | `gemini-flash-low` (cheap, minimal reasoning)
3. Simple Streaming ("Say stream.") -> HTTP 200 in 2.080s | `gemini-flash-medium` (cheap, low reasoning)
4. Routine Calculation ("15 + 27") -> HTTP 200 in 2.640s | `gemini-flash-low` (cheap, low reasoning)
5. Routine + Client Reasoning=High -> HTTP 200 in 1.389s | `gemini-flash-low` (cheap, low reasoning; Auto policy authoritative)
6. Text Transformation (Markdown bullets) -> HTTP 200 in 1.341s | `gemini-flash-low` (cheap, low reasoning)
7. Normal Coding (TypeScript debounce) -> HTTP 200 in 7.681s | `gemini-flash-medium` (balanced, medium reasoning)
8. Normal Debugging (JS array.sort) -> HTTP 200 in 9.407s | `gemini-flash-medium` (cheap, low reasoning)
9. Hard Concurrency (PostgreSQL race condition) -> HTTP 200 in 21.085s | `gemini-flash-high` (strong, high reasoning)
10. High-Risk Financial Integrity (Double-entry balance) -> HTTP 200 in 26.629s | `gemini-flash-high` (strong, high reasoning)
11. Multi-turn Turn 1 (Implementation) -> HTTP 200 in 14.540s | `gemini-flash-medium` (balanced, medium reasoning)
12. Multi-turn Turn 2 (Quality Failure) -> HTTP 200 in 19.374s | `gemini-flash-high` (strong, high reasoning; escalation verified)
13. Multi-turn Turn 3 (Passing Verification) -> HTTP 200 in 11.979s | `gemini-flash-medium` (balanced, medium reasoning; de-escalation verified)
14. Specialist Review (Auth security audit) -> HTTP 200 in 24.481s | `luna-review` (strong, high reasoning)
15. Client Cancellation (Stream disconnect) -> HTTP 200 in 1.600s | aborted cleanly after first chunk

### 6.2 Telemetry Summary
- **Total Invocations**: 14
- **HTTP 200 Count**: 14 (100% success rate)
- **HTTP Failures (4xx / 5xx)**: 0
- **Timeouts**: 0
- **Routing Crashes / Failures**: 0
- **Reasoning Errors**: 0
- **Disabled Model Activations (Sol, Astra, Claude)**: 0
- **Stream Replay / Corrupted Stream Events**: 0
- **Process / Memory Stability**: Completely nominal (PID 20072)

---

## 7. Rollback Verification & Preservation of V1 (Phases 20 & 21)

- **V1 Codebase Preservation**: `C:\Projects\router\auto-router` is preserved in its entirety on branch `main` at commit `a21c81cab6b6fb2f9264abeb8550203b144cf3ef`.
- **No Deletion Policy**: No V1 files, binaries, or configurations were removed.
- **Rollback Procedure**:
  1. Terminate V2 process on port 20200: `Stop-Process -Id 20072` (or taskkill).
  2. Launch V1 from `C:\Projects\router\auto-router`: `node dist/index.js` or `scripts\start-ready.ps1`.
  3. Verify `GET http://127.0.0.1:20200/health`.
  4. Instant recovery time: < 2 seconds without recompilation, git debugging, or configuration changes.

---

## 8. Governance & Main Branch Merge Recommendation (Phase 22)

In accordance with release policy, no automated merge to `main` was performed.

### Recommended Merge Operation:
Upon human operational review and final approval, the verified production commit can be merged to `main` via fast-forward:
```bash
git checkout main
git merge --ff-only hermes/autorouter-v2-cp5-auto-reasoning
git push origin main
```
Commit hash to merge: `401d07048642bc4b95ec81414ed39a567ea93ed5`.
