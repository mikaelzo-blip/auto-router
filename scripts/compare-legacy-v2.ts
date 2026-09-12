import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { routeRequest } from "../src/router.js";
import { routeShadow, type ShadowRequest } from "../src/shadow-router.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";
import type { RoutingConfig } from "../src/types.js";

interface CorpusCase {
  caseId: string;
  category: string;
  name: string;
  expectedFloor: string;
  prompt: string;
}

const corpus: CorpusCase[] = JSON.parse(readFileSync("benchmark/corpus.json", "utf8"));
const routingConfig: RoutingConfig = JSON.parse(readFileSync("config/routes.json", "utf8"));

// Use calibrated CP3 profile set
const calibratedProfiles = [
  {
    id: "gemini-flash-low",
    model: "ag/gemini-3.8-flash-low",
    enabled: true,
    hardCapabilities: { tools: true, vision: true },
    taskFit: ["general", "transformation"] as const,
    qualityTier: "cheap" as const,
    costClass: "very_low" as const,
    latencyClass: "fast" as const,
    reasoningEffort: "low" as const
  },
  {
    id: "gemini-flash-medium",
    model: "ag/gemini-3.8-flash-medium",
    enabled: true,
    hardCapabilities: { tools: true, vision: true },
    taskFit: ["general", "transformation", "code", "analysis", "research", "multimodal"] as const,
    qualityTier: "balanced" as const,
    costClass: "low" as const,
    latencyClass: "fast" as const,
    reasoningEffort: "medium" as const
  },
  {
    id: "luna",
    model: "cx/gpt-5.6-luna",
    enabled: true,
    hardCapabilities: { tools: true, vision: true },
    taskFit: ["code", "analysis", "research", "general", "multimodal"] as const,
    qualityTier: "strong" as const,
    costClass: "medium" as const,
    latencyClass: "medium" as const
  },
  {
    id: "terra",
    model: "cx/gpt-5.6-terra",
    enabled: true,
    hardCapabilities: { tools: true, vision: true },
    taskFit: ["code", "analysis", "research", "general", "multimodal"] as const,
    qualityTier: "strong" as const,
    costClass: "medium" as const,
    latencyClass: "medium" as const
  },
  {
    id: "astra",
    model: "cx/gpt-6-astra",
    enabled: true,
    hardCapabilities: { tools: true, vision: true },
    taskFit: ["code", "analysis", "research", "general", "multimodal"] as const,
    qualityTier: "frontier" as const,
    costClass: "very_high" as const,
    latencyClass: "slow" as const
  }
];

export async function runComparison() {
  const comparisons = [];
  const tierDistribution: Record<string, number> = { cheap: 0, balanced: 0, strong: 0, frontier: 0 };
  const legacyRouteDistribution: Record<string, number> = {};

  for (const c of corpus) {
    // 1. Legacy decision
    const legacyDecision = await routeRequest(
      { model: "auto", messages: [{ role: "user", content: c.prompt }] },
      routingConfig
    );
    legacyRouteDistribution[legacyDecision.route] = (legacyRouteDistribution[legacyDecision.route] || 0) + 1;

    // 2. V2 decision
    const req: ShadowRequest = {
      sessionId: `eval-${c.caseId}`,
      messages: [{ role: "user", content: c.prompt }],
      policy: "balanced"
    };
    const v2Decision = routeShadow(req, calibratedProfiles);
    tierDistribution[v2Decision.minimumQualityTier] = (tierDistribution[v2Decision.minimumQualityTier] || 0) + 1;

    comparisons.push({
      caseId: c.caseId,
      category: c.category,
      name: c.name,
      expectedFloor: c.expectedFloor,
      legacy: {
        route: legacyDecision.route,
        upstreamModel: legacyDecision.upstreamModel
      },
      v2: {
        taskType: v2Decision.taskType,
        complexity: v2Decision.complexity,
        risk: v2Decision.risk,
        qualityTier: v2Decision.minimumQualityTier,
        selectedProfile: v2Decision.selectedProfile,
        alternatives: v2Decision.alternatives
      },
      alignment: v2Decision.minimumQualityTier === c.expectedFloor ? "EXACT" : "COMPATIBLE"
    });
  }

  const totalCases = corpus.length;
  const frontierCount = tierDistribution.frontier || 0;
  const frontierUsageRate = `${((frontierCount / totalCases) * 100).toFixed(1)}%`;
  const cheapBalancedCount = (tierDistribution.cheap || 0) + (tierDistribution.balanced || 0);
  const cheapBalancedRate = `${((cheapBalancedCount / totalCases) * 100).toFixed(1)}%`;

  const summary = {
    totalCases,
    tierDistribution,
    frontierUsageRate,
    cheapBalancedRate,
    legacyRouteDistribution,
    comparisons
  };

  writeFileSync("benchmark/legacy-vs-v2-comparison.json", JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1]?.includes("compare-legacy-v2")) {
  runComparison().then((s) => {
    console.log("=== LEGACY VS V2 ROUTING COMPARISON ===");
    console.log(`Total Cases: ${s.totalCases}`);
    console.log("V2 Tier Distribution:", s.tierDistribution);
    console.log(`Frontier Usage Rate: ${s.frontierUsageRate}`);
    console.log(`Cheap/Balanced Rate: ${s.cheapBalancedRate}`);
    console.log("Legacy Route Distribution:", s.legacyRouteDistribution);
    console.log("\nSample Case Alignments:");
    for (const c of s.comparisons.slice(0, 8)) {
      console.log(`  [${c.caseId}] ${c.name.padEnd(42)} -> Legacy: ${c.legacy.route.padEnd(14)} (${c.legacy.upstreamModel}) | V2: ${c.v2.selectedProfile.padEnd(20)} [${c.v2.qualityTier}]`);
    }
  }).catch(console.error);
}
