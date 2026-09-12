import type { EvaluationResult, RubricDimensionResult, JudgeEvaluation } from "./types.js";

export interface CorpusCaseRubric {
  type: string;
  mustContain?: string[];
  mustNotContain?: string[];
  keyCriteria: string[];
  maxWords?: number;
  executableInvariants?: Array<{
    name: string;
    description: string;
    validate: (codeOrText: string) => boolean;
  }>;
  reasoningDimensions?: Array<{
    name: string; // e.g. "required_invariant", "unsafe_behavior_rejected", "failure_boundary", "tradeoff_analysis"
    criterion: string;
    patterns: RegExp[];
  }>;
}

export interface CorpusCaseItem {
  caseId: string;
  category: string;
  name: string;
  expectedFloor: string;
  prompt: string;
  rubric: CorpusCaseRubric;
}

/**
 * Extracts code blocks from markdown if present; otherwise returns raw text.
 */
export function extractCode(text: string): string {
  const codeBlockRegex = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1]?.trim()) {
      blocks.push(match[1].trim());
    }
  }
  return blocks.length > 0 ? blocks.join("\n\n") : text;
}

/**
 * Deterministic rubric evaluator that replaces fragile single-keyword checks with semantic
 * invariant dimensions and executable validation.
 */
export function evaluateCaseOutput(c: CorpusCaseItem, output: string): EvaluationResult {
  const dimensions: RubricDimensionResult[] = [];
  const issues: string[] = [];
  const norm = output.toLowerCase();

  // 1. Check maxWords instruction compliance if specified
  if (c.rubric.maxWords) {
    const words = output.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    // Allow small 15% tolerance on word count limits
    const allowedMax = Math.ceil(c.rubric.maxWords * 1.15);
    const passed = wordCount <= allowedMax;
    dimensions.push({
      name: "instruction_compliance:word_count",
      passed,
      reason: passed
        ? `Word count ${wordCount} within limit ${c.rubric.maxWords}`
        : `Word count ${wordCount} exceeded limit ${c.rubric.maxWords}`
    });
    if (!passed) {
      issues.push(`Exceeded word limit (${wordCount} > ${c.rubric.maxWords})`);
    }
  }

  // 2. Must not contain (negative constraints - e.g. unsafe patterns, forbidden preamble)
  if (c.rubric.mustNotContain && c.rubric.mustNotContain.length > 0) {
    for (const term of c.rubric.mustNotContain) {
      const containsForbidden = norm.includes(term.toLowerCase());
      const passed = !containsForbidden;
      dimensions.push({
        name: `negative_constraint:${term}`,
        passed,
        reason: passed ? `Excluded forbidden pattern "${term}"` : `Contains forbidden pattern "${term}"`
      });
      if (!passed) {
        issues.push(`Contains forbidden pattern "${term}"`);
      }
    }
  }

  // 3. Structured invariant evaluation per category/case
  evaluateCaseSpecificInvariants(c, output, dimensions, issues);

  // 4. Keyword presence check (fallback/secondary invariant for specific identifiers)
  if (c.rubric.mustContain && c.rubric.mustContain.length > 0) {
    for (const term of c.rubric.mustContain) {
      // Check if term or equivalent semantic invariant exists
      const termLower = term.toLowerCase();
      let termMatched = norm.includes(termLower);

      // Semantic equivalence allowances:
      // "pre-stream" -> also matched by "before streaming", "prior to stream", "before emitting"
      if (!termMatched && termLower === "pre-stream") {
        termMatched = /before streaming|prior to stream|before sending bytes|before emitting|pre-flight/i.test(output);
      }
      // "for update" -> matched by row-level locking or FOR UPDATE
      if (!termMatched && termLower === "for update") {
        termMatched = /for update|row[- ]level lock|pessimistic lock/i.test(output);
      }

      dimensions.push({
        name: `invariant_term:${term}`,
        passed: termMatched,
        reason: termMatched ? `Found invariant "${term}"` : `Missing invariant "${term}"`
      });
      if (!termMatched) {
        issues.push(`Missing key concept: "${term}"`);
      }
    }
  }

  const totalDimensions = dimensions.length;
  const passedDimensions = dimensions.filter((d) => d.passed).length;
  const score = totalDimensions > 0 ? +(passedDimensions / totalDimensions).toFixed(2) : 1.0;

  // Pass threshold: at least 70% of dimensions passed and zero critical negative violations
  const hasNegativeViolation = dimensions.some((d) => d.name.startsWith("negative_constraint") && !d.passed);
  const passed = !hasNegativeViolation && (totalDimensions === 0 || score >= 0.70);

  return {
    passed,
    score,
    dimensions,
    issues
  };
}

