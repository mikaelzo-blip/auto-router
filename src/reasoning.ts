import type { Complexity, ExecutionProfile, QualityTier, Risk, ShadowTaskType } from "./shadow-router.js";

export type CanonicalReasoningEffort = "minimal" | "low" | "medium" | "high" | "max";
export type ReasoningPolicy = "passthrough" | "auto" | "shadow";

export const EFFORT_LEVELS: readonly CanonicalReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "max"
] as const;

export interface ReasoningContext {
  taskType?: ShadowTaskType;
  complexity?: Complexity;
  risk?: Risk;
  recentFailure?: string;
  recentFailureCount?: number;
  failureType?: "quality" | "infrastructure" | "timeout" | "429" | "5xx";
  recentTestOutcome?: "passed" | "failed";
  recentToolOutcome?: "success" | "failure";
  promptText?: string;
  selectedProfile?: string;
}

export interface AutoReasoningResult {
  desired: CanonicalReasoningEffort;
  reasons: string[];
  escalationApplied: boolean;
  deescalationApplied: boolean;
}

export interface ClampResult {
  effective: CanonicalReasoningEffort;
  clamped: boolean;
  clampReason?: "clamped_to_min_supported" | "clamped_to_max_supported" | "unsupported_level_mapped";
}

export interface ResolvedReasoningDecision {
  policy: ReasoningPolicy;
  requestedReasoningEffort?: CanonicalReasoningEffort;
  desiredReasoningEffort: CanonicalReasoningEffort;
  effectiveReasoningEffort: CanonicalReasoningEffort;
  clamped: boolean;
  clampReason?: string;
  escalationApplied: boolean;
  deescalationApplied: boolean;
  reasons: string[];
  debugSummary: {
    policy: ReasoningPolicy;
    requested?: CanonicalReasoningEffort;
    desired: CanonicalReasoningEffort;
    effective: CanonicalReasoningEffort;
    clamped: boolean;
    reason: string[];
  };
}

export function normalizeReasoningEffort(value: unknown): CanonicalReasoningEffort | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase().replace(/[-_]/g, " ");
  if (clean === "minimal") return "minimal";
  if (clean === "low") return "low";
  if (clean === "medium") return "medium";
  if (clean === "high") return "high";
  if (clean === "extra high" || clean === "ultra" || clean === "max") return "max";
  return undefined;
}

export function clampReasoningEffort(
  desired: CanonicalReasoningEffort,
  profile: ExecutionProfile
): ClampResult {
  const supported = profile.supportedReasoningEfforts;
  if (!supported || supported.length === 0) {
    const fallback = profile.reasoningEffort ?? "medium";
    return {
      effective: fallback,
      clamped: fallback !== desired,
      clampReason: fallback !== desired ? "unsupported_level_mapped" : undefined
    };
  }

  if (supported.includes(desired)) {
    return { effective: desired, clamped: false };
  }

  const desiredIndex = EFFORT_LEVELS.indexOf(desired);
  const supportedIndices = supported
    .map((lvl) => ({ level: lvl, index: EFFORT_LEVELS.indexOf(lvl) }))
    .sort((a, b) => a.index - b.index);

  const minSupported = supportedIndices[0]!;
  const maxSupported = supportedIndices[supportedIndices.length - 1]!;

  if (desiredIndex > maxSupported.index) {
    return {
      effective: maxSupported.level,
      clamped: true,
      clampReason: "clamped_to_max_supported"
    };
  }

  if (desiredIndex < minSupported.index) {
    return {
      effective: minSupported.level,
      clamped: true,
      clampReason: "clamped_to_min_supported"
    };
  }

  // Pick closest supported index
  let closest = supportedIndices[0]!;
  let minDiff = Math.abs(desiredIndex - closest.index);
  for (let i = 1; i < supportedIndices.length; i++) {
    const diff = Math.abs(desiredIndex - supportedIndices[i]!.index);
    if (diff < minDiff) {
      minDiff = diff;
      closest = supportedIndices[i]!;
    }
  }

  return {
    effective: closest.level,
    clamped: true,
    clampReason: "unsupported_level_mapped"
  };
}

