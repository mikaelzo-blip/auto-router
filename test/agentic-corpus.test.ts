import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  evaluateAgenticShadow,
  createAgenticSessionStore,
  type AgenticEvaluationInput
} from "../src/agentic-shadow.js";

interface CorpusCase {
  id: string;
  category: string;
  prompt: string;
  expectedIntent: string;
  expectedWouldUseSonnet: boolean;
  expectedSignals?: string[];
  expectedExclusions?: string[];
  recentTestOutcome?: "passed" | "failed";
  recentFailure?: string;
  failureType?: "quality" | "infrastructure" | "timeout" | "429" | "5xx";
  toolsProvided?: boolean;
  sessionId?: string;
  claudeQuotaStatus?: any;
  claudeQuotaRatio?: number;
}

describe("CP7.3 Agentic Routing Corpus Validation (48 Balanced Cases)", async () => {
  const corpusPath = resolve("benchmark/cp7-3/agentic-routing-corpus.json");
  const rawData = await readFile(corpusPath, "utf8");
  const cases: CorpusCase[] = JSON.parse(rawData);
  const sessionStore = createAgenticSessionStore(120_000);

  it("contains at least 40 balanced cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  for (const tc of cases) {
    it(`evaluates case ${tc.id} (${tc.category}): wouldUseSonnet=${tc.expectedWouldUseSonnet}`, () => {
      const input: AgenticEvaluationInput = {
        sessionId: tc.sessionId,
        messages: [{ role: "user", content: tc.prompt }],
        recentTestOutcome: tc.recentTestOutcome,
        recentFailure: tc.recentFailure,
        failureType: tc.failureType,
        toolsProvided: tc.toolsProvided,
        claudeQuotaStatus: tc.claudeQuotaStatus ?? "healthy",
        claudeQuotaRatio: tc.claudeQuotaRatio ?? 0.85
      };

      const decision = evaluateAgenticShadow(
        input,
        "gemini-flash-high",
        "ag/gemini-3.8-flash-high",
        sessionStore
      );

      expect(decision.wouldUseSonnet).toBe(tc.expectedWouldUseSonnet);

      if (tc.expectedSignals) {
        for (const sig of tc.expectedSignals) {
          expect(decision.agenticSignals).toContain(sig);
        }
      }

      if (tc.expectedExclusions) {
        for (const excl of tc.expectedExclusions) {
          expect(decision.agenticExclusions).toContain(excl);
        }
      }

      // Invariant: Production forward profile MUST NOT be Sonnet!
      expect(decision.actualProfile).not.toBe("sonnet-agentic");
    });
  }
});
