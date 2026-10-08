import { NineRouterQuotaSource } from "../../src/quota/source.js";
import { evaluateCandidateQuota, resolveQuotaDecision, DEFAULT_QUOTA_THRESHOLDS } from "../../src/quota/policy.js";
import { DEFAULT_SHADOW_PROFILES } from "../../src/shadow-profiles.js";
import { QuotaCooldownTracker } from "../../src/quota/cooldown.js";
import { routeShadow, createSessionStore } from "../../src/shadow-router.js";

async function main() {
  console.log("=== STEP 5: VERIFY GEMINI POOL & STEP 6: CODEX EXHAUSTION ===");
  const source = new NineRouterQuotaSource({ baseUrl: "http://127.0.0.1:20128", timeoutMs: 3000 });
  const snapshot = await source.getSnapshot();
  const tracker = new QuotaCooldownTracker();
  const sessionStore = createSessionStore();

  console.log("Observed At:", new Date(snapshot.observedAt).toISOString());
  console.log("Provider Health:", snapshot.providerHealth);

  const agAccounts = Object.values(snapshot.accounts ?? {}).filter((a) => a.provider === "antigravity");
  const cxAccounts = Object.values(snapshot.accounts ?? {}).filter((a) => a.provider === "codex");

  console.log(`\nAntigravity Accounts (${agAccounts.length}):`);
  for (const acc of agAccounts) {
    const flashRatio = acc.buckets["gemini_flash_pro"]?.remainingRatio;
    const weeklyRatio = acc.buckets["gemini_weekly"]?.remainingRatio;
    console.log(`  ${acc.accountAlias}: health=${acc.providerHealth}, flashRatio=${flashRatio}, weeklyRatio=${weeklyRatio}, active=${acc.isActive}`);
  }

  console.log(`\nCodex Accounts (${cxAccounts.length}):`);
  for (const acc of cxAccounts) {
    const sessionRatio = acc.buckets["codex_session"]?.remainingRatio;
    const weeklyRatio = acc.buckets["codex_weekly"]?.remainingRatio;
    console.log(`  ${acc.accountAlias}: health=${acc.providerHealth}, sessionRatio=${sessionRatio}, weeklyRatio=${weeklyRatio}, active=${acc.isActive}`);
  }

  // Evaluate candidate profiles
  console.log("\nCandidate Profile Evaluations:");
  const profilesToTest = ["gemini-flash-low", "gemini-flash-medium", "gemini-flash-high", "terra", "luna-review", "sol", "astra"];
  const evaluations: Record<string, any> = {};

  for (const pid of profilesToTest) {
    const p = DEFAULT_SHADOW_PROFILES.find((x) => x.id === pid)!;
    const evalResult = evaluateCandidateQuota(p, snapshot, tracker, undefined, DEFAULT_QUOTA_THRESHOLDS);
    evaluations[pid] = evalResult;
    console.log(`  ${pid.padEnd(20)} -> status: ${evalResult.status.padEnd(12)} effectiveRatio: ${evalResult.effectiveRemainingRatio.toFixed(4)} poolStatus: ${evalResult.pool?.status ?? "N/A"} usableAccs: ${evalResult.pool?.usableAccountCount ?? "N/A"}/${evalResult.pool?.totalAccountCount ?? "N/A"}`);
  }

  // Assertions for Step 5: Gemini Pool
  const pGemLow = evaluations["gemini-flash-low"];
  const pGemMed = evaluations["gemini-flash-medium"];
  const pGemHigh = evaluations["gemini-flash-high"];

  if (pGemLow.pool?.status !== "healthy" || pGemMed.pool?.status !== "healthy" || pGemHigh.pool?.status !== "healthy") {
    throw new Error("FAILED: Gemini pool status is not healthy!");
  }
  if (pGemLow.pool?.usableAccountCount !== 2) {
    throw new Error(`FAILED: Expected 2 usable Gemini accounts, got ${pGemLow.pool?.usableAccountCount}`);
  }
  if (pGemLow.status !== "healthy" || pGemMed.status !== "healthy" || pGemHigh.status !== "healthy") {
    throw new Error("FAILED: Gemini profiles are not normally eligible/healthy!");
  }
  console.log("\nPASSED: Gemini pool is healthy, 2 usable accounts, all 3 Gemini profiles normally eligible.");

  // Assertions for Step 6: Codex Exhaustion
  const pTerra = evaluations["terra"];
  const pLuna = evaluations["luna-review"];

  if (pTerra.status !== "exhausted") {
    throw new Error(`FAILED: Expected Terra to be exhausted, got ${pTerra.status}`);
  }
  if (pLuna.status !== "exhausted") {
    throw new Error(`FAILED: Expected Luna-review to be exhausted, got ${pLuna.status}`);
  }
  console.log("PASSED: Terra and Luna-review are unavailable/exhausted under Codex exhaustion.");

  // Test explicit review routing and fallback
  const reviewShadow = routeShadow(
    {
      sessionId: "review-test",
      messages: [{ role: "user", content: "Please review this PR for security vulnerabilities and race conditions." }],
      policy: "balanced"
    },
    DEFAULT_SHADOW_PROFILES,
    sessionStore
  );

  console.log(`\nReview Task Baseline Route: ${reviewShadow.selectedProfile} (specialist: ${reviewShadow.specialistIntent})`);

  const reviewDecision = resolveQuotaDecision({
    standardSelectedProfile: reviewShadow.selectedProfile,
    taskType: reviewShadow.taskType,
    specialistIntent: reviewShadow.specialistIntent,
    complexity: reviewShadow.complexity,
    risk: reviewShadow.risk,
    minimumQualityTier: reviewShadow.minimumQualityTier,
    requiredCapabilities: reviewShadow.requiredCapabilities,
    profiles: DEFAULT_SHADOW_PROFILES,
    snapshot,
    cooldownTracker: tracker,
    quotaPolicy: "auto",
    thresholds: DEFAULT_QUOTA_THRESHOLDS
  });

  console.log(`Review Task Quota-Aware Decision: ${reviewDecision.selectedProfile} (effect: ${reviewDecision.selectionEffect}, reason: ${reviewDecision.switchReason}, wouldSwitch: ${reviewDecision.wouldSwitch})`);

  if (reviewDecision.selectedProfile !== "gemini-flash-high") {
    throw new Error(`FAILED: Expected review fallback to gemini-flash-high, got ${reviewDecision.selectedProfile}`);
  }
  if (reviewDecision.selectionEffect !== "avoided_exhausted_luna-review") {
    throw new Error(`FAILED: Expected selectionEffect avoided_exhausted_luna-review, got ${reviewDecision.selectionEffect}`);
  }
  console.log("PASSED: Explicit review cleanly falls back to gemini-flash-high without attempting doomed Codex request.");

  // Verify disabled profiles Sol and Astra
  if (evaluations["sol"].status !== "exhausted" || evaluations["astra"].status !== "exhausted") {
    throw new Error("FAILED: Sol or Astra not marked exhausted/disabled!");
  }
  console.log("PASSED: Sol and Astra strictly excluded/disabled.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
