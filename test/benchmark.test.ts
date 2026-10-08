import { describe, expect, it } from "vitest";
import {
  FAILURE_CATEGORIES,
  classifyFailure,
  makeUnitKey,
  parseUnitKey,
  redactSensitiveData,
  buildCandidateStats,
  summarizeBenchmarkRun
} from "../src/benchmark/taxonomy.js";
import { evaluateCaseOutput, type CorpusCaseItem } from "../src/benchmark/rubrics.js";
import { BenchmarkRunner } from "../src/benchmark/harness.js";
import type { BenchmarkRecord } from "../src/benchmark/types.js";
import { validateProfileCoverage, routeShadow, type ExecutionProfile } from "../src/shadow-router.js";
import { runComparison } from "../scripts/benchmark/compare-legacy-v2.js";
import { runSessionSimulation, CANONICAL_TRAJECTORIES } from "../scripts/shadow/simulate-sessions.js";

describe("CP3A Benchmark Harness & Taxonomy", () => {
  describe("1. Failure classification", () => {
    it("classifies all 9 failure categories distinctly", () => {
      // 1. INFRA_TIMEOUT
      expect(classifyFailure({ status: 504, errorMessage: "gateway timeout", isTimeout: true })).toBe("INFRA_TIMEOUT");
      expect(classifyFailure({ status: 0, errorMessage: "The operation was aborted", isTimeout: true })).toBe("INFRA_TIMEOUT");

      // 2. HTTP_429
      expect(classifyFailure({ status: 429, errorMessage: "Rate limit exceeded" })).toBe("HTTP_429");

      // 3. HTTP_5XX
      expect(classifyFailure({ status: 500, errorMessage: "Internal Server Error" })).toBe("HTTP_5XX");
      expect(classifyFailure({ status: 502, errorMessage: "Bad Gateway" })).toBe("HTTP_5XX");

      // 4. AUTH_FAILURE
      expect(classifyFailure({ status: 401, errorMessage: "Missing or invalid API key" })).toBe("AUTH_FAILURE");
      expect(classifyFailure({ status: 403, errorMessage: "Forbidden access" })).toBe("AUTH_FAILURE");

      // 5. MODEL_UNAVAILABLE
      expect(classifyFailure({ status: 404, errorMessage: "model_not_found" })).toBe("MODEL_UNAVAILABLE");

      // 6. TOOL_FAILURE
      expect(classifyFailure({ status: 200, toolError: true })).toBe("TOOL_FAILURE");

      // 7. HARNESS_ERROR
      expect(classifyFailure({ status: 0, errorMessage: "ECONNREFUSED 127.0.0.1:20128" })).toBe("HARNESS_ERROR");
      expect(classifyFailure({ status: 0, harnessError: true })).toBe("HARNESS_ERROR");

      // 8. INVALID_RESPONSE
      expect(classifyFailure({ status: 200, content: "" })).toBe("INVALID_RESPONSE");
      expect(classifyFailure({ status: 200, content: "   " })).toBe("INVALID_RESPONSE");

      // Valid response is not an operational failure
      expect(classifyFailure({ status: 200, content: "Valid model output" })).toBeNull();
    });

    it("verifies FAILURE_CATEGORIES contains all 9 required types", () => {
      expect(FAILURE_CATEGORIES).toHaveLength(9);
      expect(FAILURE_CATEGORIES).toContain("QUALITY_FAILURE");
      expect(FAILURE_CATEGORIES).toContain("INFRA_TIMEOUT");
      expect(FAILURE_CATEGORIES).toContain("HTTP_429");
      expect(FAILURE_CATEGORIES).toContain("HTTP_5XX");
      expect(FAILURE_CATEGORIES).toContain("AUTH_FAILURE");
      expect(FAILURE_CATEGORIES).toContain("MODEL_UNAVAILABLE");
      expect(FAILURE_CATEGORIES).toContain("TOOL_FAILURE");
      expect(FAILURE_CATEGORIES).toContain("HARNESS_ERROR");
      expect(FAILURE_CATEGORIES).toContain("INVALID_RESPONSE");
    });
  });

  describe("2. Sensitive-data redaction", () => {
    it("redacts API keys, Bearer tokens, and secrets from strings", () => {
      const sensitive = "Error with Authorization: Bearer secret_token_123456789 and api_key=sk-abc123456789xyz";
      const redacted = redactSensitiveData(sensitive);
      expect(redacted).not.toContain("secret_token_123456789");
      expect(redacted).not.toContain("sk-abc123456789xyz");
      expect(redacted).toContain("[REDACTED]");
    });
  });

  describe("3. Unit key serialization and deduplication", () => {
    it("creates and parses unique benchmark unit keys", () => {
      const key = makeUnitKey("case-a1", "ag/gemini-3.8-flash-low", 1);
      expect(key).toBe("case-a1::ag/gemini-3.8-flash-low::1");
      const parsed = parseUnitKey(key);
      expect(parsed.caseId).toBe("case-a1");
      expect(parsed.modelId).toBe("ag/gemini-3.8-flash-low");
      expect(parsed.attempt).toBe(1);
    });

    it("deduplicates completed units by unit key", () => {
      const records: BenchmarkRecord[] = [
        {
          caseId: "case-a1",
          category: "A",
          name: "Test",
          expectedFloor: "cheap",
          modelId: "m1",
          attempt: 1,
          timestamp: new Date().toISOString(),
          httpStatus: 200,
          elapsedMs: 100,
          streamed: false,
          operationalSuccess: true,
          qualitySuccessWhenExecuted: true,
          passed: true
        },
        {
          caseId: "case-a1",
          category: "A",
          name: "Test",
          expectedFloor: "cheap",
          modelId: "m1",
          attempt: 1,
          timestamp: new Date().toISOString(),
          httpStatus: 200,
          elapsedMs: 100,
          streamed: false,
          operationalSuccess: true,
          qualitySuccessWhenExecuted: true,
          passed: true
        }
      ];

      const keys = new Set(records.map((r) => makeUnitKey(r.caseId, r.modelId, r.attempt)));
      expect(keys.size).toBe(1);
    });
  });

  describe("4. Benchmark resume and denominator uniformity", () => {
    it("correctly identifies uniform vs non-uniform candidate denominators", () => {
      const uniformRecords: BenchmarkRecord[] = [
        { caseId: "case-1", category: "A", name: "t1", expectedFloor: "cheap", modelId: "m1", attempt: 1, timestamp: "", httpStatus: 200, elapsedMs: 10, streamed: false, operationalSuccess: true, qualitySuccessWhenExecuted: true, passed: true },
        { caseId: "case-2", category: "A", name: "t2", expectedFloor: "cheap", modelId: "m1", attempt: 1, timestamp: "", httpStatus: 200, elapsedMs: 10, streamed: false, operationalSuccess: true, qualitySuccessWhenExecuted: true, passed: true },
        { caseId: "case-1", category: "A", name: "t1", expectedFloor: "cheap", modelId: "m2", attempt: 1, timestamp: "", httpStatus: 200, elapsedMs: 10, streamed: false, operationalSuccess: true, qualitySuccessWhenExecuted: true, passed: true },
        { caseId: "case-2", category: "A", name: "t2", expectedFloor: "cheap", modelId: "m2", attempt: 1, timestamp: "", httpStatus: 200, elapsedMs: 10, streamed: false, operationalSuccess: true, qualitySuccessWhenExecuted: true, passed: true }
      ];

      const uniformSummary = summarizeBenchmarkRun(uniformRecords, 2);
      expect(uniformSummary.denominatorUniform).toBe(true);

      const skewedRecords: BenchmarkRecord[] = [
        ...uniformRecords,
        { caseId: "case-3", category: "A", name: "t3", expectedFloor: "cheap", modelId: "m1", attempt: 1, timestamp: "", httpStatus: 200, elapsedMs: 10, streamed: false, operationalSuccess: true, qualitySuccessWhenExecuted: true, passed: true }
      ];

      const skewedSummary = summarizeBenchmarkRun(skewedRecords, 2);
      expect(skewedSummary.denominatorUniform).toBe(false);
    });

    it("separates quality success rate from operational success rate", () => {
      const mixedRecords: BenchmarkRecord[] = [
        // m1: 1 success, 1 timeout
        { caseId: "c1", category: "A", name: "t1", expectedFloor: "cheap", modelId: "m1", attempt: 1, timestamp: "", httpStatus: 200, elapsedMs: 100, streamed: false, operationalSuccess: true, qualitySuccessWhenExecuted: true, passed: true },
        { caseId: "c2", category: "A", name: "t2", expectedFloor: "cheap", modelId: "m1", attempt: 1, timestamp: "", httpStatus: 504, elapsedMs: 20000, streamed: false, operationalSuccess: false, qualitySuccessWhenExecuted: null, passed: false, failureCategory: "INFRA_TIMEOUT" },
        // m2: 2 executed, 1 quality pass, 1 quality fail
        { caseId: "c1", category: "A", name: "t1", expectedFloor: "cheap", modelId: "m2", attempt: 1, timestamp: "", httpStatus: 200, elapsedMs: 100, streamed: false, operationalSuccess: true, qualitySuccessWhenExecuted: true, passed: true },
        { caseId: "c2", category: "A", name: "t2", expectedFloor: "cheap", modelId: "m2", attempt: 1, timestamp: "", httpStatus: 200, elapsedMs: 100, streamed: false, operationalSuccess: true, qualitySuccessWhenExecuted: false, passed: false, failureCategory: "QUALITY_FAILURE" }
      ];

      const statsM1 = buildCandidateStats("m1", mixedRecords);
      expect(statsM1.operationalSuccessRate).toBe(0.5); // 1 / 2
      expect(statsM1.qualitySuccessRateWhenExecuted).toBe(1.0); // 1 / 1 (timeout NOT counted as quality failure!)

      const statsM2 = buildCandidateStats("m2", mixedRecords);
      expect(statsM2.operationalSuccessRate).toBe(1.0); // 2 / 2
      expect(statsM2.qualitySuccessRateWhenExecuted).toBe(0.5); // 1 / 2
    });
  });

  describe("5. Timeout isolation and execution continuation", () => {
    it("records INFRA_TIMEOUT on aborted execution without throwing", async () => {
      const runner = new BenchmarkRunner({
        baseUrl: "http://127.0.0.1:20128/v1",
        defaultTimeoutMs: 1 // Force immediate timeout
      });

      const mockCase: CorpusCaseItem = {
        caseId: "mock-timeout-case",
        category: "MOCK",
        name: "Mock Case",
        expectedFloor: "cheap",
        prompt: "echo",
        rubric: {
          type: "deterministic",
          keyCriteria: ["test"]
        }
      };

      const record = await runner.executeUnit({
        caseItem: mockCase,
        modelId: "ag/gemini-3.8-flash-low",
        attempt: 1,
        timeoutMs: 1
      });

      expect(record.operationalSuccess).toBe(false);
      expect(record.failureCategory).toBe("INFRA_TIMEOUT");
      expect(record.qualitySuccessWhenExecuted).toBeNull();
      expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("6. Rebuilt rubrics and invariant dimensions", () => {
    it("evaluates semantic invariants without requiring brittle exact string matches", () => {
      const mockCase: CorpusCaseItem = {
        caseId: "case-c2",
        category: "C. REPOSITORY EXPLORATION",
        name: "Trace routing fallback path",
        expectedFloor: "balanced",
        prompt: "Trace fallback path",
        rubric: {
          type: "deterministic",
          mustContain: ["pre-stream", "priority"],
          keyCriteria: ["Prohibits replay after partial emission"]
        }
      };

      // Model uses "before streaming" instead of exact "pre-stream" and "never replay once emitted"
      const modelOutput =
        "The system checks priority order before streaming begins. We must never replay after chunks are emitted.";
      const result = evaluateCaseOutput(mockCase, modelOutput);

      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.7);
    });

    it("detects null safety guard invariant on case-b1", () => {
      const mockCase: CorpusCaseItem = {
        caseId: "case-b1",
        category: "B. SIMPLE CODE",
        name: "Fix TypeScript optional parameter null check",
        expectedFloor: "cheap",
        prompt: "fix null check",
        rubric: {
          type: "deterministic",
          keyCriteria: ["Null guard"]
        }
      };

      const goodCode = "function getUser(id?: string) { if (!id) return undefined; return users.get(id); }";
      const badCode = "function getUser(id?: string) { return users.get(id); }";

      const goodResult = evaluateCaseOutput(mockCase, goodCode);
      const badResult = evaluateCaseOutput(mockCase, badCode);

      expect(goodResult.passed).toBe(true);
      expect(badResult.passed).toBe(false);
    });
  });

  describe("7. Multi-turn session simulation & stickiness", () => {
    it("runs canonical trajectories A, B, and C with session continuity", () => {
      const sim = runSessionSimulation();
      expect(sim.totalTrajectories).toBe(3);
      expect(sim.totalTurns).toBe(12);
      expect(sim.switchesPerSession).toBeGreaterThan(0);
      expect(sim.overallStickinessRate).toBeGreaterThan(0);

      // Trajectory A verification
      const trajA = sim.trajectories.find((t) => t.trajectoryId === "trajectory-a")!;
      expect(trajA).toBeDefined();
      expect(trajA.turnsCount).toBe(6);

      // Turn 2 should stay sticky with Turn 1
      expect(trajA.turns[1]!.switched).toBe(false);
      // Turn 3 (failing test) should escalate
      expect(trajA.turns[2]!.escalation).toBe(true);
      // Turn 5 (passing test) should de-escalate
      expect(trajA.turns[4]!.deEscalation).toBe(true);
    });
  });

  describe("8. Legacy vs V2 comparison completion", () => {
    it("completes comparison across all 20 corpus records without exception", async () => {
      const comparison = await runComparison();
      expect(comparison.totalCases).toBe(20);
      expect(comparison.comparisons).toHaveLength(20);
      expect(comparison.frontierUsageRate).toBeDefined();
      expect(comparison.cheapBalancedRate).toBeDefined();
      expect(comparison.legacyRouteDistribution).toBeDefined();
    });
  });
});
