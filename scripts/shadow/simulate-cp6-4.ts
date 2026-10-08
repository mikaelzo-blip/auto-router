import { NineRouterQuotaSource, SyntheticQuotaSource } from "../../src/quota/source.js";
import { resolveQuotaDecision, filterAndRankWithQuota, evaluateCandidateQuota, DEFAULT_QUOTA_THRESHOLDS } from "../../src/quota/policy.js";
import { DEFAULT_SHADOW_PROFILES } from "../../src/shadow-profiles.js";
import { QuotaCooldownTracker } from "../../src/quota/cooldown.js";
import { routeShadow, createSessionStore } from "../../src/shadow-router.js";
import type { AccountQuotaSnapshot, QuotaSnapshot, QuotaBucket } from "../../src/quota/types.js";

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
  }
  return {
    observedAt: Date.now(),
    buckets: {},
    providerHealth,
    stale: false,
    accounts: accountMap
  };
}

async function runSimulations() {
  console.log("=== SECTION 15: AUTO-POLICY SIMULATION UNDER CURRENT LIVE QUOTA TOPOLOGY ===");
  const liveSource = new NineRouterQuotaSource({ baseUrl: "http://127.0.0.1:20128", timeoutMs: 3000 });
  const liveSnapshot = await liveSource.getSnapshot();
  const tracker = new QuotaCooldownTracker();
  const sessionStore = createSessionStore();

  const testCases = [
    { category: "routine", prompt: "Convert this JSON object to CSV: {\"name\": \"Bob\"}" },
    { category: "normal coding", prompt: "Write a TypeScript function to debounce an async search input" },
    { category: "hard concurrency", prompt: "Implement a lock-free ring buffer in C++ with memory barriers" },
    { category: "high-risk", prompt: "Write SQL triggers and schema to enforce double-entry ledger balance integrity" },
    { category: "explicit review", prompt: "Please review this PR for security vulnerabilities and deadlocks" }
  ];

  const liveResults: Record<string, any> = {};

  for (const tc of testCases) {
    const shadow = routeShadow(
      {
        sessionId: `sim-${tc.category}`,
        messages: [{ role: "user", content: tc.prompt }],
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
      snapshot: liveSnapshot,
      cooldownTracker: tracker,
      quotaPolicy: "auto",
      thresholds: DEFAULT_QUOTA_THRESHOLDS
    });

    liveResults[tc.category] = {
      baselineProfile: shadow.selectedProfile,
      autoProfile: decision.selectedProfile,
      selectionEffect: decision.selectionEffect,
      switchReason: decision.switchReason,
      wouldSwitch: decision.wouldSwitch
    };

    console.log(`[${tc.category.toUpperCase().padEnd(16)}] Baseline: ${shadow.selectedProfile?.padEnd(20)} -> Auto: ${decision.selectedProfile?.padEnd(20)} (effect: ${decision.selectionEffect})`);

    // Invariants assertions
    if (decision.selectedProfile === "sol" || decision.selectedProfile === "astra") {
      throw new Error(`VIOLATION: Disabled profile ${decision.selectedProfile} selected!`);
    }
    if (decision.selectedProfile === "terra") {
      throw new Error(`VIOLATION: Terra selected while Codex pool is exhausted!`);
    }
  }

  // Verify specific expected models
  if (liveResults["routine"].autoProfile !== "gemini-flash-low") {
    throw new Error(`Expected routine -> gemini-flash-low, got ${liveResults["routine"].autoProfile}`);
  }
  if (liveResults["normal coding"].autoProfile !== "gemini-flash-medium") {
    throw new Error(`Expected normal coding -> gemini-flash-medium, got ${liveResults["normal coding"].autoProfile}`);
  }
  if (liveResults["hard concurrency"].autoProfile !== "gemini-flash-high") {
    throw new Error(`Expected hard concurrency -> gemini-flash-high, got ${liveResults["hard concurrency"].autoProfile}`);
  }
  if (liveResults["high-risk"].autoProfile !== "gemini-flash-high") {
    throw new Error(`Expected high-risk -> gemini-flash-high, got ${liveResults["high-risk"].autoProfile}`);
  }
  if (liveResults["explicit review"].autoProfile !== "gemini-flash-high") {
    throw new Error(`Expected explicit review -> gemini-flash-high fallback, got ${liveResults["explicit review"].autoProfile}`);
  }
  console.log("SECTION 15 PASSED: All 5 live task categories routed exactly as expected. No Terra, Sol, or Astra.\n");

  console.log("=== SECTION 16: FAILURE CASE SIMULATIONS ===");

  const pGeminiLow = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-low")!;
  const pGeminiMed = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
  const pGeminiHigh = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-high")!;
  const pTerra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "terra")!;
  const pLuna = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "luna-review")!;

  // 1. account_1 exhausted + account_2 healthy -> Gemini remains healthy
  console.log("1. account_1 exhausted + account_2 healthy -> Gemini pool remains healthy");
  const snap1 = makeSnapshot([
    makeAccount("account_1", "antigravity", 0.0),
    makeAccount("account_2", "antigravity", 0.85)
  ]);
  const eval1 = evaluateCandidateQuota(pGeminiMed, snap1, tracker);
  console.log(`   status: ${eval1.status}, poolStatus: ${eval1.pool?.status}, ratio: ${eval1.effectiveRemainingRatio}`);
  if (eval1.status !== "healthy" || eval1.pool?.status !== "healthy") {
    throw new Error("Case 1 Failed: Gemini pool not healthy");
  }

  // 2. account_1 reserve + account_2 unavailable -> Gemini becomes reserve
  console.log("2. account_1 reserve + account_2 unavailable -> Gemini becomes reserve");
  const snap2 = makeSnapshot([
    makeAccount("account_1", "antigravity", 0.08),
    makeAccount("account_2", "antigravity", 0.0, "unavailable")
  ]);
  const eval2 = evaluateCandidateQuota(pGeminiMed, snap2, tracker);
  console.log(`   status: ${eval2.status}, poolStatus: ${eval2.pool?.status}, ratio: ${eval2.effectiveRemainingRatio}`);
  if (eval2.status !== "reserve" || eval2.pool?.status !== "reserve") {
    throw new Error("Case 2 Failed: Gemini pool not reserve");
  }

  // 3. account_1 exhausted + account_2 exhausted -> Gemini exhausted
  console.log("3. account_1 exhausted + account_2 exhausted -> Gemini exhausted");
  const snap3 = makeSnapshot([
    makeAccount("account_1", "antigravity", 0.0),
    makeAccount("account_2", "antigravity", 0.0)
  ]);
  const eval3 = evaluateCandidateQuota(pGeminiMed, snap3, tracker);
  console.log(`   status: ${eval3.status}, poolStatus: ${eval3.pool?.status}, ratio: ${eval3.effectiveRemainingRatio}`);
  if (eval3.status !== "exhausted" || eval3.pool?.status !== "exhausted") {
    throw new Error("Case 3 Failed: Gemini pool not exhausted");
  }

  // 4. Codex exhausted -> Terra and Luna unavailable
  console.log("4. Codex exhausted -> Terra and Luna unavailable");
  const snap4 = makeSnapshot([
    makeAccount("account_1", "antigravity", 1.0),
    makeAccount("account_1", "codex", 0.0)
  ]);
  const evalTerra = evaluateCandidateQuota(pTerra, snap4, tracker);
  const evalLuna = evaluateCandidateQuota(pLuna, snap4, tracker);
  console.log(`   Terra status: ${evalTerra.status}, Luna status: ${evalLuna.status}`);
  if (evalTerra.status !== "exhausted" || evalLuna.status !== "exhausted") {
    throw new Error("Case 4 Failed: Terra or Luna not exhausted");
  }

  // 5. Both Gemini and Codex exhausted -> explicit no eligible model
  console.log("5. Both Gemini and Codex exhausted -> explicit no eligible model");
  const snap5 = makeSnapshot([
    makeAccount("account_1", "antigravity", 0.0),
    makeAccount("account_2", "antigravity", 0.0),
    makeAccount("account_1", "codex", 0.0)
  ]);
  const decisionAllExhausted = resolveQuotaDecision({
    standardSelectedProfile: "gemini-flash-medium",
    taskType: "code",
    specialistIntent: undefined,
    complexity: "medium",
    risk: "low",
    minimumQualityTier: "cheap",
    requiredCapabilities: { tools: false, vision: false },
    profiles: DEFAULT_SHADOW_PROFILES,
    snapshot: snap5,
    cooldownTracker: tracker,
    quotaPolicy: "auto",
    thresholds: DEFAULT_QUOTA_THRESHOLDS
  });
  console.log(`   selectedProfile: ${decisionAllExhausted.selectedProfile}, selectionEffect: ${decisionAllExhausted.selectionEffect}`);
  if (decisionAllExhausted.selectedProfile !== undefined || decisionAllExhausted.selectionEffect !== "no_eligible_candidate") {
    throw new Error("Case 5 Failed: Did not yield explicit no_eligible_candidate");
  }

  // Verify disabled profile activation: Ensure sol and astra are NEVER chosen
  for (const prof of [DEFAULT_SHADOW_PROFILES.find(p => p.id === "sol")!, DEFAULT_SHADOW_PROFILES.find(p => p.id === "astra")!]) {
    if (prof.enabled !== false) {
      throw new Error(`VIOLATION: Profile ${prof.id} is enabled in registry!`);
    }
  }

  console.log("SECTION 16 PASSED: All 5 failure cases and disabled profile guards verified.\n");
}

runSimulations().catch((err) => {
  console.error(err);
  process.exit(1);
});
