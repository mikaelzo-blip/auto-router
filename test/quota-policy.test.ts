import { describe, it, expect } from "vitest";
import {
  evaluateCandidateQuota,
  filterAndRankWithQuota,
  resolveQuotaDecision,
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

  it("11. quality floor is preserved when selecting models", () => {
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

  it("14. strong/high-risk task can consume reserve when justified", () => {
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
});
