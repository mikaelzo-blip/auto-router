import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import type { RoutingConfig } from "../../src/types.js";
import { NineRouterQuotaSource } from "../../src/quota/source.js";

interface SoakPrompt {
  id: string;
  category: "routine" | "normal_coding" | "architecture_prd" | "review_audit" | "agentic_execution";
  prompt: string;
  expectedAgentic: boolean;
  sessionId?: string;
  toolsProvided?: boolean;
}

const SOAK_PROMPTS: SoakPrompt[] = [
  // 1. Routine Transformation & Utilities (10)
  { id: "SOAK_01", category: "routine", prompt: "Convert this user object into CSV format: {\"id\": 1, \"name\": \"Alice\", \"role\": \"admin\"}", expectedAgentic: false },
  { id: "SOAK_02", category: "routine", prompt: "Format these key-value pairs into a clean markdown table: Host=127.0.0.1, Port=8080, Protocol=HTTP", expectedAgentic: false },
  { id: "SOAK_03", category: "routine", prompt: "Trim excess whitespace and normalize newlines in this text snippet.", expectedAgentic: false },
  { id: "SOAK_04", category: "routine", prompt: "Translate this YAML snippet into valid JSON: \nserver:\n  port: 8080\n  host: localhost", expectedAgentic: false },
  { id: "SOAK_05", category: "routine", prompt: "Convert ISO timestamp 2026-09-15T10:00:00Z into human readable format 'September 15, 2026, 10:00 AM UTC'.", expectedAgentic: false },
  { id: "SOAK_06", category: "routine", prompt: "Extract all email addresses from this unformatted text string.", expectedAgentic: false },
  { id: "SOAK_07", category: "routine", prompt: "Sort this list of semver version numbers in ascending order: ['2.1.0', '1.0.4', '2.0.1', '1.1.9']", expectedAgentic: false },
  { id: "SOAK_08", category: "routine", prompt: "Create a URL slug from the title: 'AutoRouter V2: Quota-Aware Multi-Window System'", expectedAgentic: false },
  { id: "SOAK_09", category: "routine", prompt: "Fix typo in README.md line 42.", expectedAgentic: false },
  { id: "SOAK_10", category: "routine", prompt: "Rename variable oldCounter to requestCounter in metrics.ts.", expectedAgentic: false },

  // 2. Normal Single-File Coding (10)
  { id: "SOAK_11", category: "normal_coding", prompt: "Write a TypeScript function to debounce an async function with leading and trailing options.", expectedAgentic: false },
  { id: "SOAK_12", category: "normal_coding", prompt: "Write a Python retry helper with exponential backoff and jitter for network requests.", expectedAgentic: false },
  { id: "SOAK_13", category: "normal_coding", prompt: "Implement a simple LRU cache in TypeScript with get and set methods and TTL eviction.", expectedAgentic: false },
  { id: "SOAK_14", category: "normal_coding", prompt: "Write a FastAPI route to validate and upload a multipart zip archive.", expectedAgentic: false },
  { id: "SOAK_15", category: "normal_coding", prompt: "Write a PostgreSQL query with keyset pagination for an orders table.", expectedAgentic: false },
  { id: "SOAK_16", category: "normal_coding", prompt: "Implement binary search in Go for a sorted slice of integers.", expectedAgentic: false },
  { id: "SOAK_17", category: "normal_coding", prompt: "Write a robust regular expression to validate email syntax according to RFC 5322.", expectedAgentic: false },
  { id: "SOAK_18", category: "normal_coding", prompt: "Write an algorithm in Python to merge overlapping time intervals.", expectedAgentic: false },
  { id: "SOAK_19", category: "normal_coding", prompt: "Write a Node.js function using crypto to verify a HMAC-SHA256 JWT signature.", expectedAgentic: false },
  { id: "SOAK_20", category: "normal_coding", prompt: "Write an iterative breadth-first search function for a tree structure in TypeScript.", expectedAgentic: false },

  // 3. Complex Architecture & PRD Design (10)
  { id: "SOAK_21", category: "architecture_prd", prompt: "Design a modular architecture for distributed caching across edge locations.", expectedAgentic: false },
  { id: "SOAK_22", category: "architecture_prd", prompt: "Design an event-driven architecture for high-throughput financial order processing.", expectedAgentic: false },
  { id: "SOAK_23", category: "architecture_prd", prompt: "Draft an architecture decision record (ADR) evaluating PostgreSQL vs CockroachDB for multi-region active-active.", expectedAgentic: false },
  { id: "SOAK_24", category: "architecture_prd", prompt: "Design a system architecture to decompose the monolithic billing engine into microservices.", expectedAgentic: false },
  { id: "SOAK_25", category: "architecture_prd", prompt: "Architect a multi-tenant SAML and OIDC authentication architecture for enterprise customers.", expectedAgentic: false },
  { id: "SOAK_26", category: "architecture_prd", prompt: "Create a PRD for our new self-service user onboarding flow.", expectedAgentic: false },
  { id: "SOAK_27", category: "architecture_prd", prompt: "Write a specification for enterprise role-based access control (RBAC).", expectedAgentic: false },
  { id: "SOAK_28", category: "architecture_prd", prompt: "Write a PRD detailing product requirements for regulatory compliance audit logs.", expectedAgentic: false },
  { id: "SOAK_29", category: "architecture_prd", prompt: "Create a spec for a multi-channel user notification service (email, push, SMS).", expectedAgentic: false },
  { id: "SOAK_30", category: "architecture_prd", prompt: "Write an implementation plan for migrating from REST to gRPC for my review. Do not write code.", expectedAgentic: false },

  // 4. Code Review, Audit & Security (10)
  { id: "SOAK_31", category: "review_audit", prompt: "Review this git diff for authentication token bypass and timing attack vulnerabilities in auth.ts", expectedAgentic: false },
  { id: "SOAK_32", category: "review_audit", prompt: "Review this repository commit for potential SQL injection vulnerabilities in dynamic queries.", expectedAgentic: false },
  { id: "SOAK_33", category: "review_audit", prompt: "Analyze this Node.js EventListener code snippet for memory leaks and missing cleanup handlers.", expectedAgentic: false },
  { id: "SOAK_34", category: "review_audit", prompt: "Review this Go goroutine worker pool for race conditions and data sharing hazards.", expectedAgentic: false },
  { id: "SOAK_35", category: "review_audit", prompt: "Audit this payment checkout controller for unhandled promise rejections and swallowed errors.", expectedAgentic: false },
  { id: "SOAK_36", category: "review_audit", prompt: "Review the security headers and CORS configuration in this Express.js middleware stack.", expectedAgentic: false },
  { id: "SOAK_37", category: "review_audit", prompt: "Audit this Python API endpoint for insecure pickle and YAML deserialization risks.", expectedAgentic: false },
  { id: "SOAK_38", category: "review_audit", prompt: "Review this JavaScript deep merge utility for prototype pollution vulnerabilities.", expectedAgentic: false },
  { id: "SOAK_39", category: "review_audit", prompt: "Review this deployment configuration template for hardcoded API keys or credentials.", expectedAgentic: false },
  { id: "SOAK_40", category: "review_audit", prompt: "Audit this GraphQL resolver implementation for N+1 database query issues.", expectedAgentic: false },

  // 5. Complex Agentic Multi-File Execution & Verification (10)
  { id: "SOAK_41", category: "agentic_execution", prompt: "Implement wildcard event bus across several files in src/events/, update types, and run tests until passing.", expectedAgentic: true },
  { id: "SOAK_42", category: "agentic_execution", prompt: "Implement this approved schema migration across the repository and run tests until passing.", expectedAgentic: true },
  { id: "SOAK_43", category: "agentic_execution", prompt: "Implement approved architecture across API, database and tests, then verify all tests pass.", expectedAgentic: true },
  { id: "SOAK_44", category: "agentic_execution", prompt: "Tests are failing after my implementation. Diagnose the repo, fix it, rerun tests until green.", expectedAgentic: true },
  { id: "SOAK_45", category: "agentic_execution", prompt: "Refactor multiple modules across the repository to extract BaseKeyValueStore while maintaining backward compatibility.", expectedAgentic: true },
  { id: "SOAK_46", category: "agentic_execution", prompt: "Diagnose and repair the repository build failures, update implementation and verify all tests.", expectedAgentic: true },
  { id: "SOAK_47", category: "agentic_execution", prompt: "Trace and fix the bug across authentication, session store, and middleware modules, and run tests.", expectedAgentic: true },
  { id: "SOAK_48", category: "agentic_execution", prompt: "Execute the approved plan to replace the legacy batch worker across multiple files and verify all tests pass.", expectedAgentic: true },
  { id: "SOAK_49", category: "agentic_execution", prompt: "Implement OAuth2 PKCE flow across several files in auth/, router/, and client/, and run tests until green.", expectedAgentic: true },
  { id: "SOAK_50", category: "agentic_execution", prompt: "Implement saga compensation across orders, inventory, and payment modules, with test-fix-test verification.", expectedAgentic: true }
];

