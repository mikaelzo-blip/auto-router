import type { CandidateQuotaStatus } from "./quota/types.js";
import type { ChatMessage } from "./types.js";

export type AgenticIntentType =
  | "execution"
  | "planning"
  | "mixed_execution"
  | "mixed_planning"
  | "non_agentic";

export interface AgenticEvaluationInput {
  sessionId?: string;
  messages: Array<{ role: string; content?: string | unknown }>;
  currentIntent?: string;
  recentTestOutcome?: "passed" | "failed";
  recentFailure?: string;
  failureType?: "quality" | "infrastructure" | "timeout" | "429" | "5xx";
  toolsProvided?: boolean;
  claudeQuotaStatus?: CandidateQuotaStatus | "unavailable";
  claudeQuotaRatio?: number;
}

export interface ShadowAgenticDecision {
  actualProfile: string;
  actualModel: string;
  shadowAgenticEligible: boolean;
  shadowAgenticProfile: string;
  shadowAgenticModel: string;
  wouldUseSonnet: boolean;
  shadowAgenticReason: string;
  shadowAgenticConfidence: "high" | "medium" | "low";
  agenticIntent: AgenticIntentType;
  agenticSignals: string[];
  agenticExclusions: string[];
  claudeQuotaStatus?: CandidateQuotaStatus | "unavailable";
  claudeQuotaRatio?: number;
}

export interface AgenticSessionState {
  wasSonnet: boolean;
  lastIntent: AgenticIntentType;
  lastSeenAt: number;
}

export function createAgenticSessionStore(ttlMs = 120_000, maxSessions = 1000) {
  const store = new Map<string, AgenticSessionState>();
  return {
    ttlMs,
    get(id: string): AgenticSessionState | undefined {
      const entry = store.get(id);
      if (!entry || Date.now() - entry.lastSeenAt > ttlMs) {
        store.delete(id);
        return undefined;
      }
      return entry;
    },
    set(id: string, state: AgenticSessionState): void {
      for (const [k, v] of store) {
        if (Date.now() - v.lastSeenAt > ttlMs) store.delete(k);
      }
      if (store.size >= maxSessions && !store.has(id)) {
        store.delete(store.keys().next().value!);
      }
      store.set(id, state);
    }
  };
}

export type AgenticSessionStore = ReturnType<typeof createAgenticSessionStore>;

const words = (str: string) => str.normalize("NFKC").toLowerCase();

function extractLatestUserText(input: AgenticEvaluationInput): string {
  if (input.currentIntent) return words(input.currentIntent);
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const msg = input.messages[i];
    if (msg?.role === "user" && typeof msg.content === "string") {
      return words(msg.content);
    }
  }
  return "";
}

