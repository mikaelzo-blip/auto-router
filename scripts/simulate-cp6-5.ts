import { resolveQuotaDecision, evaluateCandidateQuota, DEFAULT_QUOTA_THRESHOLDS } from "../src/quota/policy.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";
import { QuotaCooldownTracker } from "../src/quota/cooldown.js";
import { routeShadow, createSessionStore } from "../src/shadow-router.js";
import type { AccountQuotaSnapshot, QuotaSnapshot, QuotaBucket } from "../src/quota/types.js";

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

async function runSimulation() {
  console.log("=== STEP 9: AUTO POLICY SIMULATION ACROSS SCENARIOS A - F ===");
  const tracker = new QuotaCooldownTracker();
  const sessionStore = createSessionStore();

  const pGemMed = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
  const pTerra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "terra")!;
  const pLuna = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "luna-review")!;

  // Scenario A: account_1 reserve + account_2 healthy -> Gemini pool healthy
  console.log("\nScenario A: account_1 reserve + account_2 healthy -> Gemini pool healthy");
  const snapA = makeSnapshot([
    makeAccount("account_1", "antigravity", 0.04),
    makeAccount("account_2", "antigravity", 0.98),
    makeAccount("account_1", "codex", 0.0, "unavailable")
  ]);
  const evalA = evaluateCandidateQuota(pGemMed, snapA, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
  console.log(`  evalA status: ${evalA.status}, pool: ${evalA.pool?.status}, ratio: ${evalA.effectiveRemainingRatio}, usable: ${evalA.pool?.usableAccountCount}/${evalA.pool?.totalAccountCount}`);
  if (evalA.status !== "healthy" || evalA.pool?.status !== "healthy") {
    throw new Error("Scenario A FAILED: Gemini pool not healthy");
  }
  console.log("  Scenario A PASSED");

  // Scenario B: account_1 exhausted + account_2 healthy -> Gemini pool healthy
  console.log("\nScenario B: account_1 exhausted + account_2 healthy -> Gemini pool healthy");
  const snapB = makeSnapshot([
    makeAccount("account_1", "antigravity", 0.0),
    makeAccount("account_2", "antigravity", 0.95),
    makeAccount("account_1", "codex", 0.0, "unavailable")
  ]);
  const evalB = evaluateCandidateQuota(pGemMed, snapB, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
  console.log(`  evalB status: ${evalB.status}, pool: ${evalB.pool?.status}, ratio: ${evalB.effectiveRemainingRatio}, usable: ${evalB.pool?.usableAccountCount}/${evalB.pool?.totalAccountCount}`);
  if (evalB.status !== "healthy" || evalB.pool?.status !== "healthy") {
    throw new Error("Scenario B FAILED: Gemini pool not healthy");
  }
  console.log("  Scenario B PASSED");

  // Scenario C: account_2 unavailable + account_1 reserve -> Gemini pool reserve
  console.log("\nScenario C: account_2 unavailable + account_1 reserve -> Gemini pool reserve");
  const snapC = makeSnapshot([
    makeAccount("account_1", "antigravity", 0.05),
    makeAccount("account_2", "antigravity", 0.0, "unavailable"),
    makeAccount("account_1", "codex", 0.0, "unavailable")
  ]);
  const evalC = evaluateCandidateQuota(pGemMed, snapC, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
  console.log(`  evalC status: ${evalC.status}, pool: ${evalC.pool?.status}, ratio: ${evalC.effectiveRemainingRatio}, usable: ${evalC.pool?.usableAccountCount}/${evalC.pool?.totalAccountCount}`);
  if (evalC.status !== "reserve" || evalC.pool?.status !== "reserve") {
    throw new Error("Scenario C FAILED: Gemini pool not reserve");
  }
  console.log("  Scenario C PASSED");

  // Scenario D: both Antigravity accounts exhausted -> Gemini excluded
  console.log("\nScenario D: both Antigravity accounts exhausted -> Gemini excluded");
  const snapD = makeSnapshot([
    makeAccount("account_1", "antigravity", 0.0),
    makeAccount("account_2", "antigravity", 0.0),
    makeAccount("account_1", "codex", 0.0, "unavailable")
  ]);
  const evalD = evaluateCandidateQuota(pGemMed, snapD, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
  console.log(`  evalD status: ${evalD.status}, pool: ${evalD.pool?.status}, ratio: ${evalD.effectiveRemainingRatio}, usable: ${evalD.pool?.usableAccountCount}/${evalD.pool?.totalAccountCount}`);
  if (evalD.status !== "exhausted" || evalD.pool?.status !== "exhausted") {
    throw new Error("Scenario D FAILED: Gemini not exhausted");
  }
  console.log("  Scenario D PASSED");

  // Scenario E: Codex exhausted -> Terra/Luna excluded
  console.log("\nScenario E: Codex exhausted -> Terra/Luna excluded");
  const snapE = makeSnapshot([
    makeAccount("account_1", "antigravity", 0.98),
    makeAccount("account_2", "antigravity", 0.98),
    makeAccount("account_1", "codex", 0.0)
  ]);
  const evalETerra = evaluateCandidateQuota(pTerra, snapE, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
  const evalELuna = evaluateCandidateQuota(pLuna, snapE, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
  console.log(`  evalETerra status: ${evalETerra.status}, evalELuna status: ${evalELuna.status}`);
  if (evalETerra.status !== "exhausted" || evalELuna.status !== "exhausted") {
    throw new Error("Scenario E FAILED: Terra or Luna not exhausted");
  }
  console.log("  Scenario E PASSED");

  // Scenario F: all enabled general providers exhausted -> explicit no eligible model
  console.log("\nScenario F: all enabled general providers exhausted -> explicit no eligible model");
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
  console.log(`  decisionF selectedProfile: ${decisionF.selectedProfile}, selectionEffect: ${decisionF.selectionEffect}`);
  if (decisionF.selectedProfile !== undefined || decisionF.selectionEffect !== "no_eligible_candidate") {
    throw new Error("Scenario F FAILED: Did not yield explicit no_eligible_candidate");
  }
  console.log("  Scenario F PASSED");

  // Safety: Sol and Astra disabled verification
  for (const profId of ["sol", "astra"]) {
    const prof = DEFAULT_SHADOW_PROFILES.find((p) => p.id === profId)!;
    if (prof.enabled !== false) {
      throw new Error(`VIOLATION: Profile ${profId} is enabled!`);
    }
  }
  console.log("\nPASSED: Sol and Astra strictly excluded/disabled in all scenarios.");
  console.log("\nALL SCENARIOS A THROUGH F PASSED PERFECTLY.");
}

runSimulation().catch((err) => {
  console.error(err);
  process.exit(1);
});
