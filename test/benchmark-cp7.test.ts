import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import {
  isPathInside,
  executeAgenticTool,
  evaluateArchitecture,
  evaluatePRD,
  evaluateReasoning,
  isAgenticSessionWithinDeadline,
  classifyAgenticOutcome,
  classifyHttpFailure,
  canonicalizeAttempts
} from "../scripts/benchmark-cp7.js"; // or .ts via tsx/vitest


describe("CP7 Agentic Session Deadline", () => {
  it("rejects an agentic session at the eight-minute wall-clock limit", () => {
    const start = 1_000_000;
    expect(isAgenticSessionWithinDeadline(start, start + 479_999)).toBe(true);
    expect(isAgenticSessionWithinDeadline(start, start + 480_000)).toBe(false);
  });
});

describe("CP7 Benchmark Harness Security & Scoring Discipline", () => {
  const testWorkDir = resolve("tmp/test-cp7-workdir");

  describe("Path Containment (isPathInside)", () => {
    it("allows paths strictly inside workDir", () => {
      expect(isPathInside(testWorkDir, "src/index.ts")).toBe(true);
      expect(isPathInside(testWorkDir, "test/test.ts")).toBe(true);
      expect(isPathInside(testWorkDir, ".")).toBe(true);
      expect(isPathInside(testWorkDir, "a/b/c/d.ts")).toBe(true);
    });

    it("rejects path traversal attempts escaping workDir", () => {
      expect(isPathInside(testWorkDir, "../sibling")).toBe(false);
      expect(isPathInside(testWorkDir, "../../etc/passwd")).toBe(false);
      expect(isPathInside(testWorkDir, resolve("tmp/test-cp7-workdir-sibling"))).toBe(false);
    });

    it("rejects prefix-sharing sibling paths", () => {
      // Sibling that begins with the same prefix string but is outside
      const sibling = resolve("tmp/test-cp7-workdir-other");
      expect(isPathInside(testWorkDir, sibling)).toBe(false);
    });
  });

  describe("Agentic Tool Restrictions (executeAgenticTool)", () => {
    const workDir = resolve("tmp/test-agentic-tool-workdir");

    it("restricts write_file to src/ and assigned test target", () => {
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
      mkdirSync(join(workDir, "src"), { recursive: true });
      const changedFiles = new Set<string>();

      // Allowed write in src/
      const res1 = executeAgenticTool(workDir, "test/foo.test.ts", "write_file", {
        path: "src/foo.ts",
        content: "export const x = 1;"
      }, changedFiles);
      expect(res1.success).toBe(true);
      expect(changedFiles.has("src/foo.ts")).toBe(true);

      // Denied write to package.json
      const res2 = executeAgenticTool(workDir, "test/foo.test.ts", "write_file", {
        path: "package.json",
        content: "{}"
      }, changedFiles);
      expect(res2.success).toBe(false);
      expect(res2.result).toContain("restricted");

      // Denied writes to public tests so candidates cannot tamper with scoring.
      const res3 = executeAgenticTool(workDir, "test/foo.test.ts", "write_file", {
        path: "test/foo.test.ts",
        content: "test tampering"
      }, changedFiles);
      expect(res3.success).toBe(false);
      expect(res3.result).toContain("immutable");

      // A src/ prefix cannot bypass the immutable test boundary via traversal.
      const res4 = executeAgenticTool(workDir, "test/foo.test.ts", "write_file", {
        path: "src/../test/foo.test.ts",
        content: "test tampering"
      }, changedFiles);
      expect(res4.success).toBe(false);
      expect(res4.result).toContain("immutable");

      // Denied write outside workDir
      const res5 = executeAgenticTool(workDir, "test/foo.test.ts", "write_file", {
        path: "../escaped.ts",
        content: "malicious"
      }, changedFiles);
      expect(res5.success).toBe(false);

      rmSync(workDir, { recursive: true, force: true });
    });
  });

  describe("Qualitative Scoring Discipline (0/1/2 Rubric)", () => {
    it("scores 0 for absent dimensions in Architecture", () => {
      const caseItem = {
        rubric: {
          dimensions: ["durability_guarantee", "queueing_and_backpressure", "security_and_encryption"]
        }
      };
      // Minimal output mentioning only queue
      const output = "We use a message queue for buffers.";
      const res = evaluateArchitecture(output, caseItem);

      expect(res.dimensions["durability_guarantee"]).toBe(0);
      expect(res.dimensions["queueing_and_backpressure"]).toBe(1);
      expect(res.dimensions["security_and_encryption"]).toBe(0);
      expect(res.score).toBe(1);
      expect(res.passed).toBe(false);
    });

    it("scores 0 for absent dimensions in PRD", () => {
      const caseItem = {
        rubric: {
          dimensions: ["problem_clarity_and_opportunity", "nfr_completeness", "non_goals_discipline"]
        }
      };
      const output = "The problem statement is that users cannot export data.";
      const res = evaluatePRD(output, caseItem);

      expect(res.dimensions["problem_clarity_and_opportunity"]).toBe(2);
      expect(res.dimensions["nfr_completeness"]).toBe(0);
      expect(res.dimensions["non_goals_discipline"]).toBe(0);
      expect(res.score).toBe(2);
      expect(res.passed).toBe(false);
    });
  });

  describe("Failure classification and attempt aggregation", () => {
    it("classifies client, quota, provider, timeout, and harness failures separately", () => {
      expect(classifyHttpFailure(400)).toBe("4XX_CLIENT_ERROR");
      expect(classifyHttpFailure(401)).toBe("4XX_CLIENT_ERROR");
      expect(classifyHttpFailure(429)).toBe("429_QUOTA");
      expect(classifyHttpFailure(503)).toBe("5XX_PROVIDER");
      expect(classifyHttpFailure(0, new Error("fetch failed"))).toBe("NETWORK_PROVIDER");
    });

    it("never records an agentic timeout as successful", () => {
      expect(classifyAgenticOutcome({
        sessionTimedOut: true,
        truncated: false,
        publicTestsPassed: true,
        hiddenTestsPassed: true
      })).toEqual({ success: false, failureClass: "TIMEOUT" });
    });

    it("never records truncated output as successful", () => {
      expect(classifyAgenticOutcome({
        sessionTimedOut: false,
        truncated: true,
        publicTestsPassed: true,
        hiddenTestsPassed: true
      })).toEqual({ success: false, failureClass: "TRUNCATION" });
    });

    it("keeps only the latest attempt for each case and candidate", () => {
      const older = { caseId: "A1", candidate: "gemini_high", timestamp: "2026-09-14T00:00:00.000Z" } as any;
      const newer = { caseId: "A1", candidate: "gemini_high", timestamp: "2026-09-14T00:01:00.000Z" } as any;
      const other = { caseId: "A1", candidate: "sonnet_4_6", timestamp: "2026-09-14T00:00:00.000Z" } as any;
      expect(canonicalizeAttempts([
        { file: "A1_gemini_high_attempt-1.json", result: older },
        { file: "A1_gemini_high_attempt-2.json", result: newer },
        { file: "A1_sonnet_4_6_attempt-1.json", result: other }
      ])).toEqual([other, newer]);
    });
  });

  describe("Reasoning Trap & Invariant Evaluation", () => {
    it("fails trap avoidance when omitting the schema check constraint in R1", () => {
      const caseItem = {
        rubric: {
          invariants: [
            "Specifies database CHECK constraint `CONSTRAINT check_sufficient_balance CHECK (balance >= reserved)` as the ultimate defense-in-depth"
          ],
          traps: [
            "Omitting the schema CHECK constraint"
          ]
        }
      };
      // Output that completely omits CHECK constraint
      const outputWithoutCheck = "We use SELECT FOR UPDATE on the user_wallets row and verify balance in app code.";
      const res = evaluateReasoning(outputWithoutCheck, caseItem);

      expect(res.satisfiedInvariants).toBe(0);
      expect(res.avoidedTraps).toBe(0);
      expect(res.trapResults[0].avoided).toBe(false);
      expect(res.passed).toBe(false);
    });

    it("passes trap avoidance when schema check constraint is specified in R1", () => {
      const caseItem = {
        rubric: {
          invariants: [
            "Specifies database CHECK constraint `CONSTRAINT check_sufficient_balance CHECK (balance >= reserved)` as the ultimate defense-in-depth"
          ],
          traps: [
            "Omitting the schema CHECK constraint"
          ]
        }
      };
      const outputWithCheck = "We add CONSTRAINT check_sufficient_balance CHECK (balance >= reserved) to enforce balance invariants.";
      const res = evaluateReasoning(outputWithCheck, caseItem);

      expect(res.satisfiedInvariants).toBe(1);
      expect(res.avoidedTraps).toBe(1);
      expect(res.trapResults[0].avoided).toBe(true);
      expect(res.passed).toBe(true);
    });

    it("requires positive evidence for every corpus trap and does not punish warnings", () => {
      const caseItem = {
        rubric: {
          invariants: [],
          traps: [
            "Fulfilling order before durable commit of event processing record",
            "Adding NOT NULL column without default in older Postgres or locking table",
            "Dropping old column before all application replicas are running new code",
            "Only checking permission string without hierarchy and target-user ownership validation",
            "Returning HTTP 500 on duplicate webhook instead of HTTP 200 acknowledging receipt"
          ]
        }
      };
      const safe = "Do not fulfill before the durable database commit. Add nullable columns first, then validate a CHECK constraint. Drop the old column only after all replicas run the new code. Check hierarchy, target ownership, and tenant. Duplicate webhooks return HTTP 200; never HTTP 500.";
      const unsafe = "We fulfill the order before the database commit, add a NOT NULL column directly, drop the old column before replicas update, and only check the permission string. A duplicate should return HTTP 500.";

      expect(evaluateReasoning(safe, caseItem).passed).toBe(true);
      expect(evaluateReasoning(unsafe, caseItem).passed).toBe(false);
    });
  });
});