function evaluateCaseSpecificInvariants(
  c: CorpusCaseItem,
  output: string,
  dimensions: RubricDimensionResult[],
  issues: string[]
): void {
  const norm = output.toLowerCase();

  switch (c.caseId) {
    case "case-a1": {
      // Conventional commit format
      const hasConventionalFormat = /^(feat|fix|docs|chore|refactor|test|perf|ci)(\([a-z0-9_.-]+\))?!?: .+/im.test(output);
      dimensions.push({
        name: "conventional_commit_syntax",
        passed: hasConventionalFormat,
        reason: hasConventionalFormat ? "Matches conventional commit format" : "Missing conventional commit prefix"
      });
      if (!hasConventionalFormat) issues.push("Does not follow conventional commit format");
      break;
    }

    case "case-b1": {
      // Null-safety invariant in getUser
      const handlesNull =
        /if\s*\(\s*!id|\bundefined\b|\bnull\b|typeof id !== ["']string["']|\.has\(id\)|users\?\.\[id\]/i.test(output);
      dimensions.push({
        name: "null_safety_guard",
        passed: handlesNull,
        reason: handlesNull ? "Contains null/undefined check for id" : "Missing null/undefined check for id"
      });
      if (!handlesNull) issues.push("Missing null/undefined check for id");
      break;
    }

    case "case-b2": {
      // ISO 8601 validation with Z suffix and calendar date check
      const checksZ = /endswith\(['"]z['"]\)|['"]z['"]|\.slice\(-1\) === ['"]z['"]|z\$/i.test(output);
      const checksDateParse = /date\.parse|new date|gettime|isnan/i.test(output);
      dimensions.push({
        name: "utc_z_suffix_check",
        passed: checksZ,
        reason: checksZ ? "Checks UTC 'Z' suffix" : "Missing UTC 'Z' suffix check"
      });
      dimensions.push({
        name: "calendar_validity_check",
        passed: checksDateParse,
        reason: checksDateParse ? "Validates calendar date parse" : "Missing calendar validity check"
      });
      if (!checksZ) issues.push("Missing UTC 'Z' suffix check");
      if (!checksDateParse) issues.push("Missing calendar validity check");
      break;
    }

    case "case-c2": {
      // Stream replay safety invariant
      const rejectsMidStreamReplay =
        /never replay|do not replay|cannot retry|prohibit.*replay|once.*emitted|after.*first byte/i.test(output);
      dimensions.push({
        name: "unsafe_behavior_rejected:mid_stream_replay",
        passed: rejectsMidStreamReplay,
        reason: rejectsMidStreamReplay ? "Explicitly prohibits mid-stream replay" : "Fails to reject mid-stream replay"
      });
      if (!rejectsMidStreamReplay) issues.push("Fails to reject mid-stream replay");
      break;
    }

    case "case-d1": {
      // TokenBucketRateLimiter
      const clampsCapacity = /math\.min|\bcapacity\b/i.test(output);
      const consumesTokens = /tokens\s*-=|\btokens\s*<|tokens\s*-\s*count/i.test(output);
      dimensions.push({
        name: "capacity_clamping",
        passed: clampsCapacity,
        reason: clampsCapacity ? "Clamps tokens to capacity" : "Missing capacity clamping"
      });
      dimensions.push({
        name: "token_consumption",
        passed: consumesTokens,
        reason: consumesTokens ? "Consumes tokens atomically" : "Missing token consumption"
      });
      break;
    }

    case "case-g1": {
      // Concurrency deadlock prevention
      const ordersLocks = /order by|least.*greatest|sort|id.*<|ascending/i.test(output);
      const usesRowLock = /select.*for update|for update|row[- ]level lock/i.test(output);
      dimensions.push({
        name: "consistent_lock_ordering",
        passed: ordersLocks,
        reason: ordersLocks ? "Enforces consistent lock ordering" : "Missing lock ordering strategy"
      });
      dimensions.push({
        name: "pessimistic_row_locking",
        passed: usesRowLock,
        reason: usesRowLock ? "Uses SELECT FOR UPDATE row locking" : "Missing FOR UPDATE locking"
      });
      if (!ordersLocks) issues.push("Missing lock ordering strategy to prevent deadlock");
      if (!usesRowLock) issues.push("Missing SELECT ... FOR UPDATE row locking");
      break;
    }

    case "case-g3": {
      // Sequence allocation race condition
      const explainsRace = /race condition|concurrent|simultaneous|same max|read committed/i.test(output);
      const providesSolutions = /sequence|for update|counter table|row[- ]level lock/i.test(output);
      dimensions.push({
        name: "race_window_explained",
        passed: explainsRace,
        reason: explainsRace ? "Explains race condition window" : "Fails to explain race window"
      });
      dimensions.push({
        name: "solutions_provided",
        passed: providesSolutions,
        reason: providesSolutions ? "Provides sequence or locked counter solution" : "Missing valid solutions"
      });
      if (!explainsRace) issues.push("Fails to explain why read committed isolation allows race window");
      if (!providesSolutions) issues.push("Missing PostgreSQL sequence or locked counter row solution");
      break;
    }

    case "case-h1": {
      // Architecture review of streaming proxy
      const mitigatesReplay = /replay|stream.*committed|first byte/i.test(output);
      const mitigatesMemory = /buffer|backpressure|pipe|unbounded/i.test(output);
      const mitigatesAuthLeak = /redact|scrub|auth|token|credential|leak/i.test(output);
      dimensions.push({
        name: "invariant:no_midstream_replay",
        passed: mitigatesReplay,
        reason: mitigatesReplay ? "Identifies midstream replay invariant" : "Missing replay invariant"
      });
      dimensions.push({
        name: "invariant:backpressure_buffering",
        passed: mitigatesMemory,
        reason: mitigatesMemory ? "Identifies backpressure/buffer invariant" : "Missing backpressure invariant"
      });
      dimensions.push({
        name: "invariant:credential_redaction",
        passed: mitigatesAuthLeak,
        reason: mitigatesAuthLeak ? "Identifies credential redaction invariant" : "Missing credential redaction invariant"
      });
      break;
    }

    case "case-i1": {
      // Financial reconciliation
      const identifiesDuplicate = /txn_104|duplicate/i.test(output);
      const identifiesDiscrepancy = /ord_b|6\.25|5\.00|fee/i.test(output);
      dimensions.push({
        name: "duplicate_detection",
        passed: identifiesDuplicate,
        reason: identifiesDuplicate ? "Identifies duplicate transaction TXN_104" : "Missed duplicate charge"
      });
      dimensions.push({
        name: "fee_discrepancy",
        passed: identifiesDiscrepancy,
        reason: identifiesDiscrepancy ? "Identifies ORD_B fee discrepancy" : "Missed fee discrepancy"
      });
      break;
    }
  }
}

/**
 * Secondary Judge Model execution.
 * Enforces rule: candidate model CANNOT judge itself.
 */
export async function runJudgeEvaluation(params: {
  candidateModel: string;
  judgeModel: string;
  c: CorpusCaseItem;
  candidateOutput: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<JudgeEvaluation> {
  const { candidateModel, judgeModel, c, candidateOutput, baseUrl, apiKey } = params;

  if (candidateModel === judgeModel) {
    throw new Error(`Judge Model Rule Violation: candidate '${candidateModel}' cannot judge itself`);
  }

  const judgePrompt = `You are an expert technical evaluator assessing an AI model output against strict criteria.

PROMPT GIVEN TO CANDIDATE:
"""
${c.prompt}
"""

CANDIDATE OUTPUT TO EVALUATE:
"""
${candidateOutput}
"""

EVALUATION CRITERIA:
${c.rubric.keyCriteria.map((crit, i) => `${i + 1}. ${crit}`).join("\n")}

Respond ONLY with a JSON object in this exact schema:
{
  "decision": "PASS" | "FAIL",
  "score": 0.0 to 1.0,
  "reason": "Clear concise explanation of why the output passes or fails"
}`;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: judgeModel,
        messages: [{ role: "user", content: judgePrompt }],
        max_tokens: 300,
        temperature: 0.0
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      return {
        judgeModel,
        judgeRubric: c.rubric.type,
        judgeDecision: "FAIL",
        judgeScore: 0.0,
        judgeReason: `Judge HTTP ${res.status}: ${await res.text()}`
      };
    }

    const data = (await res.json()) as any;
    const rawContent = data.choices?.[0]?.message?.content || "";
    const cleaned = rawContent.replace(/```(?:json)?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { decision: "PASS" | "FAIL"; score: number; reason: string };

    return {
      judgeModel,
      judgeRubric: c.rubric.type,
      judgeDecision: parsed.decision === "PASS" ? "PASS" : "FAIL",
      judgeScore: typeof parsed.score === "number" ? parsed.score : parsed.decision === "PASS" ? 1.0 : 0.0,
      judgeReason: parsed.reason || "Judge evaluation completed"
    };
  } catch (err: any) {
    return {
      judgeModel,
      judgeRubric: c.rubric.type,
      judgeDecision: "FAIL",
      judgeScore: 0.0,
      judgeReason: `Judge execution error: ${err.message}`
    };
  }
}
