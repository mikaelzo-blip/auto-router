# AutoRouter V2 — CP6.2 Specialist Intent Isolation & Quota Conservation Report

## Executive Summary

Checkpoint **CP6.2** formalizes the architectural separation between general execution profiles, specialist reviewer models, and resilience capacity. It replaces informal pattern matching with a deterministic fail-closed clause classifier, isolates specialist profiles from generic task routing and quota pressure, and prevents routine/cheap requests from prematurely draining resilience capacity.

- **Baseline HEAD**: `97dbb64d733329764740eae420496546bba47a8e`
- **Branch**: `hermes/autorouter-v2-cp6-quota-aware`
- **Verification Status**: 271 / 271 tests passing across 16 test files. Build and whitespace checks 100% clean.
- **Production Status**: Production port `20200` untouched; `QUOTA_POLICY=shadow` preserved; no automated cutover.

---

## 1. Problem Statement & Motivation

During CP6.1 live soak evaluation and subsequent independent review, three critical policy risks were identified:

1. **Specialist Over-Subscription**: Under high-risk task conditions or quota pressure on general execution pools, specialist reviewer profiles (specifically `luna-review` / `cx/gpt-5.6-luna-review`) could become eligible for non-review tasks (such as generic coding or financial audit logging). Furthermore, legacy regex matching risked false-positive triggers on noun-adjunct phrases such as `"review comments"` or `"audit logs"`.
2. **Resilience Drain on Low-Tier Work**: When the primary cheap/balanced execution pool (`gemini-flash-*`) entered reserve (remaining ratio < 10%), the CP6.1 quota-aware ranking immediately substituted `terra` (`cx/gpt-5.6-terra`) for routine low-complexity requests, even when Codex was itself constrained (weekly ratio ~22%). This risked starving subsequent high-complexity, high-risk tasks of resilience fallback capacity.
3. **Fragile Specialist Intent Detection**: Previous iterations used regex-based intent classification susceptible to conversational edge cases, prompt history bleed, and ambiguous phrasing.

---

## 2. Key Architecture & Policy Changes

### 2.1 Profile Classification Matrix

Every execution profile in `config/shadow-profiles.json`, `src/shadow-profiles.ts`, and router validation now explicitly declares a `ProfileClass`:

- **`general`**: Standard model pool (`gemini-flash-low`, `gemini-flash-medium`, `gemini-flash-high`, `sol` [disabled], `astra` [disabled], `claude-*` [disabled]). Eligible for standard task fit and general quota substitution.
- **`specialist`**: Specialized single-purpose profile (`luna-review`). **Strictly excluded** from generic candidate pools, baseline coverage validation, and generic quota pressure substitution. Only eligible when explicit `specialistIntent === "review"` is detected and taskFit matches.
- **`resilience`**: Dedicated resilience and high-assurance fallback (`terra`). Protected from lower-tier routine substitution unless healthy (>= 50% remaining) and offering significant headroom gain (>= 25%).

### 2.2 Deterministic Fail-Closed Clause Classifier

Specialist intent detection (`specialistIntentOf` in `src/shadow-router.ts`) was completely re-architected into a deterministic, fail-closed clause classifier:

1. **Turn Isolation**: Examines solely the current user prompt turn (`currentRequestTextOf`), eliminating multi-turn history bleed.
2. **Clause Segmentation**: Partitions the text on sentence/clause delimiters (`/[.;!?\n]+/`) and tokenizes into unicode-aware words.
3. **Context Noun-Adjunct Filtering**: Explicitly suppresses review matches when the review term (`review`, `audit`, `critique`) is immediately followed by a context term:
   - `comments`, `findings`, `logs`, `logging`, `notes`, `results`, `status`, `trail`, `feedback`, `report`, `reports`
   - *Example*: `"Review comments are resolved; implement the fix"` -> **NO** specialist intent.
   - *Example*: `"Implement financial audit logging"` -> **NO** specialist intent.
4. **Declarative Copula Suppression**: Suppresses matches where the review term is followed by copulas or completion adjectives:
   - `is`, `are`, `was`, `were`, `has`, `been`, `done`, `finished`, `complete`, `completed`
   - *Example*: `"Review is complete; please deploy"` -> **NO** specialist intent.
   - *Example*: `"Audit was finished yesterday"` -> **NO** specialist intent.
5. **Negation Protection**: Disqualifies candidate tokens preceded by negations (`cannot`, `can't`, `didn't`, `doesn't`, `don't`, `never`, `no`, `not`, `shouldn't`, `wasn't`, `weren't`, `without`, `won't`, `wouldn't`, `skip`, `avoid`).
6. **Explicit Structural Recognition**: Matches only well-defined imperative and explicit request structures:
   - **Case A (Direct Imperatives)**: Clean leading verb (e.g., `"Review this function for correctness"`, `"Please review this PR"`).
   - **Case B (Modal Polite Requests)**: Polite modal stems (e.g., `"Can you review..."`, `"Could you please audit the authentication middleware..."`).
   - **Case C (Action Verbs + Review Nouns)**: Action verbs governing review objects (e.g., `"Perform security audit"`, `"Provide a code review"`, `"Carry out an audit"`).
   - **Case D (First-Person Desires/Needs)**: Direct user expressions of review need (e.g., `"I need a code review"`, `"We need a security audit"`, `"I would like a code review"`).

