# CP6.5B Final Account Priority Verification Report

**Checkpoint:** CP6.5B Final Account Priority Verification
**Branch:** `hermes/autorouter-v2-cp6-quota-aware`
**Timestamp:** `2026-09-14T12:44:00.000Z`
**Active Production:** `127.0.0.1:20200` (`ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=shadow`)

---

## 1. Executive Summary

In response to the operational blocker observed in CP6.5, a manual inversion of Antigravity account priorities was attempted in 9Router to direct routine traffic to the healthy account (`account_2`, ~99% quota remaining) and conserve the reserve account (`account_1`, <1% quota remaining).

An empirical verification was conducted across all 8 required gates:
1. **Priority Verification**: Structured local 9Router APIs (`/api/providers` and `/api/settings`) reveal that `account_1` (reserve) remains configured at **Priority 1**, while `account_2` (healthy) remains configured at **Priority 2**. Round Robin is **OFF**.
2. **Real Dispatch Verification**: 10 bounded real Gemini requests were sent to production `127.0.0.1:20200`. 100% of requests (10/10) were routed by 9Router's fill-first logic to `account_1` (reserve). `account_2` received 0 requests.
3. **Quota Movement Verification**: `account_1` quota decreased from 0.3049% down to 0.2652% (~3 requests remaining before 429 exhaustion). `account_2` remained unchanged at 98.9900%. Under the explicit STOP condition, reserve conservation failed.
4. **Gemini Pool Status**: Gemini pool evaluates to `healthy` backed by `account_2` best usable ratio (0.9899). Workload routing correctly maps:
   - `routine` -> `gemini-flash-low` (`ag/gemini-3.8-flash-low`)
   - `normal coding` -> `gemini-flash-medium` (`ag/gemini-3.8-flash-medium`)
   - `hard concurrency` -> `gemini-flash-high` (`ag/gemini-3.8-flash-high`)
   - `high-risk general` -> `gemini-flash-high` (`ag/gemini-3.8-flash-high`)
5. **Codex Exhaustion Verification**: Codex pool remains exhausted (`terra` and `luna-review` unavailable). Explicit review requests cleanly fall back to `gemini-flash-high` without attempting doomed Codex calls. `sol` and `astra` remain strictly disabled.
6. **Non-Production Canary Auto Testing**: Canary server on isolated port 20206 with `QUOTA_POLICY=auto` passed all 4 test workloads (`routine`, `normal coding`, `hard concurrency`, `review`) with HTTP 200 and exact model selections. Production 20200 was left untouched.
7. **Full Verification**: `npm test` (19 test files, 310 tests pass), `npm run build` (clean), and `git diff --check` (clean).

**Final Recommendation:** **`KEEP QUOTA_POLICY=shadow`**. Production `QUOTA_POLICY=auto` must NOT be enabled until 9Router's configured priorities are inverted (`account_2` = Priority 1, `account_1` = Priority 2) and verified to route live traffic to `account_2`.

---

## 2. Structured 9Router API Priority Audit

Querying local 9Router endpoints (`http://127.0.0.1:20128`):
- `GET /api/providers`:
  - `account_1` (`b59bebec...`, reserve, created Aug 31): `priority: 1`
  - `account_2` (`4acde0a7...`, healthy, created Sep 14): `priority: 2`
- `GET /api/settings`:
  - `providerStrategies`: `{}`
  - `capacityAdapter.vision.roundRobin`: `false`
  - Round Robin: **OFF**

In 9Router SQLite database (`providerConnections`), the connections were updated at:
- `account_2`: `priority: 2` (updated `2026-09-14T12:38:46Z`)
- `account_1`: `priority: 1` (updated `2026-09-14T12:39:28Z`)

The intended inversion (`account_2` -> Priority 1, `account_1` -> Priority 2) was inverted in reverse in the 9Router UI: the reserve account was assigned Priority 1, and the healthy account was assigned Priority 2.

---

## 3. Real Dispatch & Quota Movement Evidence

10 real Gemini requests were sent sequentially to `http://127.0.0.1:20200/v1/chat/completions`:

