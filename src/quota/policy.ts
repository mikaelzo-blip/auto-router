import type { ExecutionProfile, QualityTier, ShadowTaskType, Complexity, Risk } from "../shadow-router.js";
import type {
  CandidateQuotaState,
  CandidateQuotaStatus,
  QuotaBucket,
  QuotaConfig,
  QuotaDecision,
  QuotaPolicy,
  QuotaSnapshot,
  QuotaThresholds
} from "./types.js";
import type { QuotaCooldownTracker } from "./cooldown.js";

const TIERS: QualityTier[] = ["cheap", "balanced", "strong", "frontier"];

export const DEFAULT_QUOTA_THRESHOLDS: QuotaThresholds = {
  healthyMin: 0.30, // > 30%
  conserveMin: 0.10, // > 10% and <= 30%
  conserveExit: 0.25, // hysteresis exit back to healthy
  reserveExit: 0.12 // hysteresis exit back to conserve
};

export function getProfileProvider(profile: ExecutionProfile): string {
  if (profile.model.startsWith("ag/")) return "antigravity";
  if (profile.model.startsWith("cx/")) return "codex";
  return profile.model.split("/")[0] ?? "unknown";
}

export function getApplicableBucketIds(profile: ExecutionProfile): string[] {
  const provider = getProfileProvider(profile);
  if (provider === "antigravity") {
    return ["gemini_weekly"];
  }
  if (provider === "codex") {
    return ["codex_session", "codex_weekly"];
  }
  return [];
}

export function evaluateCandidateQuota(
  profile: ExecutionProfile,
  snapshot: QuotaSnapshot,
  cooldownTracker?: QuotaCooldownTracker,
  previousStatus?: CandidateQuotaStatus,
  thresholds: QuotaThresholds = DEFAULT_QUOTA_THRESHOLDS
): CandidateQuotaState {
  const provider = getProfileProvider(profile);
  const now = Date.now();
  const snapshotAgeMs = Math.max(0, now - snapshot.observedAt);
  const sourceFreshness = {
    snapshotAgeMs,
    stale: snapshot.stale
  };

  // 1. Check 429 cooldowns first (hard evidence)
  if (cooldownTracker) {
    const modelCooldown = cooldownTracker.isCooldownActive(profile.model, now);
    const providerCooldown = cooldownTracker.isCooldownActive(provider, now);
    const cooldown = modelCooldown.active ? modelCooldown : providerCooldown;

    if (cooldown.active) {
      if (cooldown.type === "quota_exhaustion") {
        return {
          status: "exhausted",
          effectiveRemainingRatio: 0.0,
          limitingBuckets: ["429_cooldown"],
          resetAt: cooldown.resetAt ?? null,
          sourceFreshness,
          reason: "429_quota_exhaustion"
        };
      }
    }
  }

  // 2. Check provider health
  const pHealth = snapshot.providerHealth[provider];
  if (pHealth === "unavailable") {
    // Note: Provider unavailable is infrastructure health, not quota exhaustion,
    // but candidate is unavailable. If no buckets exist, return unknown/exhausted
    return {
      status: "exhausted",
      effectiveRemainingRatio: 0.0,
      limitingBuckets: [`${provider}_unavailable`],
      resetAt: null,
      sourceFreshness,
      reason: "provider_unavailable"
    };
  }

  // 3. Find applicable buckets
  const bucketIds = getApplicableBucketIds(profile);
  const applicableBuckets: QuotaBucket[] = [];
  for (const id of bucketIds) {
    if (snapshot.buckets[id]) {
      applicableBuckets.push(snapshot.buckets[id]!);
    }
  }

  // If no bucket telemetry exists, fail open to unknown
  if (applicableBuckets.length === 0) {
    return {
      status: "unknown",
      effectiveRemainingRatio: 1.0,
      limitingBuckets: [],
      resetAt: null,
      sourceFreshness,
      reason: "no_telemetry"
    };
  }

  // 4. Calculate effective minimum remaining ratio among applicable buckets
  let minRatio = 1.0;
  for (const b of applicableBuckets) {
    if (b.remainingRatio < minRatio) {
      minRatio = b.remainingRatio;
    }
  }

  // Find limiting buckets matching minRatio
  const limitingBuckets: string[] = [];
  let limitingResetAt: string | null = null;
  for (const b of applicableBuckets) {
    if (Math.abs(b.remainingRatio - minRatio) < 0.001) {
      limitingBuckets.push(b.id);
      if (!limitingResetAt && b.resetAt) {
        limitingResetAt = b.resetAt;
      }
    }
  }

  // 5. Determine status with hysteresis
  let status: CandidateQuotaStatus;

  if (minRatio <= 0.0) {
    status = "exhausted";
  } else if (previousStatus === "conserve") {
    // To exit conserve to healthy, must exceed conserveExit (or healthyMin)
    const exitThreshold = thresholds.conserveExit ?? thresholds.healthyMin;
    if (minRatio > exitThreshold) {
      status = "healthy";
    } else if (minRatio <= thresholds.conserveMin) {
      status = "reserve";
    } else {
      status = "conserve";
    }
  } else if (previousStatus === "reserve") {
    // To exit reserve to conserve, must exceed reserveExit (or conserveMin)
    const exitThreshold = thresholds.reserveExit ?? thresholds.conserveMin;
    if (minRatio > thresholds.healthyMin) {
      status = "healthy";
    } else if (minRatio > exitThreshold) {
      status = "conserve";
    } else {
      status = "reserve";
    }
  } else {
    // Standard evaluation without previous status
    if (minRatio > thresholds.healthyMin) {
      status = "healthy";
    } else if (minRatio > thresholds.conserveMin) {
      status = "conserve";
    } else {
      status = "reserve";
    }
  }

  return {
    status,
    effectiveRemainingRatio: minRatio,
    limitingBuckets,
    resetAt: limitingResetAt,
    sourceFreshness
  };
}

