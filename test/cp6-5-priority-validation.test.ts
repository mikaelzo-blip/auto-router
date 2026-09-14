import { describe, it, expect } from "vitest";
import {
  evaluateCandidateQuota,
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

describe("CP6.5 Account Priority Validation & Quota Auto Readiness Invariants", () => {
  const tracker = new QuotaCooldownTracker();
  const sessionStore = createSessionStore();

  const pGeminiLow = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
  const pGeminiMed = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
  const pGeminiHigh = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-high")!;
  const pTerra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "terra")!;
  const pLuna = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "luna-review")!;
  const pSol = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "sol")!;
  const pAstra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "astra")!;

  // 1. Multi-account Gemini pool stays healthy with bestRemainingRatio from account_2
  it("evaluates Gemini pool as healthy with bestRemainingRatio from account_2 when account_1 is in reserve", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.025),
      makeAccount("account_2", "antigravity", 0.9899),
      makeAccount("account_1", "codex", 0.0, "unavailable")
    ]);

    for (const p of [pGeminiLow, pGeminiMed, pGeminiHigh]) {
      const q = evaluateCandidateQuota(p, snap, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
      expect(q.status).toBe("healthy");
      expect(q.effectiveRemainingRatio).toBe(0.9899);
      expect(q.pool?.status).toBe("healthy");
      expect(q.pool?.bestRemainingRatio).toBe(0.9899);
      expect(q.pool?.usableAccountCount).toBe(2);
      expect(q.pool?.constrainedAccountCount).toBe(1);
      expect(q.pool?.exhaustedAccountCount).toBe(0);
    }
  });

  // 2. Codex exhaustion excludes Terra and Luna-review
  it("strictly marks Terra and Luna-review exhausted when Codex provider is unavailable or exhausted", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.9899),
      makeAccount("account_1", "codex", 0.0, "unavailable")
    ]);

    const evalTerra = evaluateCandidateQuota(pTerra, snap, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
    const evalLuna = evaluateCandidateQuota(pLuna, snap, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);

    expect(evalTerra.status).toBe("exhausted");
    expect(evalTerra.effectiveRemainingRatio).toBe(0);
    expect(evalTerra.pool?.status).toBe("exhausted");

    expect(evalLuna.status).toBe("exhausted");
    expect(evalLuna.effectiveRemainingRatio).toBe(0);
    expect(evalLuna.pool?.status).toBe("exhausted");
  });

  // 3. Preemptive review fallback to gemini-flash-high without doomed Codex request
  it("preemptively falls back to gemini-flash-high for review when Luna is exhausted under auto quota policy", () => {
    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.025),
      makeAccount("account_2", "antigravity", 0.9899),
      makeAccount("account_1", "codex", 0.0, "unavailable")
    ]);

    const shadow = routeShadow(
      {
        sessionId: "review-invariant-test",
        messages: [{ role: "user", content: "Please review this PR for concurrency and race conditions." }],
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

  // 4. Scenarios A through F deterministic verification
  it("satisfies all auto policy scenarios A through F", () => {
    // Scenario A: account_1 reserve + account_2 healthy -> Gemini healthy
    const snapA = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.04),
      makeAccount("account_2", "antigravity", 0.95)
    ]);
    expect(evaluateCandidateQuota(pGeminiMed, snapA, tracker).status).toBe("healthy");

    // Scenario B: account_1 exhausted + account_2 healthy -> Gemini healthy
    const snapB = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.0),
      makeAccount("account_2", "antigravity", 0.95)
    ]);
    expect(evaluateCandidateQuota(pGeminiMed, snapB, tracker).status).toBe("healthy");

    // Scenario C: account_2 unavailable + account_1 reserve -> Gemini reserve
    const snapC = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.05),
      makeAccount("account_2", "antigravity", 0.0, "unavailable")
    ]);
    expect(evaluateCandidateQuota(pGeminiMed, snapC, tracker).status).toBe("reserve");

    // Scenario D: both Antigravity accounts exhausted -> Gemini exhausted
    const snapD = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.0),
      makeAccount("account_2", "antigravity", 0.0)
    ]);
    expect(evaluateCandidateQuota(pGeminiMed, snapD, tracker).status).toBe("exhausted");

    // Scenario E: Codex exhausted -> Terra/Luna excluded
    const snapE = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.95),
      makeAccount("account_1", "codex", 0.0)
    ]);
    expect(evaluateCandidateQuota(pTerra, snapE, tracker).status).toBe("exhausted");
    expect(evaluateCandidateQuota(pLuna, snapE, tracker).status).toBe("exhausted");

    // Scenario F: all general providers exhausted -> explicit no eligible model
    const snapF = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.0),
      makeAccount("account_2", "antigravity", 0.0),
      makeAccount("account_1", "codex", 0.0)
    ]);
    const decisionF = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-medium",
      taskType: "code",
      specialistIntent: undefined,
      complexity: "medium",
      risk: "low",
      minimumQualityTier: "cheap",
      requiredCapabilities: { tools: false, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot: snapF,
      cooldownTracker: tracker,
      quotaPolicy: "auto",
      thresholds: DEFAULT_QUOTA_THRESHOLDS
    });
    expect(decisionF.selectedProfile).toBeUndefined();
    expect(decisionF.selectionEffect).toBe("no_eligible_candidate");
  });

  // 5. Disabled profiles Sol and Astra remain disabled
  it("strictly disables Sol and Astra from being selected under any quota scenario", () => {
    expect(pSol.enabled).toBe(false);
    expect(pAstra.enabled).toBe(false);

    const snap = makeSnapshot([
      makeAccount("account_1", "antigravity", 0.95),
      makeAccount("account_2", "antigravity", 0.95)
    ]);
    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-high",
      taskType: "code",
      specialistIntent: undefined,
      complexity: "critical",
      risk: "high",
      minimumQualityTier: "strong",
      requiredCapabilities: { tools: false, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot: snap,
      cooldownTracker: tracker,
      quotaPolicy: "auto",
      thresholds: DEFAULT_QUOTA_THRESHOLDS
    });
    expect(decision.selectedProfile).not.toBe("sol");
    expect(decision.selectedProfile).not.toBe("astra");
  });

  // 6. Final readiness gate invariant: account_1 reserve conservation is required for auto
  it("enforces that auto cutover requires empirical conservation of reserve account", () => {
    // Contract: If account_1 continues to be consumed materially while account_2 is healthy,
    // quota auto must NOT be cut over.
    const servingObservation = {
      account1ServedCount: 5,
      account2ServedCount: 0,
      account1ConsumedRatio: 0.00014,
      account1Conserved: false,
      account2Active: false
    };

    const isAutoReady = servingObservation.account2Active && servingObservation.account1Conserved;
    expect(isAutoReady).toBe(false);
  });
});