export function determineAutoReasoning(context: ReasoningContext): AutoReasoningResult {
  const reasons: string[] = [];
  let escalationApplied = false;
  let deescalationApplied = false;

  // 1. Baseline effort from complexity
  let baselineIndex: number;
  const complexity = context.complexity ?? "medium";
  switch (complexity) {
    case "trivial":
      baselineIndex = 0; // minimal
      reasons.push("trivial_complexity_baseline");
      break;
    case "low":
      baselineIndex = 1; // low
      reasons.push("low_complexity_baseline");
      break;
    case "medium":
      baselineIndex = 2; // medium
      reasons.push("medium_complexity_baseline");
      break;
    case "high":
      baselineIndex = 3; // high
      reasons.push("high_complexity_baseline");
      break;
    case "critical":
      baselineIndex = 4; // max
      reasons.push("critical_complexity_baseline");
      break;
    default:
      baselineIndex = 2;
      reasons.push("default_medium_baseline");
  }

  let currentLevelIndex = baselineIndex;

  // 2. Risk floor (Section 7)
  // Risk high -> minimum high (index 3)
  // Risk medium -> minimum medium (index 2)
  const risk = context.risk ?? "low";
  if (risk === "high") {
    if (currentLevelIndex < 3) {
      currentLevelIndex = 3;
      reasons.push("risk_floor_applied");
    }
  } else if (risk === "medium") {
    if (currentLevelIndex < 2) {
      currentLevelIndex = 2;
      reasons.push("risk_floor_applied");
    }
  }

  // 3. Failure-based reasoning escalation (Section 8)
  // Must NOT escalate for infrastructure failures (429, timeout, 5xx, infrastructure)
  const isInfraFailure =
    context.failureType === "infrastructure" ||
    context.failureType === "timeout" ||
    context.failureType === "429" ||
    context.failureType === "5xx";

  if (!isInfraFailure) {
    if (context.recentFailureCount !== undefined && context.recentFailureCount >= 2) {
      currentLevelIndex = 4; // max
      escalationApplied = true;
      reasons.push("repeated_quality_failure_escalation");
    } else if (
      context.recentTestOutcome === "failed" ||
      context.recentToolOutcome === "failure" ||
      Boolean(context.recentFailure)
    ) {
      // First ordinary failure: escalate by 1 level, up to max
      currentLevelIndex = Math.min(4, currentLevelIndex + 1);
      escalationApplied = true;
      reasons.push("quality_failure_escalation");
    }
  }

  // 4. De-escalation (Section 9)
  // If recent verification passed, permit de-escalation back to current step baseline
  if (context.recentTestOutcome === "passed") {
    deescalationApplied = true;
    reasons.push("verification_passed_deescalation");
    // Ensure we do not remain stuck in high/max if current step is low/trivial
    if (complexity === "trivial" || complexity === "low") {
      currentLevelIndex = Math.min(currentLevelIndex, baselineIndex);
    }
  }

  const desired = EFFORT_LEVELS[currentLevelIndex]!;
  return {
    desired,
    reasons,
    escalationApplied,
    deescalationApplied
  };
}

export function resolveReasoningDecision(options: {
  policy: ReasoningPolicy;
  clientEffort?: CanonicalReasoningEffort;
  autoDesired: CanonicalReasoningEffort;
  profile: ExecutionProfile;
  escalationApplied?: boolean;
  deescalationApplied?: boolean;
  reasons?: string[];
}): ResolvedReasoningDecision {
  const { policy, clientEffort, autoDesired, profile } = options;
  const reasons = options.reasons ? [...options.reasons] : [];

  let desired: CanonicalReasoningEffort;

  if (policy === "passthrough") {
    desired = clientEffort ?? profile.defaultReasoningEffort ?? profile.reasoningEffort ?? "medium";
    reasons.push("passthrough_policy");
  } else if (policy === "auto") {
    desired = autoDesired;
    reasons.push("auto_policy_authoritative");
  } else {
    // shadow mode
    desired = clientEffort ?? profile.defaultReasoningEffort ?? profile.reasoningEffort ?? "medium";
    reasons.push("shadow_policy_client_forwarded");
  }

  const clampResult = clampReasoningEffort(desired, profile);
  if (clampResult.clamped && clampResult.clampReason) {
    reasons.push(clampResult.clampReason);
  }

  return {
    policy,
    requestedReasoningEffort: clientEffort,
    desiredReasoningEffort: policy === "auto" ? autoDesired : desired,
    effectiveReasoningEffort: clampResult.effective,
    clamped: clampResult.clamped,
    clampReason: clampResult.clampReason,
    escalationApplied: Boolean(options.escalationApplied),
    deescalationApplied: Boolean(options.deescalationApplied),
    reasons,
    debugSummary: {
      policy,
      requested: clientEffort,
      desired: autoDesired,
      effective: clampResult.effective,
      clamped: clampResult.clamped,
      reason: reasons
    }
  };
}

export function applyReasoningToPayload<T extends Record<string, unknown>>(
  payload: T,
  effectiveEffort: CanonicalReasoningEffort
): T {
  const result: Record<string, unknown> = { ...payload };

  // Always ensure reasoning_effort is canonical and reasoning object is removed or not conflicting
  result.reasoning_effort = effectiveEffort;
  delete result.reasoning;

  return result as T;
}
