import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import {
  isPathInside,
  isWritableSourcePath,
  isAgenticSessionWithinDeadline,
  classifyHttpFailure,
  classifyAgenticOutcome,
  executeAgenticTool,
  evaluatePromotionGate,
  loadResumeAttempts,
  shouldSkipCaseCandidate,
  writeAtomicJson,
  isValidAttempt
} from "../scripts/benchmark-cp7-2.js";

describe("CP7.2 Agentic Session Deadline & Invariants", () => {
  it("enforces the eight-minute wall-clock limit strictly", () => {
    const start = 1_000_000;
    expect(isAgenticSessionWithinDeadline(start, start + 479_999)).toBe(true);
    expect(isAgenticSessionWithinDeadline(start, start + 480_000)).toBe(false);
    expect(isAgenticSessionWithinDeadline(start, start + 500_000)).toBe(false);
  });
});

describe("CP7.2 Security & Sandbox Invariants", () => {
  const testWorkDir = resolve("tmp/test-cp7-2-workdir");

  it("permits paths strictly inside workDir", () => {
    expect(isPathInside(testWorkDir, "src/index.ts")).toBe(true);
    expect(isPathInside(testWorkDir, "test/test.ts")).toBe(true);
    expect(isPathInside(testWorkDir, ".")).toBe(true);
    expect(isPathInside(testWorkDir, "migrations/001.ts")).toBe(true);
  });

  it("rejects path traversal attempts escaping workDir", () => {
    expect(isPathInside(testWorkDir, "../sibling")).toBe(false);
    expect(isPathInside(testWorkDir, "../../etc/passwd")).toBe(false);
    expect(isPathInside(testWorkDir, resolve("tmp/test-cp7-2-workdir-other"))).toBe(false);
  });

  it("restricts writable files strictly to src/ and migrations/, keeping tests immutable", () => {
    expect(isWritableSourcePath(testWorkDir, "src/rate-limiter.ts")).toBe(true);
    expect(isWritableSourcePath(testWorkDir, "migrations/001_initial.ts")).toBe(true);
    expect(isWritableSourcePath(testWorkDir, "src/nested/module.ts")).toBe(true);

    // Tests are strictly immutable
    expect(isWritableSourcePath(testWorkDir, "test/rate-limiter.test.ts")).toBe(false);
    expect(isWritableSourcePath(testWorkDir, "test-hidden/hidden.test.ts")).toBe(false);
    expect(isWritableSourcePath(testWorkDir, "package.json")).toBe(false);
    expect(isWritableSourcePath(testWorkDir, "src/../test/rate-limiter.test.ts")).toBe(false);
  });

  it("executeAgenticTool enforces immutable test boundaries and flags policy violations", () => {
    if (existsSync(testWorkDir)) rmSync(testWorkDir, { recursive: true, force: true });
    mkdirSync(join(testWorkDir, "src"), { recursive: true });
    mkdirSync(join(testWorkDir, "test"), { recursive: true });

    const changedFiles = new Set<string>();
    const prohibitedFiles = new Set<string>();

    // Allowed write in src/
    const res1 = executeAgenticTool(
      testWorkDir,
      "test/sample.test.ts",
      "write_file",
      { path: "src/sample.ts", content: "export const ok = true;" },
      changedFiles,
      prohibitedFiles
    );
    expect(res1.success).toBe(true);
    expect(changedFiles.has("src/sample.ts")).toBe(true);
    expect(prohibitedFiles.size).toBe(0);

    // Prohibited write to test/
    const res2 = executeAgenticTool(
      testWorkDir,
      "test/sample.test.ts",
      "write_file",
      { path: "test/sample.test.ts", content: "export const tampered = true;" },
      changedFiles,
      prohibitedFiles
    );
    expect(res2.success).toBe(false);
    expect(res2.prohibitedWrite).toBe(true);
    expect(prohibitedFiles.has("test/sample.test.ts")).toBe(true);

    rmSync(testWorkDir, { recursive: true, force: true });
  });
});

describe("CP7.2 Failure Classification & Outcome Evaluation", () => {
  it("classifies HTTP and network errors correctly", () => {
    expect(classifyHttpFailure(400)).toBe("4XX_CLIENT_ERROR");
    expect(classifyHttpFailure(401)).toBe("4XX_CLIENT_ERROR");
    expect(classifyHttpFailure(429)).toBe("429_QUOTA");
    expect(classifyHttpFailure(500)).toBe("5XX_PROVIDER");
    expect(classifyHttpFailure(503)).toBe("5XX_PROVIDER");
    expect(classifyHttpFailure(0, new Error("fetch failed"))).toBe("NETWORK_PROVIDER");
  });

  it("classifies agentic outcomes: requires both public and hidden tests to pass", () => {
    // Both pass -> success
    const out1 = classifyAgenticOutcome({
      sessionTimedOut: false,
      truncated: false,
      publicTestsPassed: true,
      hiddenTestsPassed: true
    });
    expect(out1.success).toBe(true);
    expect(out1.failureClass).toBeUndefined();

    // Public passes, hidden fails -> TEST_FAILURE
    const out2 = classifyAgenticOutcome({
      sessionTimedOut: false,
      truncated: false,
      publicTestsPassed: true,
      hiddenTestsPassed: false
    });
    expect(out2.success).toBe(false);
    expect(out2.failureClass).toBe("TEST_FAILURE");

    // Timeout takes precedence
    const out3 = classifyAgenticOutcome({
      sessionTimedOut: true,
      truncated: false,
      publicTestsPassed: true,
      hiddenTestsPassed: true
    });
    expect(out3.success).toBe(false);
    expect(out3.failureClass).toBe("TIMEOUT");

    // Policy violation takes highest precedence
    const out4 = classifyAgenticOutcome({
      sessionTimedOut: false,
      truncated: false,
      publicTestsPassed: true,
      hiddenTestsPassed: true,
      policyViolated: true
    });
    expect(out4.success).toBe(false);
    expect(out4.failureClass).toBe("POLICY_VIOLATION");
  });
});

