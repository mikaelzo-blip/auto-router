# Final Real-Work Agentic Soak (12 Tasks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a fair, isolated, 12-task agentic benchmark comparing `cx/gpt-6-sol`, `cx/gpt-6-luna`, and `ag/claude-sonnet-4-6` (36 total evaluations) to select the future agentic production model without altering production routing or 9Router settings.

**Architecture:** Bounded CLI runner (`scripts/agentic-soak-runner.ts`) executing isolated sandboxes under `tmp/agentic-soak/` with strict read isolation (no hidden tests, oracles, or competitor results visible to agent), restricted filesystem mutations (`src/` only), deterministic public and hidden TypeScript test harnesses, immediate per-unit JSON persistence with resume capability, and zero quality-failure retries.

**Tech Stack:** Node.js v24, TypeScript (tsx), Node test runner (`node:test`, `node:assert`), fetch API for OpenAI-compatible router endpoint (`http://127.0.0.1:20128/v1`).

**Spec:** In-chat approved 12-task agentic soak specification incorporating 5 fairness principles: Read Isolation, Equal Execution Budget, Strict Infra-Only Retry Policy, Blind Subjective Evaluation, and AG-12 Trap Non-Disclosure.

## Global Constraints

- Current production routing MUST remain unchanged (`PRODUCTION ROUTING CHANGED: NO`).
- Do NOT modify 9Router configuration, upstream endpoints, or production timeouts.
- `STRONG` model routing remains `ag/gemini-3.8-flash-high` and is NOT benchmarked or altered.
- Exactly 12 realistic agentic tasks covering all requested shapes.
- Sandbox workspace for each model/task unit is fully isolated and disposable.
- No task sandbox may expose hidden tests, corpus JSON, or outputs of other models.
- Modifications by models are strictly constrained to `src/` (tests and metadata immutable).
- No quality failure may be retried; maximum 1 retry for transport/5xx/429 infra errors only.
- Final evaluation state and results stored immediately in `benchmark/agentic-soak/raw/` and `benchmark/agentic-soak/results.json`.

## Review Focus

1. **Read Isolation Leak:** Verify that `read_file` or `list_files` cannot navigate outside the sandbox or discover hidden tests/benchmark scripts.
2. **Permission Boundary:** Verify that attempting to write or patch `test/` or root files fails and records a `prohibitedWrite`.
3. **Execution Parity:** Verify all 3 models receive identical system prompts, tools, public tests, deadlines (5 min), and iteration caps (20).
4. **Fairness on AG-12 Trap:** Verify task AG-12 prompt omits any mention of the amount-pattern trap (`% 100 === 99` / 199).
5. **No Production Routing Mutation:** Verify git status at end shows no modifications to production routing files (`src/router.ts`, `src/config.ts`, etc.).

---

### Task 1: Establish Benchmark Corpus and Fixtures
- [ ] Create `benchmark/agentic-soak/corpus.json` containing the 12 agentic task definitions with exact prompt texts and rubric metadata.
- [ ] Prepare isolated fixture directories for cases AG-01 through AG-12 in `benchmark/agentic-soak/fixtures/` with baseline public tests and hidden verification tests.
- [ ] Verify baseline tests independently: confirm all 12 baseline fixtures fail hidden acceptance tests and behave as designed.

### Task 2: Implement the Agentic Soak Runner
- [ ] Create `scripts/agentic-soak-runner.ts` with sandbox setup, tool executor, deadline management (5 min), iteration limit (20), and strict `src/` write gating.
- [ ] Implement read isolation: ensure tools reject paths pointing outside the sandbox or into hidden test fixtures.
- [ ] Implement objective oracle verification: execute visible tests, inject and execute hidden tests post-turn, and evaluate premature success assertions.
- [ ] Implement immediate per-record persistence to `benchmark/agentic-soak/raw/AG-XX_<model>.json` and aggregate `benchmark/agentic-soak/results.json`.
- [ ] Add CLI flags: `--resume`, `--task AG-XX`, `--model <alias>`, and `--smoke`.

### Task 3: Smoke Validation & Harness Verification
- [ ] Run `--smoke` across 1 task on 1 model to verify sandbox creation, tool call loop, test execution, hidden test evaluation, and persistence without regressions.
- [ ] Confirm resume functionality correctly detects existing evaluations and skips redundant runs.

### Task 4: Execute Full 36-Evaluation Soak Matrix
- [ ] Run full matrix: 12 tasks × 3 models (`cx/gpt-6-sol`, `cx/gpt-6-luna`, `ag/claude-sonnet-4-6`).
- [ ] Monitor execution, ensuring transport/infra retries fire only on network/5xx/429.
- [ ] Verify all 36 evaluation records are written and aggregated.

### Task 5: Analysis and Final Soak Report
- [ ] Aggregate per-model metrics: final-green count, hidden-green count, premature success, median iterations, median tool calls, median latency.
- [ ] Produce pairwise comparative analysis: Sol vs Luna, Sol vs Sonnet, Luna vs Sonnet.
- [ ] Apply the promotion rule to determine the Agentic Production Candidate and recommended fallback order.
- [ ] Confirm production routing remains unchanged and present final report.
