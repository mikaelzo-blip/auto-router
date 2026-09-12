import type { FailureCategory, BenchmarkRecord, CandidateStats, BenchmarkRunSummary } from "./types.js";

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "QUALITY_FAILURE",
  "INFRA_TIMEOUT",
  "HTTP_429",
  "HTTP_5XX",
  "AUTH_FAILURE",
  "MODEL_UNAVAILABLE",
  "TOOL_FAILURE",
  "HARNESS_ERROR",
  "INVALID_RESPONSE"
] as const;

export function redactSensitiveData(text: string): string {
  if (!text) return "";
  return text
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]{8,}/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key[:=]\s*["']?)[a-zA-Z0-9_\-\.]{8,}(["']?)/gi, "$1[REDACTED]$2")
    .replace(/(sk-[a-zA-Z0-9_\-\.]{8,})/gi, "[REDACTED_API_KEY]")
    .replace(/(token[:=]\s*["']?)[a-zA-Z0-9_\-\.]{8,}(["']?)/gi, "$1[REDACTED]$2")
    .replace(/(password[:=]\s*["']?)[^"'\s]{4,}(["']?)/gi, "$1[REDACTED]$2");
}

export function makeUnitKey(caseId: string, modelId: string, attempt: number): string {
  return `${caseId}::${modelId}::${attempt}`;
}

export function parseUnitKey(key: string): { caseId: string; modelId: string; attempt: number } {
  const parts = key.split("::");
  if (parts.length !== 3) {
    throw new Error(`Invalid benchmark unit key: ${key}`);
  }
  return {
    caseId: parts[0]!,
    modelId: parts[1]!,
    attempt: Number(parts[2]!)
  };
}

export function classifyFailure(params: {
  status: number;
  errorMessage?: string;
  isTimeout?: boolean;
  content?: string;
  toolError?: boolean;
  harnessError?: boolean;
}): FailureCategory | null {
  const { status, errorMessage = "", isTimeout = false, content, toolError, harnessError } = params;

  if (harnessError) {
    return "HARNESS_ERROR";
  }

  if (toolError) {
    return "TOOL_FAILURE";
  }

  if (isTimeout || status === 504 || /timeout|etimedout|esockettimedout|aborterror/i.test(errorMessage)) {
    return "INFRA_TIMEOUT";
  }

  if (status === 429 || /rate limit|quota exceeded|too many requests|429/i.test(errorMessage)) {
    return "HTTP_429";
  }

  if (status === 401 || status === 403 || /unauthorized|api key|authentication|forbidden/i.test(errorMessage)) {
    return "AUTH_FAILURE";
  }

  if (
    status === 404 ||
    /model_not_found|model unavailable|model not found|does not exist|unsupported model/i.test(errorMessage)
  ) {
    return "MODEL_UNAVAILABLE";
  }

  if (status >= 500) {
    return "HTTP_5XX";
  }

  if (status === 200) {
    if (content === undefined || content === null || content.trim().length === 0) {
      return "INVALID_RESPONSE";
    }
    // HTTP 200 with content is not an operational failure
    return null;
  }

  if (status !== 0 && status !== 200) {
    return "HTTP_5XX";
  }

  // Network / connection / generic harness failures
  if (/econnrefused|enotfound|fetch failed|network error/i.test(errorMessage)) {
    return "HARNESS_ERROR";
  }

  return "HARNESS_ERROR";
}

export function buildCandidateStats(modelId: string, records: BenchmarkRecord[]): CandidateStats {
  const candidateRecords = records.filter((r) => r.modelId === modelId);
  const attempts = candidateRecords.length;

  let operationalSuccesses = 0;
  let operationalFailures = 0;
  let qualityPasses = 0;
  let qualityFailures = 0;
  let totalLatency = 0;
  let totalTtfb = 0;
  let ttfbCount = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalReasoning = 0;

  const failureBreakdown: Record<FailureCategory, number> = {
    QUALITY_FAILURE: 0,
    INFRA_TIMEOUT: 0,
    HTTP_429: 0,
    HTTP_5XX: 0,
    AUTH_FAILURE: 0,
    MODEL_UNAVAILABLE: 0,
    TOOL_FAILURE: 0,
    HARNESS_ERROR: 0,
    INVALID_RESPONSE: 0
  };

  for (const r of candidateRecords) {
    if (r.failureCategory) {
      failureBreakdown[r.failureCategory] = (failureBreakdown[r.failureCategory] || 0) + 1;
    }

    if (r.operationalSuccess) {
      operationalSuccesses++;
      totalLatency += r.elapsedMs;
      if (r.timeToFirstByteMs !== undefined && r.timeToFirstByteMs > 0) {
        totalTtfb += r.timeToFirstByteMs;
        ttfbCount++;
      }
      if (r.usage) {
        totalInput += r.usage.promptTokens;
        totalOutput += r.usage.completionTokens;
        totalReasoning += r.usage.reasoningTokens;
      }

      if (r.qualitySuccessWhenExecuted === true) {
        qualityPasses++;
      } else if (r.qualitySuccessWhenExecuted === false) {
        qualityFailures++;
      }
    } else {
      operationalFailures++;
    }
  }

  const executedCount = operationalSuccesses;
  const operationalSuccessRate = attempts > 0 ? operationalSuccesses / attempts : 0;
  const evaluatedForQuality = qualityPasses + qualityFailures;
  const qualitySuccessRateWhenExecuted = evaluatedForQuality > 0 ? qualityPasses / evaluatedForQuality : 0;

  return {
    modelId,
    attempts,
    operationalSuccesses,
    operationalFailures,
    operationalSuccessRate: +operationalSuccessRate.toFixed(4),
    executedCount,
    qualityPasses,
    qualityFailures,
    qualitySuccessRateWhenExecuted: +qualitySuccessRateWhenExecuted.toFixed(4),
    failureBreakdown,
    avgLatencyMs: executedCount > 0 ? Math.round(totalLatency / executedCount) : 0,
    avgTimeToFirstByteMs: ttfbCount > 0 ? Math.round(totalTtfb / ttfbCount) : undefined,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalReasoningTokens: totalReasoning
  };
}

export function summarizeBenchmarkRun(records: BenchmarkRecord[], targetCandidateCount?: number): BenchmarkRunSummary {
  const models = [...new Set(records.map((r) => r.modelId))];
  const cases = [...new Set(records.map((r) => r.caseId))];

  const candidateStats: Record<string, CandidateStats> = {};
  for (const model of models) {
    candidateStats[model] = buildCandidateStats(model, records);
  }

  // Denominator uniformity check: verify all candidates evaluated on the same case count
  const attemptCounts = models.map((m) => candidateStats[m]!.attempts);
  const firstCount = attemptCounts[0] ?? 0;
  const denominatorUniform =
    models.length > 0 &&
    attemptCounts.every((c) => c === firstCount) &&
    (targetCandidateCount === undefined || models.length === targetCandidateCount);

  let totalOpSuccess = 0;
  let totalExecuted = 0;
  let totalQualityPass = 0;

  for (const stat of Object.values(candidateStats)) {
    totalOpSuccess += stat.operationalSuccesses;
    totalExecuted += stat.executedCount;
    totalQualityPass += stat.qualityPasses;
  }

  const overallOperationalSuccessRate = records.length > 0 ? +(totalOpSuccess / records.length).toFixed(4) : 0;
  const overallQualitySuccessRateWhenExecuted =
    totalExecuted > 0 ? +(totalQualityPass / totalExecuted).toFixed(4) : 0;

  return {
    version: "cp3a-v1",
    timestamp: new Date().toISOString(),
    totalRecords: records.length,
    uniqueCases: cases.length,
    uniqueModels: models.length,
    overallOperationalSuccessRate,
    overallQualitySuccessRateWhenExecuted,
    candidateStats,
    denominatorUniform,
    records
  };
}
