export type FailureCategory =
  | "QUALITY_FAILURE"
  | "INFRA_TIMEOUT"
  | "HTTP_429"
  | "HTTP_5XX"
  | "AUTH_FAILURE"
  | "MODEL_UNAVAILABLE"
  | "TOOL_FAILURE"
  | "HARNESS_ERROR"
  | "INVALID_RESPONSE";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface RubricDimensionResult {
  name: string;
  passed: boolean;
  score?: number;
  reason?: string;
}

export interface EvaluationResult {
  passed: boolean;
  score: number; // 0.0 - 1.0
  dimensions: RubricDimensionResult[];
  issues: string[];
  executablePass?: boolean;
}

export interface JudgeEvaluation {
  judgeModel: string;
  judgeRubric: string;
  judgeDecision: "PASS" | "FAIL";
  judgeScore: number;
  judgeReason: string;
}

export interface BenchmarkUnitKey {
  caseId: string;
  modelId: string;
  attempt: number;
}

export interface BenchmarkRecord {
  caseId: string;
  category: string;
  name: string;
  expectedFloor: string;
  modelId: string;
  attempt: number;
  timestamp: string;

  // Operational metrics
  httpStatus: number;
  elapsedMs: number;
  timeToFirstByteMs?: number;
  streamed: boolean;
  usage?: TokenUsage;

  // Outcome
  operationalSuccess: boolean;
  qualitySuccessWhenExecuted: boolean | null;
  passed: boolean; // Overall pass (operationalSuccess && qualitySuccessWhenExecuted)
  failureCategory?: FailureCategory;
  failureReason?: string;

  // Content snippet (sanitized)
  contentSnippet?: string;

  // Evaluation details
  evaluation?: EvaluationResult;
  judge?: JudgeEvaluation;
}

export interface BenchmarkFilterOptions {
  resume?: boolean;
  models?: string[];
  caseIds?: string[];
  categories?: string[];
  attempts?: number;
  timeoutMs?: number;
  outputPath?: string;
  judgeModel?: string;
}

export interface CandidateStats {
  modelId: string;
  attempts: number;
  operationalSuccesses: number;
  operationalFailures: number;
  operationalSuccessRate: number; // 0.0 - 1.0
  executedCount: number;
  qualityPasses: number;
  qualityFailures: number;
  qualitySuccessRateWhenExecuted: number; // 0.0 - 1.0
  failureBreakdown: Record<FailureCategory, number>;
  avgLatencyMs: number;
  avgTimeToFirstByteMs?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
}

export interface BenchmarkRunSummary {
  version: string;
  timestamp: string;
  totalRecords: number;
  uniqueCases: number;
  uniqueModels: number;
  overallOperationalSuccessRate: number;
  overallQualitySuccessRateWhenExecuted: number;
  candidateStats: Record<string, CandidateStats>;
  denominatorUniform: boolean;
  records: BenchmarkRecord[];
}