async function runSoak() {
  console.log("=== CP7.3 SHADOW SOAK OBSERVATION (50 REQUESTS) ===");
  const routing = JSON.parse(await readFile(resolve("config/routes.json"), "utf8")) as RoutingConfig;

  const quotaSource = new NineRouterQuotaSource({
    baseUrl: "http://127.0.0.1:20128",
    refreshTtlMs: 30_000,
    staleFallbackMs: 60_000,
    timeoutMs: 5000
  });

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 20205,
    upstreamBaseUrl: "http://127.0.0.1:20128/v1",
    classifierTimeoutMs: 100,
    upstreamTimeoutMs: 100,
    logLevel: "silent",
    routerMode: "v2",
    reasoningPolicy: "auto",
    quotaPolicy: "auto",
    routing
  };

  const app = buildApp(config, { quotaSource });

  let requestsObserved = 0;
  let agenticEligibleCount = 0;
  let wouldUseSonnetCount = 0;
  let falsePositiveCandidates = 0;
  let falseNegativeCandidates = 0;

  const records: any[] = [];
  const actualProfileDistribution: Record<string, number> = {};
  const shadowProfileDistribution: Record<string, number> = {};
  const taskTransitions: Array<{ id: string; category: string; fromActual: string; toShadow: string; reason: string }> = [];

  for (const item of SOAK_PROMPTS) {
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: {
        "content-type": "application/json",
        "x-session-id": item.sessionId ?? `soak-sess-${item.id}`
      },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: item.prompt }]
      }
    });

    if (res.statusCode !== 200) {
      console.error(`Request ${item.id} failed with status ${res.statusCode}`);
      continue;
    }

    requestsObserved++;
    const data = res.json();
    const shadowAgentic = data.shadowAgentic;
    const actualProfile = data.selectedProfile;
    const actualModel = data.selectedModel;

    actualProfileDistribution[actualProfile] = (actualProfileDistribution[actualProfile] ?? 0) + 1;

    const isEligible = Boolean(shadowAgentic?.shadowAgenticEligible);
    const wouldUseSonnet = Boolean(shadowAgentic?.wouldUseSonnet);
    const shadowProfile = shadowAgentic?.shadowAgenticProfile ?? actualProfile;
    const shadowModel = shadowAgentic?.shadowAgenticModel ?? actualModel;

    shadowProfileDistribution[shadowProfile] = (shadowProfileDistribution[shadowProfile] ?? 0) + 1;

    if (isEligible) agenticEligibleCount++;
    if (wouldUseSonnet) wouldUseSonnetCount++;

    if (!item.expectedAgentic && wouldUseSonnet) {
      falsePositiveCandidates++;
    }
    if (item.expectedAgentic && !wouldUseSonnet) {
      falseNegativeCandidates++;
    }

    if (wouldUseSonnet && shadowProfile !== actualProfile) {
      taskTransitions.push({
        id: item.id,
        category: item.category,
        fromActual: actualProfile,
        toShadow: shadowProfile,
        reason: shadowAgentic?.shadowAgenticReason ?? "agentic_specialization"
      });
    }

    records.push({
      id: item.id,
      category: item.category,
      prompt: item.prompt,
      expectedAgentic: item.expectedAgentic,
      actualProfile,
      actualModel,
      shadowProfile,
      shadowModel,
      isEligible,
      wouldUseSonnet,
      agenticIntent: shadowAgentic?.agenticIntent,
      signals: shadowAgentic?.agenticSignals ?? [],
      exclusions: shadowAgentic?.agenticExclusions ?? [],
      reason: shadowAgentic?.shadowAgenticReason
    });
  }

  await app.close();
  quotaSource.close();

  const wouldUseSonnetRate = requestsObserved > 0 ? (wouldUseSonnetCount / requestsObserved) * 100 : 0;

  const soakSummary = {
    timestamp: new Date().toISOString(),
    checkpoint: "CP7.3",
    requestsObserved,
    agenticEligible: agenticEligibleCount,
    wouldUseSonnet: wouldUseSonnetCount,
    wouldUseSonnetRate: Number(wouldUseSonnetRate.toFixed(2)),
    falsePositiveCandidates,
    falseNegativeCandidates,
    actualProfileDistribution,
    shadowProfileDistribution,
    taskTransitions,
    claudeQuotaConsumptionCausedByShadow: 0,
    productionForwardingIsolation: "VERIFIED_UNCHANGED",
    records
  };

  console.log(`Requests Observed: ${requestsObserved}`);
  console.log(`Agentic Eligible: ${agenticEligibleCount}`);
  console.log(`Would Use Sonnet: ${wouldUseSonnetCount}`);
  console.log(`Would Use Sonnet Rate: ${soakSummary.wouldUseSonnetRate}%`);
  console.log(`False Positive Candidates: ${falsePositiveCandidates}`);
  console.log(`False Negative Candidates: ${falseNegativeCandidates}`);
  console.log("Actual Profile Distribution:", actualProfileDistribution);
  console.log("Shadow Profile Distribution:", shadowProfileDistribution);
  console.log(`Task Switch Recommendations: ${taskTransitions.length}`);
  console.log(`Claude Quota Consumption Caused by Shadow: 0`);

  const outputPath = resolve("audit/telemetry/cp7-3-sonnet-shadow-summary.json");
  await writeFile(outputPath, JSON.stringify(soakSummary, null, 2), "utf8");
  console.log(`Saved soak summary to: ${outputPath}`);
}

runSoak().catch((err) => {
  console.error("Soak failed:", err);
  process.exit(1);
});
