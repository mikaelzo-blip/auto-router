# CP6.5C Final Runtime Priority Verification Report

**Checkpoint:** CP6.5C Final Runtime Priority Verification
**Branch:** `hermes/autorouter-v2-cp6-quota-aware`
**Timestamp:** `2026-09-14T13:37:00.000Z`
**Active Production:** `127.0.0.1:20200` (`ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=shadow`)

---

## 1. Executive Summary

Following the priority inversion in local 9Router (`http://127.0.0.1:20128`), CP6.5C conducted the final operational runtime verification to confirm that:
1. `healthy_account` is configured as **Priority 1** and `reserve_account` is configured as **Priority 2** in 9Router.
2. 9Router's fill-first dispatch actually routes 100% of normal traffic to `healthy_account` and conserves `reserve_account`.
3. AutoRouter's semantic model routing, multi-account pool aggregation, and preemptive fallback logic operate cleanly in live runtime.
4. An isolated non-production canary with `ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto` passes all workloads with HTTP 200.
5. The full test and build regression suite passes cleanly.

All gates passed unconditionally. Reserve capacity is protected and `QUOTA_POLICY=auto` is verified ready for production cutover when authorized.

---

## 2. Structured Configuration Verification

Local 9Router API inspection (`GET /api/providers` and `GET /api/settings`):
- **`healthy_account`**: Priority = 1 (persisted in SQLite, verified after mutation and after dispatch testing)
- **`reserve_account`**: Priority = 2 (persisted in SQLite, verified after mutation and after dispatch testing)
- **Round Robin**: OFF (`false` in `capacityAdapter.vision.roundRobin` and empty `providerStrategies`)

---

## 3. Real Runtime Dispatch & Quota Movement

Across 21 sequential production requests and 4 canary requests:
- **`healthy_account` Requests Served:** 25 / 25 (100%)
- **`reserve_account` Requests Served:** 0 / 25 (0%)
- **`healthy_account` Quota Movement:** 97.71% -> 92.51% (consistently reflected request traffic)
- **`reserve_account` Quota Movement:** 0.455% -> 0.455% (0 requests consumed; completely conserved)

---

## 4. Pool Status & Workload Routing Invariants

- **Gemini Multi-Account Pool:** `healthy` (backed by `healthy_account` with ~92.5% remaining capacity).
- **Codex Pool:** `exhausted` (testStatus: 'unavailable', ratio: 0.0000).
- **Workload Routing Results:**
  - `routine` -> `gemini-flash-low` (`ag/gemini-3.8-flash-low`) -> HTTP 200 OK
  - `normal coding` -> `gemini-flash-medium` (`ag/gemini-3.8-flash-medium`) -> HTTP 200 OK
  - `hard concurrency` -> `gemini-flash-high` (`ag/gemini-3.8-flash-high`) -> HTTP 200 OK
  - `review` -> `gemini-flash-high` (`ag/gemini-3.8-flash-high`) -> HTTP 200 OK (preemptively avoids exhausted `luna-review`)
- **Disabled Profiles:** `sol` and `astra` remain strictly disabled (`enabled: false`).

---

## 5. Non-Production Quota Auto Canary (Port 20206)

An isolated canary server was started with:
`ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto`
- Tested `routine`, `normal coding`, `hard concurrency`, and `explicit review`.
- Verified HTTP 200 OK and expected profile/model selections on both `/debug/route` and `/v1/chat/completions`.
- Production `127.0.0.1:20200` remained completely untouched.
- Canary server stopped cleanly and port 20206 released.

---

## 6. Regression Verification

- **Tests:** 19 test files passed (19), 310 tests passed (310).
- **Build:** `tsc -p tsconfig.json` clean, 0 errors.
- **Diff Check:** `git diff --check` clean.

---

## 7. Final Recommendation

**ENABLE QUOTA_POLICY=auto**