export function detectAgenticIntent(input: AgenticEvaluationInput): {
  intent: AgenticIntentType;
  signals: string[];
  exclusions: string[];
} {
  const text = extractLatestUserText(input);
  const signals: string[] = [];
  const exclusions: string[] = [];

  const isSummaryOrDocRequest = /\b(summariz[a-z]*|what changed|summary of|write documentation|add docs|document this)\b/.test(text);

  // 1. Positive Signals (Execution-Oriented Repository Work)
  if (/\b(multi[- ]file|multiple files|across several files|across multiple files|across files|several files in)\b/.test(text)) {
    signals.push("multi_file_implementation");
  }
  if (!isSummaryOrDocRequest && /\b(across (the )?(repository|repo|codebase)|repository[- ]wide|repo[- ]wide|codebase[- ]wide|across (api|database|db|tests|modules))\b/.test(text)) {
    signals.push("repo_wide_change");
  }
  if (/\b(implement (?:(?:the|this|an|approved)\s+)*(?:plan|architecture|design|spec|rfc)|execute (?:(?:the|this|an|approved)\s+)*(?:plan|design|architecture))\b/.test(text)) {
    signals.push("approved_plan_execution");
  }
  if (/\b(refactor (?:multiple|across|several)?\s*modules|cross[- ]module refactor|decouple modules|extract base|large(?:[- ]scale)? refactor|major refactor)\b/.test(text)) {
    signals.push("large_refactor_execution");
  }
  if (/\b(implement (?:(?:a|the|this|an|approved)\s+)*(?:safe\s+)?(?:schema\s+)?migration|migrate implementation|execute (?:(?:a|the|this|an|approved)\s+)*(?:safe\s+)?migration|migration implementation)\b/.test(text)) {
    signals.push("migration_implementation");
  }
  if (/\b(fix failing tests|fix broken tests|test[- ]fix[- ]test|test[- ]fix[- ]loop|run tests and fix|fix tests until green|tests are failing.*(?:fix|diagnose)|rerun tests until|tests until passing|run tests until (?:green|passing))\b/.test(text)) {
    signals.push("test_fix_loop");
  }
  if (/\b(diagnose and repair (?:the )?(?:repository|repo)|diagnose (?:the )?repo|investigate and repair|update implementation and verify|implement and verify all tests|implement.*run tests|implement.*verify all tests|implementation with verification)\b/.test(text)) {
    signals.push("implementation_with_verification");
  }
  if (/\b(cross[- ]module (?:bug|defect)|fix (?:the )?bug across|trace and fix across)\b/.test(text)) {
    signals.push("cross_module_bug_fix");
  }

  // 2. Exclusion Signals (Negative / Analytical / Local Filters)
  if (/\b(design (?:an? |the )?(?:[\w-]+\s+)*architecture|architecture design|system design|architect an?|design doc|architecture decision record|adr|architectural documentation|architecture evaluation)\b/.test(text)) {
    exclusions.push("architecture_design_only");
  }
  if (/\b(create (?:a |the )?prd|write (?:a |the )?prd|prd creation|product requirement|write (?:a )?spec(?:ification)?|create (?:a )?spec(?:ification)?|write (?:an? )?(?:implementation |migration )?plan)\b/.test(text)) {
    exclusions.push("prd_creation");
  }
  if (/^(?:explain|how does|what is|what does|why does|walk me through|tell me about|describe how|explain this)\b/.test(text.trim()) ||
      /\b(explain this race condition|explain why|explain how)\b/.test(text)) {
    exclusions.push("explanation");
  }
  if (/\b(review (?:this |the )?(?:repo|repository|codebase|pr|diff|implementation|code)|audit (?:this |the )?(?:file|repo|repository|codebase|code)|critique this)\b/.test(text)) {
    exclusions.push("code_review_only");
  }
  if (/\b(fix typo|rename variable|one line|small edit|isolated change|update (?:the )?readme|fix typo in readme)\b/.test(text)) {
    exclusions.push("small_isolated_edit");
  }
  if (/\b(how to sort|regex for|write a regex|regex to validate|write a function that takes|write (?:a |an )?(?:small )?snippet)\b/.test(text)) {
    exclusions.push("simple_code_question");
  }
  if (/\b(brainstorm|ideas for|suggest approaches|propose alternatives)\b/.test(text)) {
    exclusions.push("brainstorming");
  }
  if (/\b(compare|trade[- ]offs|pros and cons|vs\.|versus|differences between|general analysis|analytical evaluation)\b/.test(text) && signals.length === 0) {
    exclusions.push("general_reasoning");
  }
  if (/\b(latest developments|state of the art|sota|research papers|literature survey|research into|general research)\b/.test(text)) {
    exclusions.push("research");
  }
  if (isSummaryOrDocRequest && signals.length === 0) {
    exclusions.push("documentation_only");
  }
  if (/\b(format this|prettify|convert this to|reformat)\b/.test(text) && signals.length === 0) {
    exclusions.push("simple_transformation");
  }

  // 3. Mixed Prompt Dominant Intent Determination
  const hasPlanningExclusion = exclusions.some((e) =>
    ["architecture_design_only", "prd_creation", "explanation", "code_review_only", "brainstorming", "general_reasoning"].includes(e)
  );
  const hasImplementationMention = /\b(implement|implementation|codebase|repo)\b/.test(text);
  const hasExecutionSignal = signals.length > 0;

  let intent: AgenticIntentType = "non_agentic";

  const explicitlyPlanOnly = /\b(do not write code|only (?:write |need )?(?:a )?plan|plan.*before (?:writing|modifying)|without modifying files|plan only)\b/.test(text);
  const explicitlyExecutes = /\b(then implement|and implement|implement it across|run tests until|verify all tests|implement.*verify)\b/.test(text);

  if ((hasPlanningExclusion && hasExecutionSignal) || (hasPlanningExclusion && hasImplementationMention && explicitlyPlanOnly)) {
    if (explicitlyPlanOnly) {
      intent = "mixed_planning";
    } else if (explicitlyExecutes || signals.length >= 2) {
      intent = "mixed_execution";
    } else {
      intent = "mixed_planning";
    }
  } else if (hasExecutionSignal) {
    intent = "execution";
  } else if (hasPlanningExclusion) {
    intent = "planning";
  } else if (isSummaryOrDocRequest) {
    intent = "non_agentic";
  } else {
    intent = "non_agentic";
  }

  return { intent, signals, exclusions };
}

