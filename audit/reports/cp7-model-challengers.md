# CP7 — Model Challenger Benchmark Status

## Verdict: **BENCHMARK_INCOMPLETE**

No challenger role is approved. The initial CP7 matrix is retained under `benchmark/cp7/invalidated/` for audit only and **must not** be used to promote Claude Sonnet 4.6, retain Gemini High by comparison, or rank any reasoning/architecture candidate.

Production AutoRouter on port `20200` was not changed by CP7.

## Why the Initial Evidence Was Invalidated

An independent review found that the original run did not provide trustworthy comparative evidence:

- Qualitative evaluation used permissive keyword heuristics and could award passing outcomes despite missing required invariants.
- Reasoning trap handling defaulted some omitted requirements to “avoided”; persisted output contradicted the claimed complete invariant satisfaction.
- Only snippets of qualitative outputs and no complete agentic source diffs were retained, preventing independent reproduction.
- Successes were cached while failures were re-run, creating asymmetric attempts.
- The methodology described timeout behavior that was not the runner’s actual behavior.

Archived files are intentionally separated at `benchmark/cp7/invalidated/`. The live `benchmark/cp7/results.json` and `benchmark/cp7/summary.json` explicitly state `INVALIDATED` and contain no valid runs.

## Corrected Harness Controls

The replacement harness now:

- validates repository containment with `path.relative`, rejecting traversal and prefix-sharing sibling paths;
- restricts agentic model writes and patches to `src/`, leaving public/hidden tests and package metadata immutable;
- requires positive evidence for every listed reasoning invariant and trap; deterministic reasoning diagnostics remain provisional pending manual invariant review;
- records full qualitative output, SHA-256 hash, evaluator version, and a `MANUAL_REVIEW_REQUIRED` status rather than auto-promoting a keyword score;
- records agentic public/hidden test outcomes plus a source-only diff and SHA-256 hash;
- writes append-only attempt artifacts and never reuses cached successes.

## Current Candidate Status

| Candidate | Status |
|---|---|
| `ag/gemini-3.8-flash-high` | No CP7 comparison conclusion; remains governed by pre-CP7 production policy. |
| `ag/claude-sonnet-4-6` | No agentic-executor promotion; rerun required. |
| `cx/gpt-5.6-sol` | Not benchmarked: recorded Codex weekly quota was 6%, below the 15% safety threshold. |

## Verification Completed During Remediation

- `npx vitest run test/benchmark-cp7.test.ts` — **14 passed**
- `npm test` — **20 files, 324 tests passed**
- `npm run build` — **passed**
- `git diff --check` — **passed**
- `GET http://127.0.0.1:20200/health` — **passed**
- Fresh independent code review — **PASS** (0 high, 0 medium, 0 low, 2 info suggestions)

A fresh full benchmark must obtain manual qualitative review before any routing policy proposal.