export interface FilterRankOptions {
  taskType: ShadowTaskType;
  complexity: Complexity;
  risk: Risk;
  minimumQualityTier: QualityTier;
  requiredCapabilities: { tools: boolean; vision: boolean };
  profiles: ExecutionProfile[];
  snapshot: QuotaSnapshot;
  cooldownTracker?: QuotaCooldownTracker;
  policy: QuotaPolicy;
  previousCandidateStates?: Record<string, CandidateQuotaState>;
  thresholds?: QuotaThresholds;
}

export function filterAndRankWithQuota(options: FilterRankOptions): ExecutionProfile[] {
  const {
    taskType,
    complexity,
    risk,
    minimumQualityTier,
    requiredCapabilities,
    profiles,
    snapshot,
    cooldownTracker,
    policy,
    previousCandidateStates,
    thresholds = DEFAULT_QUOTA_THRESHOLDS
  } = options;

  // RULE 1: Enabled profiles only. Sol, Astra, Claude NEVER enabled if enabled: false!
  const enabled = profiles.filter((p) => p.enabled);

  // RULE 2: Hard capabilities
  const capFiltered = enabled.filter((p) => {
    if (requiredCapabilities.tools && !p.hardCapabilities.tools) return false;
    if (requiredCapabilities.vision && !p.hardCapabilities.vision) return false;
    return true;
  });

  // RULE 3: Semantic Quality Floor.
  // A candidate must have tier index >= minimumQualityTier index.
  // Higher-tier models CAN serve lower-tier tasks (Section 10), but lower-tier NEVER serves higher-tier!
  const minTierIndex = TIERS.indexOf(minimumQualityTier);
  const tierFiltered = capFiltered.filter((p) => TIERS.indexOf(p.qualityTier) >= minTierIndex);

  if (policy === "off") {
    return tierFiltered;
  }

  // RULE 4: Evaluate quota state for each candidate
  const candidateStates = new Map<string, CandidateQuotaState>();
  for (const p of tierFiltered) {
    const prevState = previousCandidateStates?.[p.id];
    const qState = evaluateCandidateQuota(p, snapshot, cooldownTracker, prevState?.status, thresholds);
    candidateStates.set(p.id, qState);
  }

  // RULE 5: Exclude exhausted candidates
  let available = tierFiltered.filter((p) => {
    const state = candidateStates.get(p.id);
    return state && state.status !== "exhausted";
  });

  if (available.length === 0) {
    return [];
  }

  // RULE 6: Reserve policy & Conservation
  const isRoutine = (taskType === "general" || taskType === "transformation") &&
    (complexity === "trivial" || complexity === "low" || complexity === "medium") &&
    risk === "low";

  const isHighRiskOrStrong = complexity === "high" || complexity === "critical" || risk !== "low" || minimumQualityTier === "strong" || minimumQualityTier === "frontier";

  if (isRoutine) {
    // Routine tasks should avoid reserve quota candidates if any healthy or conserve alternative exists
    const nonReserve = available.filter((p) => candidateStates.get(p.id)?.status !== "reserve");
    if (nonReserve.length > 0) {
      available = nonReserve;
    }
  }

  // RULE 7: Ranking
  return [...available].sort((a, b) => {
    const stateA = candidateStates.get(a.id)!;
    const stateB = candidateStates.get(b.id)!;

    // Status score: healthy (3) > conserve (2) > reserve (1) > unknown (2.5)
    const statusScore = (s: CandidateQuotaStatus) => {
      switch (s) {
        case "healthy": return 3;
        case "unknown": return 2.5;
        case "conserve": return 2;
        case "reserve": return 1;
        default: return 0;
      }
    };

    const scoreA = statusScore(stateA.status);
    const scoreB = statusScore(stateB.status);

    // If one is conserving/reserve and another is healthy/unknown on routine tasks, heavily favor healthy
    if (isRoutine && scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    // Task fit match bonus
    const aFits = a.taskFit.includes(taskType);
    const bFits = b.taskFit.includes(taskType);
    if (aFits !== bFits && (scoreA === scoreB || isHighRiskOrStrong)) {
      return aFits ? -1 : 1;
    }

    // Tier preference: prefer closest to minimum tier to avoid wasteful overprovisioning, unless lower is exhausted/conserved
    const aTierIndex = TIERS.indexOf(a.qualityTier);
    const bTierIndex = TIERS.indexOf(b.qualityTier);

    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    // Both have similar quota status: prefer closest tier
    const distA = Math.abs(aTierIndex - minTierIndex);
    const distB = Math.abs(bTierIndex - minTierIndex);
    if (distA !== distB) {
      return distA - distB;
    }

    return 0;
  });
}

export interface ResolveQuotaDecisionOptions {
  standardSelectedProfile?: string;
  taskType: ShadowTaskType;
  complexity: Complexity;
  risk: Risk;
  minimumQualityTier: QualityTier;
  requiredCapabilities: { tools: boolean; vision: boolean };
  profiles: ExecutionProfile[];
  snapshot: QuotaSnapshot;
  cooldownTracker?: QuotaCooldownTracker;
  quotaPolicy: QuotaPolicy;
  previousCandidateStates?: Record<string, CandidateQuotaState>;
  thresholds?: QuotaThresholds;
}

export interface QuotaDecisionResult extends QuotaDecision {
  selectedProfile?: string;
  selectedModel?: string;
}

export function resolveQuotaDecision(options: ResolveQuotaDecisionOptions): QuotaDecisionResult {
  const {
    standardSelectedProfile,
    taskType,
    complexity,
    risk,
    minimumQualityTier,
    requiredCapabilities,
    profiles,
    snapshot,
    cooldownTracker,
    quotaPolicy,
    previousCandidateStates,
    thresholds = DEFAULT_QUOTA_THRESHOLDS
  } = options;

  const now = Date.now();
  const snapshotAgeMs = Math.max(0, now - snapshot.observedAt);

  // Evaluate states for all profiles
  const candidateStates: Record<string, CandidateQuotaState> = {};
  for (const p of profiles) {
    candidateStates[p.id] = evaluateCandidateQuota(
      p,
      snapshot,
      cooldownTracker,
      previousCandidateStates?.[p.id]?.status,
      thresholds
    );
  }

  if (quotaPolicy === "off") {
    const stdProfile = standardSelectedProfile ? profiles.find((p) => p.id === standardSelectedProfile) : undefined;
    const stdState = stdProfile ? candidateStates[stdProfile.id] : undefined;

    return {
      policy: "off",
      status: stdState?.status ?? "unknown",
      effectiveRemainingRatio: stdState?.effectiveRemainingRatio ?? 1.0,
      limitingBuckets: stdState?.limitingBuckets ?? [],
      snapshotAgeMs,
      stale: snapshot.stale,
      selectionEffect: "quota_policy_off",
      candidateStates,
      selectedProfile: standardSelectedProfile,
      selectedModel: stdProfile?.model,
      wouldSwitch: false,
      switchReason: "none"
    };
  }

  // Filter and rank using quota-aware logic
  const quotaRanked = filterAndRankWithQuota({
    taskType,
    complexity,
    risk,
    minimumQualityTier,
    requiredCapabilities,
    profiles,
    snapshot,
    cooldownTracker,
    policy: "auto",
    previousCandidateStates,
    thresholds
  });

  const hypotheticalProfileObj = quotaRanked[0];
  const hypotheticalProfile = hypotheticalProfileObj?.id;
  const hypotheticalModel = hypotheticalProfileObj?.model;

  const stdProfileObj = standardSelectedProfile ? profiles.find((p) => p.id === standardSelectedProfile) : undefined;
  const stdState = stdProfileObj ? candidateStates[stdProfileObj.id] : undefined;

  let wouldSwitch = false;
  let switchReason = "none";
  let selectionEffect = "normal";

  if (!hypotheticalProfile) {
    // All candidates exhausted!
    wouldSwitch = Boolean(standardSelectedProfile);
    switchReason = "all_candidates_exhausted";
    selectionEffect = "no_eligible_candidate";
  } else if (standardSelectedProfile && hypotheticalProfile !== standardSelectedProfile) {
    wouldSwitch = true;
    if (stdState?.status === "exhausted") {
      switchReason = "quota_exhausted";
      selectionEffect = `avoided_exhausted_${standardSelectedProfile}`;
    } else if (stdState?.status === "reserve") {
      switchReason = "quota_reserve";
      selectionEffect = `conserved_reserve_${standardSelectedProfile}`;
    } else if (stdState?.status === "conserve") {
      switchReason = "quota_conserve";
      selectionEffect = `conserved_${standardSelectedProfile}_for_routine_task`;
    } else {
      switchReason = "quota_rebalance";
      selectionEffect = "quota_optimized";
    }
  } else if (stdState?.status === "reserve") {
    selectionEffect = "preserved_for_strong_task_in_reserve";
  } else if (stdState?.status === "conserve") {
    selectionEffect = "preserved_for_strong_task";
  }

  if (quotaPolicy === "shadow") {
    return {
      policy: "shadow",
      status: stdState?.status ?? "unknown",
      effectiveRemainingRatio: stdState?.effectiveRemainingRatio ?? 1.0,
      limitingBuckets: stdState?.limitingBuckets ?? [],
      snapshotAgeMs,
      stale: snapshot.stale,
      selectionEffect,
      candidateStates,
      selectedProfile: standardSelectedProfile,
      selectedModel: stdProfileObj?.model,
      hypotheticalProfile,
      hypotheticalModel,
      wouldSwitch,
      switchReason
    };
  }

  // quotaPolicy === "auto"
  const selectedState = hypotheticalProfileObj ? candidateStates[hypotheticalProfileObj.id] : undefined;

  return {
    policy: "auto",
    status: selectedState?.status ?? (quotaRanked.length === 0 ? "exhausted" : "unknown"),
    effectiveRemainingRatio: selectedState?.effectiveRemainingRatio ?? 0.0,
    limitingBuckets: selectedState?.limitingBuckets ?? [],
    snapshotAgeMs,
    stale: snapshot.stale,
    selectionEffect,
    candidateStates,
    selectedProfile: hypotheticalProfile,
    selectedModel: hypotheticalModel,
    wouldSwitch,
    switchReason
  };
}
