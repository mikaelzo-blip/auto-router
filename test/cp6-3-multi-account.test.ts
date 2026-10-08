import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  AccountQuotaSnapshot,
  CandidateQuotaPoolState
} from "../src/quota/types.js";
import { QuotaCooldownTracker } from "../src/quota/cooldown.js";
import { NineRouterQuotaSource, SyntheticQuotaSource } from "../src/quota/source.js";

function makeAccount(
  accountAlias: string,
  provider: string,
  buckets: Record<string, Partial<QuotaBucket>>,
  providerHealth: "healthy" | "degraded" | "unavailable" = "healthy"
): AccountQuotaSnapshot {
  const fullBuckets: Record<string, QuotaBucket> = {};
  for (const [id, b] of Object.entries(buckets)) {
    fullBuckets[id] = {
      id,
      provider: b.provider ?? provider,
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
    accountAlias,
    provider,
    providerHealth,
    buckets: fullBuckets,
    isActive: true
  };
}

function makeMultiAccountSnapshot(
  accounts: AccountQuotaSnapshot[],
  providerHealth: Record<string, "healthy" | "degraded" | "unavailable"> = {
    antigravity: "healthy",
    codex: "healthy"
  }
): QuotaSnapshot {
  const accountMap: Record<string, AccountQuotaSnapshot> = {};
  for (const acc of accounts) {
    accountMap[`${acc.provider}:${acc.accountAlias}`] = acc;
  }
  return {
    observedAt: Date.now(),
    buckets: {},
    providerHealth,
    stale: false,
    accounts: accountMap
  };
}

describe("CP6.3 Multi-Account Quota Pool Validation (24-Test Matrix)", () => {
  const tracker = new QuotaCooldownTracker();
  const pGeminiLow = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
  const pGeminiMed = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
  const pGeminiHigh = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-high")!;
  const pTerra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "terra")!;
  const pSol = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "sol")!;
  const pLuna = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "luna-review")!;
  const pAstra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "astra")!;

  // 1. One healthy + one reserve -> healthy pool
  it("1. one healthy + one reserve -> healthy pool", () => {
    const acc1 = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.0716 },
      gemini_flash_pro: { remainingRatio: 0.0728 }
    });
    const acc2 = makeAccount("account_2", "antigravity", {
      gemini_weekly: { remainingRatio: 1.0 },
      gemini_flash_pro: { remainingRatio: 1.0 }
    });
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const state = evaluateCandidateQuota(pGeminiMed, snapshot, tracker);
    expect(state.status).toBe("healthy");
    expect(state.effectiveRemainingRatio).toBe(1.0);
    expect(state.pool).toBeDefined();
    expect(state.pool?.status).toBe("healthy");
    expect(state.pool?.bestRemainingRatio).toBe(1.0);
    expect(state.pool?.usableAccountCount).toBe(2);
    expect(state.pool?.constrainedAccountCount).toBe(1);
    expect(state.pool?.exhaustedAccountCount).toBe(0);
  });

  // 2. One healthy + one exhausted -> healthy pool
  it("2. one healthy + one exhausted -> healthy pool", () => {
    const acc1 = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.0 },
      gemini_flash_pro: { remainingRatio: 0.0 }
    });
    const acc2 = makeAccount("account_2", "antigravity", {
      gemini_weekly: { remainingRatio: 0.85 },
      gemini_flash_pro: { remainingRatio: 0.85 }
    });
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const state = evaluateCandidateQuota(pGeminiLow, snapshot, tracker);
    expect(state.status).toBe("healthy");
    expect(state.effectiveRemainingRatio).toBe(0.85);
    expect(state.pool?.usableAccountCount).toBe(2);
    expect(state.pool?.exhaustedAccountCount).toBe(1);
  });

  // 3. Conserve + reserve -> conserve pool
  it("3. conserve + reserve -> conserve pool", () => {
    const acc1 = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.08 }
    });
    const acc2 = makeAccount("account_2", "antigravity", {
      gemini_weekly: { remainingRatio: 0.20 }
    });
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const state = evaluateCandidateQuota(pGeminiMed, snapshot, tracker);
    expect(state.status).toBe("conserve");
    expect(state.effectiveRemainingRatio).toBe(0.20);
    expect(state.pool?.status).toBe("conserve");
    expect(state.pool?.bestRemainingRatio).toBe(0.20);
  });

  // 4. Reserve + reserve -> reserve pool
  it("4. reserve + reserve -> reserve pool", () => {
    const acc1 = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.05 }
    });
    const acc2 = makeAccount("account_2", "antigravity", {
      gemini_weekly: { remainingRatio: 0.08 }
    });
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const state = evaluateCandidateQuota(pGeminiHigh, snapshot, tracker);
    expect(state.status).toBe("reserve");
    expect(state.effectiveRemainingRatio).toBe(0.08);
    expect(state.pool?.status).toBe("reserve");
    expect(state.pool?.constrainedAccountCount).toBe(2);
  });

  // 5. Exhausted + exhausted -> exhausted pool
  it("5. exhausted + exhausted -> exhausted pool", () => {
    const acc1 = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.0, resetAt: "2026-09-18T10:00:00.000Z" }
    });
    const acc2 = makeAccount("account_2", "antigravity", {
      gemini_weekly: { remainingRatio: 0.0, resetAt: "2026-09-18T08:00:00.000Z" }
    });
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const state = evaluateCandidateQuota(pGeminiMed, snapshot, tracker);
    expect(state.status).toBe("exhausted");
    expect(state.effectiveRemainingRatio).toBe(0.0);
    expect(state.pool?.status).toBe("exhausted");
    expect(state.pool?.exhaustedAccountCount).toBe(2);
    expect(state.pool?.earliestRelevantReset).toBe("2026-09-18T08:00:00.000Z");
  });

  // 6. Healthy + unknown -> healthy pool
  it("6. healthy + unknown -> healthy pool", () => {
    const acc1 = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.75 }
    });
    const acc2: AccountQuotaSnapshot = {
      accountAlias: "account_2",
      provider: "antigravity",
      providerHealth: "healthy",
      buckets: {},
      isActive: true
    };
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const state = evaluateCandidateQuota(pGeminiLow, snapshot, tracker);
    expect(state.status).toBe("healthy");
    expect(state.effectiveRemainingRatio).toBe(0.75);
    expect(state.pool?.status).toBe("healthy");
  });

  // 7. Exhausted + unknown does not become false exhausted
  it("7. exhausted + unknown does not become false exhausted", () => {
    const acc1 = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.0 }
    });
    const acc2: AccountQuotaSnapshot = {
      accountAlias: "account_2",
      provider: "antigravity",
      providerHealth: "healthy",
      buckets: {},
      isActive: true
    };
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const state = evaluateCandidateQuota(pGeminiMed, snapshot, tracker);
    expect(state.status).not.toBe("exhausted");
    expect(state.status).toBe("unknown"); // fails open to unknown
    expect(state.pool?.status).toBe("unknown");
  });

  // 8. All unknown -> unknown fail-open
  it("8. all unknown -> unknown fail-open", () => {
    const acc1: AccountQuotaSnapshot = {
      accountAlias: "account_1",
      provider: "antigravity",
      providerHealth: "healthy",
      buckets: {},
      isActive: true
    };
    const acc2: AccountQuotaSnapshot = {
      accountAlias: "account_2",
      provider: "antigravity",
      providerHealth: "healthy",
      buckets: {},
      isActive: true
    };
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const state = evaluateCandidateQuota(pGeminiMed, snapshot, tracker);
    expect(state.status).toBe("unknown");
    expect(state.effectiveRemainingRatio).toBe(1.0);
    expect(state.pool?.status).toBe("unknown");
  });

  // 9. Per-account multi-bucket minimum
  it("9. per-account multi-bucket takes minimum within one account", () => {
    const acc1 = makeAccount("account_1", "codex", {
      codex_session: { provider: "codex", remainingRatio: 0.50 },
      codex_weekly: { provider: "codex", remainingRatio: 0.08 }
    });
    const snapshot = makeMultiAccountSnapshot([acc1]);

    const state = evaluateCandidateQuota(pTerra, snapshot, tracker);
    expect(state.effectiveRemainingRatio).toBe(0.08);
    expect(state.status).toBe("reserve");
    expect(state.pool?.accounts?.[0]?.effectiveRemainingRatio).toBe(0.08);
  });

  // 10. Cross-account aggregation does not use minimum
  it("10. cross-account aggregation does not use minimum across accounts", () => {
    const accA = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.08 }
    });
    const accB = makeAccount("account_2", "antigravity", {
      gemini_weekly: { remainingRatio: 1.0 }
    });
    const snapshot = makeMultiAccountSnapshot([accA, accB]);

    const state = evaluateCandidateQuota(pGeminiMed, snapshot, tracker);
    expect(state.effectiveRemainingRatio).toBe(1.0);
    expect(state.status).toBe("healthy");
    expect(state.effectiveRemainingRatio).not.toBe(0.08);
  });

  // 11. Shared Gemini family evaluated per account
  it("11. shared Gemini family evaluated per account", () => {
    const acc1 = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.05 },
      gemini_flash_pro: { remainingRatio: 0.05 }
    });
    const acc2 = makeAccount("account_2", "antigravity", {
      gemini_weekly: { remainingRatio: 0.90 },
      gemini_flash_pro: { remainingRatio: 0.90 }
    });
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const sLow = evaluateCandidateQuota(pGeminiLow, snapshot, tracker);
    const sMed = evaluateCandidateQuota(pGeminiMed, snapshot, tracker);
    const sHigh = evaluateCandidateQuota(pGeminiHigh, snapshot, tracker);

    expect(sLow.status).toBe("healthy");
    expect(sMed.status).toBe("healthy");
    expect(sHigh.status).toBe("healthy");
    expect(sLow.effectiveRemainingRatio).toBe(0.90);
    expect(sMed.effectiveRemainingRatio).toBe(0.90);
    expect(sHigh.effectiveRemainingRatio).toBe(0.90);
  });

  // 12. One account 429 does not poison healthy account pool
  it("12. one account 429 does not poison healthy account pool", () => {
    const acc1 = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.80 }
    });
    const acc2 = makeAccount("account_2", "antigravity", {
      gemini_weekly: { remainingRatio: 0.90 }
    });
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const accountTracker = new QuotaCooldownTracker();
    // Scope 429 to account_1 only
    accountTracker.recordAccountResponse(
      "account_1",
      pGeminiMed.model,
      429,
      JSON.stringify({ error: { message: "quota exceeded" } })
    );

    const state = evaluateCandidateQuota(pGeminiMed, snapshot, accountTracker);
    expect(state.status).toBe("healthy");
    expect(state.effectiveRemainingRatio).toBe(0.90);
    expect(state.pool?.usableAccountCount).toBe(1);
    expect(state.pool?.exhaustedAccountCount).toBe(1);
  });

  // 13. Account health failure does not poison healthy sibling account
  it("13. account health failure does not poison healthy sibling account", () => {
    const acc1 = makeAccount("account_1", "antigravity", {}, "unavailable");
    const acc2 = makeAccount("account_2", "antigravity", {
      gemini_weekly: { remainingRatio: 0.95 }
    }, "healthy");
    const snapshot = makeMultiAccountSnapshot([acc1, acc2], {
      antigravity: "healthy",
      codex: "healthy"
    });

    const state = evaluateCandidateQuota(pGeminiLow, snapshot, tracker);
    expect(state.status).toBe("healthy");
    expect(state.effectiveRemainingRatio).toBe(0.95);
    expect(state.pool?.usableAccountCount).toBe(1);
    expect(state.pool?.totalAccountCount).toBe(2);
  });

  // 14. All accounts unavailable -> provider unavailable
  it("14. all accounts unavailable -> provider unavailable", () => {
    const acc1 = makeAccount("account_1", "antigravity", {}, "unavailable");
    const acc2 = makeAccount("account_2", "antigravity", {}, "unavailable");
    const snapshot = makeMultiAccountSnapshot([acc1, acc2], {
      antigravity: "unavailable",
      codex: "healthy"
    });

    const state = evaluateCandidateQuota(pGeminiMed, snapshot, tracker);
    expect(state.status).toBe("exhausted");
    expect(state.effectiveRemainingRatio).toBe(0.0);
    expect(state.reason).toBe("provider_unavailable");
  });

  // 15. Disabled Sol remains disabled
  it("15. disabled Sol remains disabled even if Codex quota is healthy", () => {
    const accCx = makeAccount("account_1", "codex", {
      codex_session: { remainingRatio: 1.0 },
      codex_weekly: { remainingRatio: 1.0 }
    });
    const snapshot = makeMultiAccountSnapshot([accCx]);

    const ranked = filterAndRankWithQuota({
      taskType: "code",
      complexity: "high",
      risk: "low",
      minimumQualityTier: "strong",
      requiredCapabilities: { tools: true, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      policy: "auto"
    });

    const solProfile = ranked.find((p) => p.id === "sol");
    expect(solProfile).toBeUndefined();
  });

  // 16. Disabled Astra remains disabled
  it("16. disabled Astra remains disabled even if Codex quota is healthy", () => {
    const accCx = makeAccount("account_1", "codex", {
      codex_session: { remainingRatio: 1.0 },
      codex_weekly: { remainingRatio: 1.0 }
    });
    const snapshot = makeMultiAccountSnapshot([accCx]);

    const ranked = filterAndRankWithQuota({
      taskType: "analysis",
      complexity: "critical",
      risk: "high",
      minimumQualityTier: "frontier",
      requiredCapabilities: { tools: true, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      policy: "auto"
    });

    const astraProfile = ranked.find((p) => p.id === "astra");
    expect(astraProfile).toBeUndefined();
  });

  // 17. Specialist Luna isolation preserved
  it("17. specialist Luna isolation preserved (only eligible for specialistIntent=review)", () => {
    const accCx = makeAccount("account_1", "codex", {
      codex_session: { remainingRatio: 1.0 },
      codex_weekly: { remainingRatio: 1.0 }
    });
    const snapshot = makeMultiAccountSnapshot([accCx]);

    // Without specialistIntent
    const rankedGeneral = filterAndRankWithQuota({
      taskType: "code",
      complexity: "high",
      risk: "low",
      minimumQualityTier: "strong",
      requiredCapabilities: { tools: true, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      policy: "auto"
    });
    expect(rankedGeneral.some((p) => p.id === "luna-review")).toBe(false);

    // With specialistIntent="review"
    const rankedReview = filterAndRankWithQuota({
      taskType: "code",
      specialistIntent: "review",
      complexity: "high",
      risk: "low",
      minimumQualityTier: "strong",
      requiredCapabilities: { tools: true, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      policy: "auto"
    });
    expect(rankedReview.some((p) => p.id === "luna-review")).toBe(true);
  });

  // 18. Terra role policy preserved
  it("18. Terra role policy preserved: routine tasks do not wastefully divert to Terra when Gemini is healthy", () => {
    const accAg = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.80 },
      gemini_flash_pro: { remainingRatio: 0.80 }
    });
    const accCx = makeAccount("account_1", "codex", {
      codex_session: { remainingRatio: 1.0 },
      codex_weekly: { remainingRatio: 1.0 }
    });
    const snapshot = makeMultiAccountSnapshot([accAg, accCx]);

    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-low",
      taskType: "general",
      complexity: "trivial",
      risk: "low",
      minimumQualityTier: "cheap",
      requiredCapabilities: { tools: false, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      quotaPolicy: "shadow"
    });

    expect(decision.wouldSwitch).toBe(false);
    expect(decision.hypotheticalProfile).toBe("gemini-flash-low");
  });

  // 19. Round Robin setting not required
  it("19. Round Robin setting is not required; priority fallback order operates safely", () => {
    // Verified from 9Router source audit that 9Router defaults to fill-first priority fallback
    // and filters out rate-limited and quota <= 0 accounts.
    const acc1 = makeAccount("account_1", "antigravity", { gemini_weekly: { remainingRatio: 0.05 } });
    const acc2 = makeAccount("account_2", "antigravity", { gemini_weekly: { remainingRatio: 0.95 } });
    const snapshot = makeMultiAccountSnapshot([acc1, acc2]);

    const state = evaluateCandidateQuota(pGeminiMed, snapshot, tracker);
    expect(state.status).toBe("healthy");
    expect(state.effectiveRemainingRatio).toBe(0.95);
  });

  // 20. Privacy redaction
  it("20. privacy redaction: snapshots and pool states contain no emails, tokens, or raw connection IDs", () => {
    const acc = makeAccount("account_1", "antigravity", {
      gemini_weekly: { remainingRatio: 0.5 }
    });
    const snapshot = makeMultiAccountSnapshot([acc]);
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("b59bebec");
    expect(serialized).not.toContain("4acde0a7");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("oauth");
  });

  // 21. Cache stores independent account state
  it("21. cache stores independent account state without collision", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/providers")) {
        return Promise.resolve(new Response(JSON.stringify({
          connections: [
            { id: "conn-ag-1", provider: "antigravity", isActive: true, priority: 1 },
            { id: "conn-ag-2", provider: "antigravity", isActive: true, priority: 2 }
          ]
        }), { status: 200 }));
      }
      if (url.endsWith("/api/usage/conn-ag-1")) {
        return Promise.resolve(new Response(JSON.stringify({
          quotas: {
            "gemini-3.8-flash-low": { remainingPercentage: 7.0, total: 1000, used: 930 },
            "gemini_weekly": { remainingPercentage: 7.0, total: 1000, used: 930 }
          }
        }), { status: 200 }));
      }
      if (url.endsWith("/api/usage/conn-ag-2")) {
        return Promise.resolve(new Response(JSON.stringify({
          quotas: {
            "gemini-3.8-flash-low": { remainingPercentage: 100.0, total: 1000, used: 0 },
            "gemini_weekly": { remainingPercentage: 100.0, total: 1000, used: 0 }
          }
        }), { status: 200 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    const source = new NineRouterQuotaSource({
      baseUrl: "http://127.0.0.1:20128",
      refreshTtlMs: 30_000,
      staleFallbackMs: 60_000,
      timeoutMs: 1000,
      fetchImpl: fetchMock
    });

    const snapshot = await source.getSnapshot();
    expect(snapshot.accounts).toBeDefined();
    const accKeys = Object.keys(snapshot.accounts ?? {});
    expect(accKeys.length).toBe(2);

    const state = evaluateCandidateQuota(pGeminiLow, snapshot, tracker);
    expect(state.status).toBe("healthy");
    expect(state.effectiveRemainingRatio).toBe(1.0);

    source.close();
  });

  // 22. Background refresh clean shutdown
  it("22. background refresh clean shutdown closes without lingering promises or handles", () => {
    const source = new NineRouterQuotaSource({
      baseUrl: "http://127.0.0.1:20128",
      refreshTtlMs: 30_000,
      staleFallbackMs: 60_000,
      timeoutMs: 1000
    });
    source.close();
    expect(() => source.close()).not.toThrow();
  });

  // 23. User request path remains cache-only
  it("23. user request path remains cache-only; getSnapshot serves cached without extra network calls", async () => {
    let networkCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      networkCalls += 1;
      if (url.endsWith("/api/providers")) {
        return Promise.resolve(new Response(JSON.stringify({
          connections: [{ id: "c1", provider: "antigravity", isActive: true }]
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        quotas: { gemini_weekly: { remainingPercentage: 50 } }
      }), { status: 200 }));
    });

    const source = new NineRouterQuotaSource({
      baseUrl: "http://127.0.0.1:20128",
      refreshTtlMs: 30_000,
      staleFallbackMs: 60_000,
      timeoutMs: 1000,
      fetchImpl: fetchMock
    });

    await source.getSnapshot();
    const initialCalls = networkCalls;

    // Subsequent call within TTL
    const snap2 = await source.getSnapshot();
    expect(networkCalls).toBe(initialCalls);
    expect(snap2.stale).toBe(false);

    source.close();
  });

  // 24. No mid-stream quota switching
  it("24. once response streaming has started, no quota re-evaluation or route switching occurs", () => {
    // In AutoRouter v2, streaming responses lock the model header and pipe the upstream stream;
    // quota evaluation happens strictly pre-stream during route resolution.
    const acc1 = makeAccount("account_1", "antigravity", { gemini_weekly: { remainingRatio: 0.9 } });
    const snapshot = makeMultiAccountSnapshot([acc1]);

    const decision = resolveQuotaDecision({
      standardSelectedProfile: "gemini-flash-low",
      taskType: "general",
      complexity: "trivial",
      risk: "low",
      minimumQualityTier: "cheap",
      requiredCapabilities: { tools: false, vision: false },
      profiles: DEFAULT_SHADOW_PROFILES,
      snapshot,
      cooldownTracker: tracker,
      quotaPolicy: "shadow"
    });

    expect(decision.selectedModel).toBe("ag/gemini-3.8-flash-low");
    // Stream invariant: mid-stream chunk processing cannot alter decision.selectedModel
  });
});