describe("CP7.2 Resumable Execution & Persistence", () => {
  const testRawDir = resolve("tmp/test-cp7-2-raw");

  it("writes atomically and validates attempts", () => {
    if (existsSync(testRawDir)) rmSync(testRawDir, { recursive: true, force: true });
    mkdirSync(testRawDir, { recursive: true });

    const filePath = join(testRawDir, "A1_gemini_high_attempt-1.json");
    const record = {
      caseId: "A1",
      candidate: "gemini_high",
      timestamp: new Date().toISOString(),
      success: true
    };

    writeAtomicJson(filePath, record);
    expect(existsSync(filePath)).toBe(true);
    expect(isValidAttempt(record)).toBe(true);

    const map = loadResumeAttempts(testRawDir);
    expect(map.has("A1:gemini_high")).toBe(true);

    const skipResult = shouldSkipCaseCandidate({
      isResume: true,
      caseId: "A1",
      candidateAlias: "gemini_high",
      resumeMap: map
    });
    expect(skipResult).not.toBeNull();
    expect(skipResult.success).toBe(true);

    rmSync(testRawDir, { recursive: true, force: true });
  });
});

describe("CP7.2 Predefined Promotion Gate Logic", () => {
  it("recommends PROMOTE_TO_AGENTIC_EXECUTOR when all Criteria A-H pass", () => {
    const geminiSummary = {
      completed: 7,
      attempted: 12,
      hiddenTestSuccessCount: 7,
      regressions: 0,
      timeouts: 0,
      toolCalls: 50,
      failedToolCalls: 2,
      medianIterations: 5,
      medianWallClockMs: 25000
    };

    const sonnetSummary = {
      completed: 10, // +3 over Gemini (passes Criterion A)
      attempted: 12,
      hiddenTestSuccessCount: 10, // 83.3% >= 58.3% (passes Criterion B)
      regressions: 0, // <= Gemini (passes Criterion C)
      timeouts: 0, // 0% <= 10% (passes Criterion D)
      toolCalls: 45,
      failedToolCalls: 1, // <= Gemini (passes Criterion E)
      medianIterations: 4, // <= Gemini (passes Criterion F)
      medianWallClockMs: 22000 // faster than Gemini (passes Criterion G)
    };

    const familyOutcomes: Record<string, { winner: string }> = {
      BUG_DIAGNOSIS_AND_REPAIR: { winner: "SONNET" },
      MULTI_FILE_FEATURE_IMPLEMENTATION: { winner: "SONNET" },
      REFACTOR_UNDER_CONSTRAINTS: { winner: "TIE" },
      FAILURE_RECOVERY: { winner: "SONNET" },
      DATA_CONCURRENCY_MIGRATION: { winner: "GEMINI" },
      REPOSITORY_SCALE_MAINTENANCE: { winner: "SONNET" }
    };

    const result = evaluatePromotionGate(geminiSummary, sonnetSummary, familyOutcomes);
    expect(result.gatePassed).toBe(true);
    expect(result.decision).toBe("PROMOTE_TO_AGENTIC_EXECUTOR");
  });

  it("rejects promotion if Criterion A (+2 completion delta) is not met", () => {
    const geminiSummary = {
      completed: 8,
      attempted: 12,
      hiddenTestSuccessCount: 8,
      regressions: 0,
      timeouts: 0,
      toolCalls: 50,
      failedToolCalls: 2,
      medianIterations: 5,
      medianWallClockMs: 25000
    };

    const sonnetSummary = {
      completed: 9, // only +1 over Gemini -> fails Criterion A!
      attempted: 12,
      hiddenTestSuccessCount: 9,
      regressions: 0,
      timeouts: 0,
      toolCalls: 45,
      failedToolCalls: 1,
      medianIterations: 4,
      medianWallClockMs: 22000
    };

    const familyOutcomes = {
      BUG_DIAGNOSIS_AND_REPAIR: { winner: "SONNET" },
      MULTI_FILE_FEATURE_IMPLEMENTATION: { winner: "TIE" },
      REFACTOR_UNDER_CONSTRAINTS: { winner: "TIE" },
      FAILURE_RECOVERY: { winner: "TIE" },
      DATA_CONCURRENCY_MIGRATION: { winner: "TIE" },
      REPOSITORY_SCALE_MAINTENANCE: { winner: "TIE" }
    };

    const result = evaluatePromotionGate(geminiSummary, sonnetSummary, familyOutcomes);
    expect(result.gatePassed).toBe(false);
    expect(result.decision).toBe("SPECIALIST_ONLY");
  });
});
