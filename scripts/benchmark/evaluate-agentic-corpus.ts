import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateAgenticShadow,
  createAgenticSessionStore,
  type AgenticEvaluationInput
} from "../../src/agentic-shadow.js";

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

async function run() {
  const corpusPath = resolve("benchmark/cp7-3/agentic-routing-corpus.json");
  const rawData = await readFile(corpusPath, "utf8");
  const cases: CorpusCase[] = JSON.parse(rawData);

  const sessionStore = createAgenticSessionStore(120_000);

  let trueAgenticCount = 0;
  let correctlyIdentifiedAgentic = 0;
  let nonAgenticCount = 0;
  let correctlyIdentifiedNonAgentic = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  const results: any[] = [];

  for (const tc of cases) {
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

    const isExpectedAgentic = tc.expectedWouldUseSonnet;
    const isActualAgentic = decision.wouldUseSonnet;

    if (isExpectedAgentic) {
      trueAgenticCount++;
      if (isActualAgentic) {
        correctlyIdentifiedAgentic++;
      } else {
        falseNegatives++;
      }
    } else {
      nonAgenticCount++;
      if (!isActualAgentic) {
        correctlyIdentifiedNonAgentic++;
      } else {
        falsePositives++;
      }
    }

    const passed = isExpectedAgentic === isActualAgentic;

    results.push({
      id: tc.id,
      category: tc.category,
      expectedWouldUseSonnet: isExpectedAgentic,
      actualWouldUseSonnet: isActualAgentic,
      agenticIntent: decision.agenticIntent,
      agenticSignals: decision.agenticSignals,
      agenticExclusions: decision.agenticExclusions,
      reason: decision.shadowAgenticReason,
      passed
    });
  }

  const falsePositiveRate = nonAgenticCount > 0 ? falsePositives / nonAgenticCount : 0;
  const falseNegativeRate = trueAgenticCount > 0 ? falseNegatives / trueAgenticCount : 0;

  const metrics = {
    totalCases: cases.length,
    trueAgenticCases: trueAgenticCount,
    correctlyIdentifiedAgentic,
    nonAgenticCases: nonAgenticCount,
    correctlyIdentifiedNonAgentic,
    falsePositives,
    falseNegatives,
    falsePositiveRate: Number((falsePositiveRate * 100).toFixed(2)),
    falseNegativeRate: Number((falseNegativeRate * 100).toFixed(2)),
    accuracyRate: Number((((correctlyIdentifiedAgentic + correctlyIdentifiedNonAgentic) / cases.length) * 100).toFixed(2)),
    results
  };

  console.log("=== CP7.3 AGENTIC ROUTING CORPUS EVALUATION ===");
  console.log(`Total Cases: ${metrics.totalCases}`);
  console.log(`TRUE_AGENTIC: ${metrics.trueAgenticCases}`);
  console.log(`CORRECTLY_IDENTIFIED: ${metrics.correctlyIdentifiedAgentic}`);
  console.log(`NON_AGENTIC: ${metrics.nonAgenticCases}`);
  console.log(`FALSE_POSITIVES: ${metrics.falsePositives}`);
  console.log(`FALSE_NEGATIVES: ${metrics.falseNegatives}`);
  console.log(`FALSE_POSITIVE_RATE: ${metrics.falsePositiveRate}%`);
  console.log(`FALSE_NEGATIVE_RATE: ${metrics.falseNegativeRate}%`);
  console.log(`ACCURACY_RATE: ${metrics.accuracyRate}%`);

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    console.error("FAILURES DETECTED:", failed);
    process.exit(1);
  } else {
    console.log("ALL 48 CORPUS CASES PASSED PERFECTLY (0 FALSE POSITIVES, 0 FALSE NEGATIVES)!");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
