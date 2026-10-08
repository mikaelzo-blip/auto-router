import { describe, it, expect } from "vitest";
import {
  evaluateCandidateQuota,
  filterAndRankWithQuota,
  resolveQuotaDecision,
  DEFAULT_QUOTA_THRESHOLDS
} from "../src/quota/policy.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";
import type {
  QuotaSnapshot,
  QuotaBucket,
  AccountQuotaSnapshot
} from "../src/quota/types.js";
import { QuotaCooldownTracker } from "../src/quota/cooldown.js";
import { routeShadow, createSessionStore } from "../src/shadow-router.js";

function makeAccount(
  accountAlias: string,
  provider: string,
  ratio: number,
  health: "healthy" | "degraded" | "unavailable" = "healthy"
): AccountQuotaSnapshot {
  const buckets: Record<string, QuotaBucket> = {
    [`${provider}_shared`]: {
      id: `${provider}_shared`,
      provider,
      scope: "shared",
      used: Math.round(1000 * (1 - ratio)),
      limit: 1000,
      remaining: Math.round(1000 * ratio),
      remainingRatio: ratio,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    }
  };
  if (provider === "antigravity") {
    buckets["gemini_flash_pro"] = { ...buckets[`${provider}_shared`]!, id: "gemini_flash_pro" };
    buckets["gemini_weekly"] = { ...buckets[`${provider}_shared`]!, id: "gemini_weekly" };
  } else if (provider === "codex") {
    buckets["codex_session"] = { ...buckets[`${provider}_shared`]!, id: "codex_session" };
    buckets["codex_weekly"] = { ...buckets[`${provider}_shared`]!, id: "codex_weekly" };
  }
  return {
    accountAlias,
    provider,
    providerHealth: health,
    buckets,
    isActive: true
  };
}

function makeSnapshot(accounts: AccountQuotaSnapshot[]): QuotaSnapshot {
  const accountMap: Record<string, AccountQuotaSnapshot> = {};
  const providerHealth: Record<string, "healthy" | "degraded" | "unavailable"> = {
    antigravity: "healthy",
    codex: "healthy"
  };
  for (const a of accounts) {
    accountMap[`${a.provider}:${a.accountAlias}`] = a;
    if (a.providerHealth === "unavailable" && accounts.filter((x) => x.provider === a.provider).every((x) => x.providerHealth === "unavailable")) {
      providerHealth[a.provider] = "unavailable";
    }
  }
  return {
    observedAt: Date.now(),
    buckets: {},
    providerHealth,
    stale: false,
    accounts: accountMap
  };
}