export function evaluateAgenticShadow(
  input: AgenticEvaluationInput,
  actualProfile: string,
  actualModel: string,
  store?: AgenticSessionStore
): ShadowAgenticDecision {
  const { intent, signals, exclusions } = detectAgenticIntent(input);
  const text = extractLatestUserText(input);

  // Failure handling: Infrastructure failures do NOT trigger agentic routing
  const isInfraFailure =
    input.failureType === "infrastructure" ||
    input.failureType === "timeout" ||
    input.failureType === "429" ||
    input.failureType === "5xx";

  const sessionState = input.sessionId && store ? store.get(input.sessionId) : undefined;
  const wasSonnet = Boolean(sessionState?.wasSonnet);

  // Check de-escalation: Passing tests or summary/docs intent resets sticky Sonnet
  const isDeEscalationIntent =
    input.recentTestOutcome === "passed" ||
    /\b(summariz[a-z]*|what changed|explain how|document(ation)?|write docs)\b/.test(text);

  let isStickySonnet = false;
  if (wasSonnet && !isDeEscalationIntent) {
    // Within an ongoing agentic loop: test failure, fix, rerun tests, follow-up change
    const isLoopContinuation =
      input.recentTestOutcome === "failed" ||
      Boolean(input.recentFailure && !isInfraFailure) ||
      /\b(test(s)? (failed|failing)|fix (it|the|this)|rerun|assertion|error in|now also update)\b/.test(text);

    if (isLoopContinuation) {
      isStickySonnet = true;
    }
  }

  // Quota eligibility gate for Claude Antigravity pool
  const quotaStatus = input.claudeQuotaStatus ?? "healthy";
  const quotaRatio = input.claudeQuotaRatio ?? 1.0;

  const quotaSuppressed =
    quotaStatus === "exhausted" ||
    quotaStatus === "reserve" ||
    quotaStatus === "unavailable" ||
    quotaRatio <= 0;

  // Decide agentic qualification
  // If user requested summary or de-escalation, Sonnet is NOT qualified.
  const qualifies =
    !isInfraFailure &&
    !isDeEscalationIntent &&
    (intent === "execution" || intent === "mixed_execution" || isStickySonnet) &&
    !quotaSuppressed;

  const wouldUseSonnet = qualifies;
  const shadowAgenticProfile = wouldUseSonnet ? "sonnet-agentic" : actualProfile;
  const shadowAgenticModel = wouldUseSonnet ? "ag/claude-sonnet-4-6" : actualModel;

  let shadowAgenticReason = "not_agentic_task";
  if (wouldUseSonnet) {
    if (isStickySonnet) {
      shadowAgenticReason = "agentic_loop_stickiness_recovery";
    } else if (intent === "mixed_execution") {
      shadowAgenticReason = "mixed_prompt_dominant_execution_verified";
    } else {
      shadowAgenticReason = signals.join("_");
    }
  } else if (quotaSuppressed && (intent === "execution" || intent === "mixed_execution" || isStickySonnet)) {
    shadowAgenticReason = `claude_quota_${quotaStatus}`;
  } else if (isDeEscalationIntent && wasSonnet) {
    shadowAgenticReason = "de_escalation_after_verification";
  } else if (exclusions.length > 0) {
    shadowAgenticReason = exclusions.join("_");
  }

  const confidence: "high" | "medium" | "low" = wouldUseSonnet
    ? signals.length >= 2 || isStickySonnet
      ? "high"
      : "medium"
    : exclusions.length >= 1
      ? "high"
      : "medium";

  // Update session store
  if (input.sessionId && store) {
    store.set(input.sessionId, {
      wasSonnet: wouldUseSonnet,
      lastIntent: intent,
      lastSeenAt: Date.now()
    });
  }

  return {
    actualProfile,
    actualModel,
    shadowAgenticEligible: wouldUseSonnet,
    shadowAgenticProfile,
    shadowAgenticModel,
    wouldUseSonnet,
    shadowAgenticReason,
    shadowAgenticConfidence: confidence,
    agenticIntent: intent,
    agenticSignals: signals,
    agenticExclusions: exclusions,
    claudeQuotaStatus: quotaStatus,
    claudeQuotaRatio: quotaRatio
  };
}