| Req # | Prompt Type | HTTP Status | Latency | Served By Connection | Account Alias |
| :---: | :--- | :---: | :---: | :--- | :---: |
| 1 | Routine transformation | 200 | 1919ms | `b59bebec...` | `account_1` (reserve) |
| 2 | Routine transformation | 200 | 8744ms | `b59bebec...` | `account_1` (reserve) |
| 3 | Routine transformation | 200 | 1405ms | `b59bebec...` | `account_1` (reserve) |
| 4 | Routine transformation | 200 | 1750ms | `b59bebec...` | `account_1` (reserve) |
| 5 | Routine transformation | 200 | 1486ms | `b59bebec...` | `account_1` (reserve) |
| 6 | Routine transformation | 200 | 1240ms | `b59bebec...` | `account_1` (reserve) |
| 7 | Routine transformation | 200 | 2212ms | `b59bebec...` | `account_1` (reserve) |
| 8 | Routine transformation | 200 | 1587ms | `b59bebec...` | `account_1` (reserve) |
| 9 | Routine transformation | 200 | 1261ms | `b59bebec...` | `account_1` (reserve) |
| 10 | Routine transformation | 200 | 2117ms | `b59bebec...` | `account_1` (reserve) |

### Quota Movement
- **`account_1` (reserve):**
  - Starting quota: `0.3049%` (used 997 / 1000)
  - Ending quota: `0.2652%` (used 997 / 1000, weekly quota consumed)
  - Remaining capacity: ~3 requests before hard 429 quota exhaustion.
  - Conserved: **NO (FAIL)**
- **`account_2` (healthy):**
  - Starting quota: `98.9900%` (used 10 / 1000)
  - Ending quota: `98.9900%` (used 10 / 1000)
  - Requests served: **0 (0%) (FAIL)**

---

## 4. Pool Status & Workload Routing Invariants

- **Gemini Pool**: `healthy` (usable accounts: 2, best ratio: 0.9899).
- **Codex Pool**: `exhausted` (usable accounts: 0, status: unavailable).
- **Profile Eligibility**:
  - `gemini-flash-low`: `healthy` (0.9899)
  - `gemini-flash-medium`: `healthy` (0.9899)
  - `gemini-flash-high`: `healthy` (0.9899)
  - `terra`: `exhausted` (0.0)
  - `luna-review`: `exhausted` (0.0)
  - `sol`: `exhausted` / disabled (`enabled: false`)
  - `astra`: `exhausted` / disabled (`enabled: false`)
- **Review Fallback**: Preemptively falls back from `luna-review` to `gemini-flash-high` (`switchReason: quota_exhausted`, `selectionEffect: avoided_exhausted_luna-review`).

---

## 5. Non-Production Canary Auto Testing (Port 20206)

An isolated canary server was launched on port 20206 with `ROUTER_MODE=v2`, `REASONING_POLICY=auto`, `QUOTA_POLICY=auto`:
- `routine` -> `gemini-flash-low` (`ag/gemini-3.8-flash-low`) -> HTTP 200 OK
- `normal coding` -> `gemini-flash-medium` (`ag/gemini-3.8-flash-medium`) -> HTTP 200 OK
- `hard concurrency` -> `gemini-flash-high` (`ag/gemini-3.8-flash-high`) -> HTTP 200 OK
- `review` -> `gemini-flash-high` (`ag/gemini-3.8-flash-high`) -> HTTP 200 OK
Canary was cleanly shut down without modifying production 20200.

---

## 6. Readiness Gates Evaluation

| Gate Criterion | Verification Method | Status | Notes |
| :--- | :--- | :---: | :--- |
| **1. Healthy account serves requests** | Live 9Router completions & SQLite | **FAIL** | Served 0 requests (0%); all traffic went to `account_1` |
| **2. Reserve account is conserved** | Real-time quota tracking | **FAIL** | Quota decreased to 0.2652% (~3 requests left) |
| **3. Multi-account Gemini pool healthy** | Live snapshot evaluation | **PASS** | Evaluates to `healthy` (0.9899 best ratio) |
| **4. Codex exhaustion respected** | Quota policy & candidate states | **PASS** | Terra and Luna-review marked `exhausted` |
| **5. Review fallback works** | Preemptive fallback inspection | **PASS** | Substitutes `gemini-flash-high` upfront |
| **6. No Sol/Astra activation** | Profile flags & candidate states | **PASS** | Strictly disabled |
| **7. Tests and build pass** | Vitest & tsc verification | **PASS** | 19 test files, 310 tests pass, build clean |

---

## 7. Operational Recommendation

```
==================================================
FINAL RECOMMENDATION:
KEEP QUOTA_POLICY=shadow
==================================================
```

### Actionable Next Step for User:
In the 9Router web interface (`http://127.0.0.1:20128`):
1. Navigate to **Providers** -> **Antigravity**.
2. Identify the healthy account (`account_2`, `blo***`) and set its Priority to **1**.
3. Identify the reserve account (`account_1`, `mik***`) and set its Priority to **2**.
4. Confirm Round Robin remains **OFF**.

Do NOT enable production `QUOTA_POLICY=auto` until this priority inversion is active and verified to route traffic to `account_2`.