describe("CP6.4 Live Account-Selection Validation & Production Shadow Invariants", () => {
  const tracker = new QuotaCooldownTracker();
  const sessionStore = createSessionStore();

  const pGeminiLow = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
  const pGeminiMed = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
  const pGeminiHigh = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-high")!;
  const pTerra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "terra")!;
  const pLuna = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "luna-review")!;
  const pSol = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "sol")!;
  const pAstra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "astra")!;

  // 1. All three shared Gemini profiles evaluate to healthy under multi-account pool
  it("evaluates all three Gemini profiles as healthy when account_2 is healthy and account_1 is reserve", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.04),
      makeAccount("account_2", "antigravity", 1.0),
      makeAccount("account_1", "codex", 0.0, "unavailable")
    ]);

    for (const p of [pGeminiLow, pGeminiMed, pGeminiHigh]) {
      const q = evaluateCandidateQuota(p, snap, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
      expect(q.status).toBe("healthy");
      expect(q.effectiveRemainingRatio).toBe(1.0);
      expect(q.pool?.status).toBe("healthy");
      expect(q.pool?.bestRemainingRatio).toBe(1.0);
      expect(q.pool?.usableAccountCount).toBe(2);
      expect(q.pool?.constrainedAccountCount).toBe(1);
      expect(q.pool?.exhaustedAccountCount).toBe(0);
      expect(q.limitingBuckets).toEqual([]);
    }
  });

  // 2. Codex exhaustion marks Terra and Luna-review as exhausted
  it("marks Terra and Luna-review as exhausted when Codex quota is exhausted", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 1.0),
      makeAccount("account_1", "codex", 0.0, "unavailable")
    ]);

    const evalTerra = evaluateCandidateQuota(pTerra, snap, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
    const evalLuna = evaluateCandidateQuota(pLuna, snap, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);

    expect(evalTerra.status).toBe("exhausted");
    expect(evalTerra.effectiveRemainingRatio).toBe(0.0);
    expect(evalTerra.pool?.status).toBe("exhausted");
    expect(evalTerra.pool?.usableAccountCount).toBe(0);

    expect(evalLuna.status).toBe("exhausted");
    expect(evalLuna.effectiveRemainingRatio).toBe(0.0);
    expect(evalLuna.pool?.status).toBe("exhausted");
    expect(evalLuna.pool?.usableAccountCount).toBe(0);
  });

  // 3. Explicit review task falls back safely to gemini-flash-high without doomed Luna request
  it("safely falls back from exhausted luna-review to gemini-flash-high for explicit review", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.04),
      makeAccount("account_2", "antigravity", 1.0),
      makeAccount("account_1", "codex", 0.0, "unavailable")
    ]);

    const shadow = routeShadow(
      {
        sessionId: "cp6-4-test-review",
        messages: [{ role: "user", content: "Please review this PR for concurrency deadlocks and race conditions" }],
        policy: "balanced"
      },
      DEFAULT_SHADOW_PROFILES,
      sessionStore
    );

    expect(shadow.selectedProfile).toBe("luna-review");
    expect(shadow.specialistIntent).toBe("review");

    const decision = resolveQuotaDecision({
      standardSelectedProfile: shadow.selectedProfile,
      taskType: shadow.taskType,
      specialistIntent: shadow.specialistIntent,
      complexity: shadow.complexity,
      risk: shadow.risk,
      minimumQualityTier: shadow.minimumQualityTier,
      requiredCapabilities: shadow.requiredCapabilities,
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot: snap,
      cooldownTracker: tracker,
      quotaPolicy: "auto",
      thresholds: DEFAULT_QUOTA_THRESHOLDS
    });

    expect(decision.selectedProfile).toBe("gemini-flash-high");
    expect(decision.selectionEffect).toBe("avoided_exhausted_luna-review");
    expect(decision.switchReason).toBe("quota_exhausted");
    expect(decision.wouldSwitch).toBe(true);
  });

  // 4. Hard concurrency / high-risk task routes to Gemini High, never Terra
  it("routes hard concurrency to gemini-flash-high and never Terra when Codex is exhausted", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.04),
      makeAccount("account_2", "antigravity", 1.0),
      makeAccount("account_1", "codex", 0.0, "unavailable")
    ]);

    const shadow = routeShadow(
      {
        sessionId: "cp6-4-test-hard",
        messages: [{ role: "user", content: "Implement a lock-free ring buffer in C++ with memory barriers and strict atomic invariants" }],
        policy: "balanced"
      },
      DEFAULT_SHADOW_PROFILES,
      sessionStore
    );

    const decision = resolveQuotaDecision({
      standardSelectedProfile: shadow.selectedProfile,
      taskType: shadow.taskType,
      specialistIntent: shadow.specialistIntent,
      complexity: shadow.complexity,
      risk: shadow.risk,
      minimumQualityTier: shadow.minimumQualityTier,
      requiredCapabilities: shadow.requiredCapabilities,
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot: snap,
      cooldownTracker: tracker,
      quotaPolicy: "auto",
      thresholds: DEFAULT_QUOTA_THRESHOLDS
    });

    expect(decision.selectedProfile).toBe("gemini-flash-high");
    expect(decision.selectedProfile).not.toBe("terra");
    expect(decision.selectedProfile).not.toBe("sol");
    expect(decision.selectedProfile).not.toBe("astra");
  });

  // 5. Failure Case: account_1 exhausted + account_2 healthy -> Gemini remains healthy
  it("maintains healthy Gemini pool when account_1 is exhausted but account_2 is healthy", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.0),
      makeAccount("account_2", "antigravity", 0.9)
    ]);
    const q = evaluateCandidateQuota(pGeminiMed, snap, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
    expect(q.status).toBe("healthy");
    expect(q.pool?.status).toBe("healthy");
    expect(q.effectiveRemainingRatio).toBe(0.9);
  });

  // 6. Failure Case: account_1 reserve + account_2 unavailable -> Gemini becomes reserve
  it("degrades Gemini pool to reserve when account_1 is reserve and account_2 is unavailable", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.05),
      makeAccount("account_2", "antigravity", 0.0, "unavailable")
    ]);
    const q = evaluateCandidateQuota(pGeminiMed, snap, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
    expect(q.status).toBe("reserve");
    expect(q.pool?.status).toBe("reserve");
    expect(q.effectiveRemainingRatio).toBe(0.05);
  });

  // 7. Failure Case: account_1 exhausted + account_2 exhausted -> Gemini exhausted
  it("exhausts Gemini pool when both account_1 and account_2 are exhausted", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.0),
      makeAccount("account_2", "antigravity", 0.0)
    ]);
    const q = evaluateCandidateQuota(pGeminiMed, snap, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
    expect(q.status).toBe("exhausted");
    expect(q.pool?.status).toBe("exhausted");
    expect(q.effectiveRemainingRatio).toBe(0.0);
  });

  // 8. Failure Case: both Gemini and Codex exhausted -> explicit no eligible model
  it("yields explicit no_eligible_candidate when all providers are exhausted", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.0),
      makeAccount("account_2", "antigravity", 0.0),
      makeAccount("account_1", "codex", 0.0, "unavailable")
    ]);
    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-medium",
      taskType: "code",
      specialistIntent: undefined,
      complexity: "medium",
      risk: "low",
      minimumQualityTier: "cheap",
      requiredCapabilities: { tools: false, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot: snap,
      cooldownTracker: tracker,
      quotaPolicy: "auto",
      thresholds: DEFAULT_QUOTA_THRESHOLDS
    });
    expect(decision.selectedProfile).toBeUndefined();
    expect(decision.selectionEffect).toBe("no_eligible_candidate");
    expect(decision.switchReason).toBe("all_candidates_exhausted");
  });

  // 9. Disabled profiles Sol and Astra are never enabled or selected
  it("strictly excludes disabled Sol and Astra from eligibility across all policies", () => {
    expect(pSol.enabled).toBe(false);
    expect(pAstra.enabled).toBe(false);

    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 1.0),
      makeAccount("account_2", "antigravity", 1.0),
      makeAccount("account_1", "codex", 1.0)
    ]);

    const ranked = filterAndRankWithQuota({
      taskType: "code",
      specialistIntent: undefined,
      complexity: "critical",
      risk: "high",
      minimumQualityTier: "strong",
      requiredCapabilities: { tools: false, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot: snap,
      cooldownTracker: tracker,
      policy: "auto",
      thresholds: DEFAULT_QUOTA_THRESHOLDS
    });

    expect(ranked.some((p) => p.id === "sol")).toBe(false);
    expect(ranked.some((p) => p.id === "astra")).toBe(false);
  });
});