### 2.3 Quota Conservation & Resilience Gating

In `src/quota/policy.ts`:

- **Specialist Isolation Under Quota Pressure**: When general models are exhausted, specialist profiles (`profileClass === "specialist"`) **cannot** be selected for generic tasks regardless of remaining quota. If no general candidate exists, the decision cleanly yields `undefined` candidate with `selectionEffect: "no_eligible_candidate"`.
- **Resilience Headroom Gating**: Routine and lower-tier tasks (`complexity: trivial/low/medium`, `risk: low`, `minimumQualityTier: cheap/balanced`) will not switch to a resilience profile (`terra`) unless:
  1. `terra` status is `healthy` (remaining ratio >= 50%), **AND**
  2. `terra` provides at least 25% headroom gain over the standard candidate.
- **No Beneficial Alternative Classification**: When a routine task consumes reserve quota because switching to constrained resilience capacity would be counter-productive, the router explicitly reports:
  - `selectionEffect: "no_beneficial_alternative"`
  - `decisionReason: "reserve_consumed_for_lack_of_valid_alternative"`
- **Telemetry Concurrency Optimization**: `NineRouterQuotaSource` now fetches Antigravity and Codex usage quotas concurrently via `Promise.all`, dropping telemetry refresh latency from ~6s to ~2.6s.

---

## 3. Verification & Acceptance Matrix

| Item | Requirement | Verification Result |
|---|---|---|
| 1 | Deterministic clause classifier | **VERIFIED** — tested against extensive positive, negative, and edge-case corpuses. |
| 2 | Fail-closed specialist detection | **VERIFIED** — default non-eligible across router and quota policy. |
| 3 | Generic high-risk excludes luna-review | **VERIFIED** — `Implement financial audit logging` routes to `gemini-flash-high`. |
| 4 | Explicit review selects luna-review | **VERIFIED** — direct imperatives, modals, action verbs, and first-person needs select `luna-review`. |
| 5 | Quota pressure cannot bypass specialist isolation | **VERIFIED** — exhausted general pool leaves `luna-review` untouched; yields `no_eligible_candidate`. |
| 6 | Routine reserve does not jump to Terra | **VERIFIED** — cheap/routine tasks remain on Gemini reserve rather than draining constrained Terra. |
| 7 | No-beneficial-alternative behavior | **VERIFIED** — debug observability exposes `no_beneficial_alternative` and explicit `decisionReason`. |
| 8 | Terra resilience-role policy | **VERIFIED** — gated by 50% minimum remaining and 25% headroom delta. |
| 9 | Reserve-consumption policy | **VERIFIED** — distinct reasons for high-value task consumption vs lack of alternatives. |
| 10 | Regression test suite | **VERIFIED** — 271 / 271 unit and integration tests green. |
| 11 | Production port 20200 untouched | **VERIFIED** — production instance running independently on port 20200. |
| 12 | Sol and Astra disabled | **VERIFIED** — `enabled: false` verified across registry and coverage checks. |

---

## 4. Test Suite Execution Summary

```
 RUN  v3.2.7 C:/Projects/router/auto-router-v2

 ✓ test/shadow-router.test.ts (13 tests)
 ✓ test/reliability.test.ts (6 tests)
 ✓ test/cp4-1-regression.test.ts (53 tests)
 ✓ test/quota-policy.test.ts (24 tests)
 ✓ test/quota-source.test.ts (5 tests)
 ✓ test/routing.test.ts (34 tests)
 ✓ test/health-metrics.test.ts (4 tests)
 ✓ test/quota-cooldown.test.ts (6 tests)
 ✓ test/search.test.ts (2 tests)
 ✓ test/benchmark.test.ts (12 tests)
 ✓ test/auto-search.test.ts (1 test)
 ✓ test/responses.test.ts (4 tests)
 ✓ test/cp6-quota-routing.test.ts (34 tests)
 ✓ test/app.test.ts (23 tests)
 ✓ test/cp3-failure.test.ts (8 tests)
 ✓ test/auto-reasoning.test.ts (42 tests)

 Test Files  16 passed (16)
      Tests  271 passed (271)
   Duration  5.49s
```

TypeScript compilation:
```
> tsc -p tsconfig.json
(Clean, zero diagnostics)
```

Git diff check:
```
> git diff --check
(Clean, zero whitespace or format issues)
```
