import { describe, it, expect } from "vitest";
import {
  evaluateCandidateQuota,
  filterAndRankWithQuota,
  resolveQuotaDecision,
  getApplicableBucketIds,
  DEFAULT_QUOTA_THRESHOLDS
} from "../src/quota/policy.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";
import type { QuotaSnapshot, QuotaBucket } from "../src/quota/types.js";
import { QuotaCooldownTracker } from "../src/quota/cooldown.js";

function makeSnapshot(buckets: Record<string, Partial<QuotaBucket>> = {}): QuotaSnapshot {
  const fullBuckets: Record<string, QuotaBucket> = {};
  for (const [id, b] of Object.entries(buckets)) {
    fullBuckets[id] = {
      id,
      provider: b.provider ?? "antigravity",
      scope: b.scope ?? "weekly",
      used: b.used ?? 0,
      limit: b.limit ?? 1000,
      remaining: b.remaining ?? 1000,
      remainingRatio: b.remainingRatio ?? 1.0,
      resetAt: b.resetAt ?? "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: b.stale ?? false
    };
  }
  return {
    observedAt: Date.now(),
    buckets: fullBuckets,
    providerHealth: {
      antigravity: "healthy",
      codex: "healthy"
    },
    stale: false
  };
}

describe("Quota Policy Evaluation & Ranking", () => {
  const tracker = new QuotaCooldownTracker();

  it("1. evaluates healthy quota (> 30%)", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.85 }
    });
    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);
    expect(state.status).toBe("healthy");
    expect(state.effectiveRemainingRatio).toBe(0.85);
  });

  it("2. evaluates conserve quota (> 10% and <= 30%)", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.13 }
    });
    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);
    expect(state.status).toBe("conserve");
    expect(state.effectiveRemainingRatio).toBe(0.13);
  });

  it("3. evaluates reserve quota (> 0% and <= 10%)", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.05 }
    });
    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-high")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);
    expect(state.status).toBe("reserve");
    expect(state.effectiveRemainingRatio).toBe(0.05);
  });

  it("4. evaluates exhausted quota (<= 0%)", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.0 }
    });
    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);
    expect(state.status).toBe("exhausted");
    expect(state.effectiveRemainingRatio).toBe(0.0);
  });

  it("5. multi-bucket codex uses minimum usable remaining ratio", () => {
    const snapshot = makeSnapshot({
      codex_session: { provider: "codex", remainingRatio: 1.0, resetAt: "2026-09-14T13:00:00.000Z" },
      codex_weekly: { provider: "codex", remainingRatio: 0.22, resetAt: "2026-09-19T08:00:00.000Z" }
    });
    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "terra")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);
    expect(state.effectiveRemainingRatio).toBe(0.22);
    expect(state.status).toBe("conserve");
    expect(state.limitingBuckets).toContain("codex_weekly");
    expect(state.resetAt).toBe("2026-09-19T08:00:00.000Z");
  });

  it("6. multi-bucket short window restricts when short window is lower", () => {
    const snapshot = makeSnapshot({
      codex_session: { provider: "codex", remainingRatio: 0.05, resetAt: "2026-09-14T13:00:00.000Z" },
      codex_weekly: { provider: "codex", remainingRatio: 0.80, resetAt: "2026-09-19T08:00:00.000Z" }
    });
    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "terra")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);
    expect(state.effectiveRemainingRatio).toBe(0.05);
    expect(state.status).toBe("reserve");
    expect(state.limitingBuckets).toContain("codex_session");
    expect(state.resetAt).toBe("2026-09-14T13:00:00.000Z");
  });

  it("7. shared Gemini quota excludes Low, Medium, and High together when exhausted", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.0 }
    });
    const pLow = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
    const pMed = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
    const pHigh = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-high")!;

    expect(evaluateCandidateQuota(pLow, snapshot, tracker).status).toBe("exhausted");
    expect(evaluateCandidateQuota(pMed, snapshot, tracker).status).toBe("exhausted");
    expect(evaluateCandidateQuota(pHigh, snapshot, tracker).status).toBe("exhausted");
  });

  it("8. CX quota exhaustion excludes Terra", () => {
    const snapshot = makeSnapshot({
      codex_session: { provider: "codex", remainingRatio: 0.0 },
      codex_weekly: { provider: "codex", remainingRatio: 0.0 }
    });
    const pTerra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "terra")!;
    expect(evaluateCandidateQuota(pTerra, snapshot, tracker).status).toBe("exhausted");
  });

  it("9. unknown quota fails open", () => {
    const emptySnapshot: QuotaSnapshot = {
      observedAt: Date.now(),
      buckets: {},
      providerHealth: { antigravity: "healthy", codex: "healthy" },
      stale: false
    };
    const pLow = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
    const state = evaluateCandidateQuota(pLow, emptySnapshot, tracker);
    expect(state.status).toBe("unknown");
  });

  it("10. disabled Sol and Astra remain disabled even with 100% quota", () => {
    const snapshot = makeSnapshot({
      codex_session: { provider: "codex", remainingRatio: 1.0 },
      codex_weekly: { provider: "codex", remainingRatio: 1.0 }
    });
    const ranked = filterAndRankWithQuota({
      taskType: "general",
      complexity: "trivial",
      risk: "low",
      minimumQualityTier: "cheap",
      requiredCapabilities: { tools: true, vision: true },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      policy: "auto"
    });

    const solInRanked = ranked.find((p) => p.id === "sol");
    const astraInRanked = ranked.find((p) => p.id === "astra");
    expect(solInRanked).toBeUndefined();
    expect(astraInRanked).toBeUndefined();
  });

  it("11. quota pressure cannot make a specialist serve generic high-risk work", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.0 },
      codex_weekly: { provider: "codex", remainingRatio: 1.0 },
      codex_session: { provider: "codex", remainingRatio: 1.0 }
    });
    const profiles = DEFAULT_SHADOW_PROFILES.filter((profile) =>
      ["gemini-flash-high", "luna-review"].includes(profile.id)
    );

    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-high",
      taskType: "code",
      complexity: "high",
      risk: "high",
      minimumQualityTier: "strong",
      requiredCapabilities: { tools: true, vision: false },
      profiles,
      snapshot,
      cooldownTracker: tracker,
      quotaPolicy: "auto"
    });

    expect(decision.selectedProfile).toBeUndefined();
    expect(decision.selectionEffect).toBe("no_eligible_candidate");
  });

  it("12. quality floor is preserved when selecting models", () => {
    // Critical concurrency requires STRONG tier
    // Gemini High is exhausted, Gemini Low is healthy
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.0 },
      codex_weekly: { provider: "codex", remainingRatio: 1.0 },
      codex_session: { provider: "codex", remainingRatio: 1.0 }
    });

    const ranked = filterAndRankWithQuota({
      taskType: "code",
      complexity: "high",
      risk: "high",
      minimumQualityTier: "strong",
      requiredCapabilities: { tools: true, vision: true },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      policy: "auto"
    });

    // Cannot choose gemini-flash-low or medium because they are cheap/balanced, and also exhausted
    // Must choose Terra (strong)
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.id).toBe("terra");
    expect(ranked[0]?.qualityTier).toBe("strong");
  });

  it("12. higher-tier model (Terra) may serve lower-tier routine task when Gemini is exhausted", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.0 },
      codex_weekly: { provider: "codex", remainingRatio: 1.0 },
      codex_session: { provider: "codex", remainingRatio: 1.0 }
    });

    const ranked = filterAndRankWithQuota({
      taskType: "general",
      complexity: "trivial",
      risk: "low",
      minimumQualityTier: "cheap",
      requiredCapabilities: { tools: true, vision: true },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      policy: "auto"
    });

    // Routine task would normally pick gemini-flash-low, but Gemini is exhausted
    // Terra is eligible as emergency alternative!
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.id).toBe("terra");
  });

  it("13. conserve state penalizes routine consumption to prefer healthy alternative", () => {
    // Gemini is in conserve (15%), Codex/Terra is healthy (90%)
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.15 },
      codex_weekly: { provider: "codex", remainingRatio: 0.90 },
      codex_session: { provider: "codex", remainingRatio: 1.0 }
    });

    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-medium",
      taskType: "transformation",
      complexity: "low",
      risk: "low",
      minimumQualityTier: "balanced",
      requiredCapabilities: { tools: true, vision: true },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      quotaPolicy: "auto"
    });

    // In conserve for routine/transformation, routine task prefers Terra over conserving Gemini
    expect(decision.selectedProfile).toBe("terra");
    expect(decision.selectionEffect).toContain("conserv");
  });

  it("14. routine reserve use is preferable to a constrained resilience switch", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.09247579 },
      codex_weekly: { provider: "codex", remainingRatio: 0.22 },
      codex_session: { provider: "codex", remainingRatio: 1.0 }
    });
    const profiles = DEFAULT_SHADOW_PROFILES.filter((profile) =>
      ["gemini-flash-low", "terra"].includes(profile.id)
    );

    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-low",
      taskType: "transformation",
      complexity: "low",
      risk: "low",
      minimumQualityTier: "cheap",
      requiredCapabilities: { tools: false, vision: false },
      profiles,
      snapshot,
      cooldownTracker: tracker,
      quotaPolicy: "shadow"
    });

    expect(decision.selectedProfile).toBe("gemini-flash-low");
    expect(decision.hypotheticalProfile).toBe("gemini-flash-low");
    expect(decision.wouldSwitch).toBe(false);
    expect(decision.selectionEffect).toBe("no_beneficial_alternative");
    expect(decision.decisionReason).toBe("reserve_consumed_for_lack_of_valid_alternative");
  });

  it("15. normal coding does not migrate to constrained resilience capacity without justification", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.09 },
      codex_weekly: { provider: "codex", remainingRatio: 0.22 },
      codex_session: { provider: "codex", remainingRatio: 1.0 }
    });
    const profiles = DEFAULT_SHADOW_PROFILES.filter((profile) =>
      ["gemini-flash-medium", "terra"].includes(profile.id)
    );

    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-medium",
      taskType: "code",
      complexity: "medium",
      risk: "low",
      minimumQualityTier: "balanced",
      requiredCapabilities: { tools: true, vision: false },
      profiles,
      snapshot,
      cooldownTracker: tracker,
      quotaPolicy: "shadow"
    });

    expect(decision.hypotheticalProfile).toBe("gemini-flash-medium");
    expect(decision.wouldSwitch).toBe(false);
    expect(decision.selectionEffect).toBe("no_beneficial_alternative");
    expect(decision.decisionReason).toBe("reserve_consumed_for_lack_of_valid_alternative");
  });

  it("16. strong/high-risk task can consume reserve when justified", () => {
    // Gemini High is in reserve (5%), Terra is exhausted (0%)
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.05 },
      codex_weekly: { provider: "codex", remainingRatio: 0.0 },
      codex_session: { provider: "codex", remainingRatio: 0.0 }
    });

    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-high",
      taskType: "code",
      complexity: "high",
      risk: "high",
      minimumQualityTier: "strong",
      requiredCapabilities: { tools: true, vision: true },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      quotaPolicy: "auto"
    });

    // High risk / strong task retains Gemini High in reserve because no superior eligible healthy alternative exists
    expect(decision.selectedProfile).toBe("gemini-flash-high");
    expect(decision.selectionEffect).toContain("reserve");
  });

  it("15. no-eligible-candidate returns explicit safe status when all exhausted", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.0 },
      codex_weekly: { provider: "codex", remainingRatio: 0.0 },
      codex_session: { provider: "codex", remainingRatio: 0.0 }
    });

    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-medium",
      taskType: "general",
      complexity: "medium",
      risk: "low",
      minimumQualityTier: "balanced",
      requiredCapabilities: { tools: true, vision: true },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      quotaPolicy: "auto"
    });

    expect(decision.selectedProfile).toBeUndefined();
    expect(decision.status).toBe("exhausted");
    expect(decision.selectionEffect).toBe("no_eligible_candidate");
  });

  it("16. hysteresis prevents flapping around threshold", () => {
    // Starting in conserve with ratio 0.28 (was in conserve)
    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.28 }
    });

    // With previousStatus = "conserve", conserveExit = 0.30: 0.28 stays in conserve
    const state = evaluateCandidateQuota(profile, snapshot, tracker, "conserve", {
      ...DEFAULT_QUOTA_THRESHOLDS,
      healthyMin: 0.30,
      conserveMin: 0.10,
      conserveExit: 0.30
    });
    expect(state.status).toBe("conserve");
  });

  it("17. multi-window Gemini minimum bucket selection and resetAt propagation (short window lower)", () => {
    const snapshot = makeSnapshot({
      gemini_flash_pro: { provider: "antigravity", remainingRatio: 0.13, resetAt: "2026-09-15T12:00:00.000Z" },
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.69, resetAt: "2026-09-18T00:00:00.000Z" }
    });
    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);

    expect(state.effectiveRemainingRatio).toBe(0.13);
    expect(state.status).toBe("conserve");
    expect(state.limitingBuckets).toContain("gemini_flash_pro");
    expect(state.resetAt).toBe("2026-09-15T12:00:00.000Z");
  });

  it("18. multi-window Gemini minimum bucket selection (weekly window lower)", () => {
    const snapshot = makeSnapshot({
      gemini_flash_pro: { provider: "antigravity", remainingRatio: 0.25, resetAt: "2026-09-15T12:00:00.000Z" },
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.08, resetAt: "2026-09-18T00:00:00.000Z" }
    });
    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);

    expect(state.effectiveRemainingRatio).toBe(0.08);
    expect(state.status).toBe("reserve");
    expect(state.limitingBuckets).toContain("gemini_weekly");
    expect(state.resetAt).toBe("2026-09-18T00:00:00.000Z");
  });

  it("19. shared Gemini quota group affects all three Gemini candidate states", () => {
    const snapshot = makeSnapshot({
      gemini_flash_pro: { provider: "antigravity", remainingRatio: 0.098, resetAt: "2026-09-18T07:36:38.000Z" },
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.102, resetAt: "2026-09-18T07:36:38.000Z" }
    });
    const pLow = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
    const pMed = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
    const pHigh = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-high")!;

    const sLow = evaluateCandidateQuota(pLow, snapshot, tracker);
    const sMed = evaluateCandidateQuota(pMed, snapshot, tracker);
    const sHigh = evaluateCandidateQuota(pHigh, snapshot, tracker);

    expect(sLow.status).toBe("reserve");
    expect(sMed.status).toBe("reserve");
    expect(sHigh.status).toBe("reserve");
    expect(sLow.effectiveRemainingRatio).toBe(0.098);
    expect(sMed.effectiveRemainingRatio).toBe(0.098);
    expect(sHigh.effectiveRemainingRatio).toBe(0.098);
    expect(sLow.limitingBuckets).toContain("gemini_flash_pro");
    expect(sMed.limitingBuckets).toContain("gemini_flash_pro");
    expect(sHigh.limitingBuckets).toContain("gemini_flash_pro");
  });

  it("20. degraded provider health with known quota evaluates from quota buckets", () => {
    const snapshot = makeSnapshot({
      gemini_weekly: { provider: "antigravity", remainingRatio: 0.25 }
    });
    snapshot.providerHealth["antigravity"] = "degraded";

    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);

    expect(state.status).toBe("conserve");
    expect(state.effectiveRemainingRatio).toBe(0.25);
  });

  it("21. degraded provider health with missing quota telemetry fails open to unknown", () => {
    const snapshot: QuotaSnapshot = {
      observedAt: Date.now(),
      buckets: {},
      providerHealth: {
        antigravity: "degraded",
        codex: "healthy"
      },
      stale: false
    };

    const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
    const state = evaluateCandidateQuota(profile, snapshot, tracker);

    expect(state.status).toBe("unknown");
    expect(state.effectiveRemainingRatio).toBe(1.0);
    expect(state.reason).toBe("telemetry_degraded");
  });

  it("22. gets applicable bucket ids for sonnet / claude models", () => {
    const sonnetProfile = {
      id: "sonnet-agentic",
      model: "ag/claude-sonnet-4-6",
      enabled: false,
      profileClass: "specialist" as const,
      role: "AGENTIC_EXECUTOR",
      hardCapabilities: { tools: true, vision: true },
      taskFit: ["code" as const],
      qualityTier: "strong" as const,
      costClass: "high" as const,
      latencyClass: "slow" as const
    };
    const bucketIds = getApplicableBucketIds(sonnetProfile);
    expect(bucketIds).toEqual(["claude_short", "claude_weekly"]);
  });

  it("23. evaluates sonnet candidate quota from claude buckets", () => {
    const sonnetProfile = {
      id: "sonnet-agentic",
      model: "ag/claude-sonnet-4-6",
      enabled: false,
      profileClass: "specialist" as const,
      role: "AGENTIC_EXECUTOR",
      hardCapabilities: { tools: true, vision: true },
      taskFit: ["code" as const],
      qualityTier: "strong" as const,
      costClass: "high" as const,
      latencyClass: "slow" as const
    };

    // Healthy
    const healthySnap = makeSnapshot({
      claude_short: { provider: "antigravity", remainingRatio: 0.62 },
      claude_weekly: { provider: "antigravity", remainingRatio: 0.69 }
    });
    const healthyState = evaluateCandidateQuota(sonnetProfile, healthySnap, tracker);
    expect(healthyState.status).toBe("healthy");
    expect(healthyState.effectiveRemainingRatio).toBeCloseTo(0.62, 2);

    // Conserve
    const conserveSnap = makeSnapshot({
      claude_short: { provider: "antigravity", remainingRatio: 0.25 },
      claude_weekly: { provider: "antigravity", remainingRatio: 0.50 }
    });
    const conserveState = evaluateCandidateQuota(sonnetProfile, conserveSnap, tracker);
    expect(conserveState.status).toBe("conserve");
    expect(conserveState.effectiveRemainingRatio).toBeCloseTo(0.25, 2);

    // Reserve
    const reserveSnap = makeSnapshot({
      claude_short: { provider: "antigravity", remainingRatio: 0.08 },
      claude_weekly: { provider: "antigravity", remainingRatio: 0.50 }
    });
    const reserveState = evaluateCandidateQuota(sonnetProfile, reserveSnap, tracker);
    expect(reserveState.status).toBe("reserve");
    expect(reserveState.effectiveRemainingRatio).toBeCloseTo(0.08, 2);

    // Exhausted
    const exhaustedSnap = makeSnapshot({
      claude_short: { provider: "antigravity", remainingRatio: 0.0 },
      claude_weekly: { provider: "antigravity", remainingRatio: 0.0 }
    });
    const exhaustedState = evaluateCandidateQuota(sonnetProfile, exhaustedSnap, tracker);
    expect(exhaustedState.status).toBe("exhausted");
    expect(exhaustedState.effectiveRemainingRatio).toBe(0.0);
  });
});
