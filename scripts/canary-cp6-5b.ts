import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { NineRouterQuotaSource } from "../src/quota/source.js";

async function main() {
  console.log("=== CP6.5B NON-PRODUCTION CANARY AUTO TESTING ===");

  const quotaSource = new NineRouterQuotaSource({
    baseUrl: "http://127.0.0.1:20128",
    timeoutMs: 5000
  });

  const baseConfig = await loadConfig();
  const canaryPort = 20206;
  const canaryApp = await buildApp({
    ...baseConfig,
    host: "127.0.0.1",
    port: canaryPort,
    routerMode: "v2",
    reasoningPolicy: "auto",
    quotaPolicy: "auto",
    quotaSource
  });

  await canaryApp.listen({ host: "127.0.0.1", port: canaryPort });
  console.log(`Canary running on http://127.0.0.1:${canaryPort}`);

  const testCases = [
    {
      name: "routine",
      expectedProfile: "gemini-flash-low",
      expectedModel: "ag/gemini-3.8-flash-low",
      prompt: "Format these key-value pairs into a clean markdown table: Host=127.0.0.1, Port=8080"
    },
    {
      name: "normal coding",
      expectedProfile: "gemini-flash-medium",
      expectedModel: "ag/gemini-3.8-flash-medium",
      prompt: "Write a TypeScript function to debounce an async function with leading and trailing options."
    },
    {
      name: "hard concurrency",
      expectedProfile: "gemini-flash-high",
      expectedModel: "ag/gemini-3.8-flash-high",
      prompt: "Implement a lock-free single-producer single-consumer ring buffer in C++ with atomic memory order semantics."
    },
    {
      name: "review",
      expectedProfile: "gemini-flash-high",
      expectedModel: "ag/gemini-3.8-flash-high",
      expectedSwitchReason: "quota_exhausted",
      expectedEffect: "avoided_exhausted_luna-review",
      prompt: "Please review this PR diff for security vulnerabilities, SQL injection, and race conditions."
    }
  ];

  const results: Record<string, any> = {};

  try {
    for (const tc of testCases) {
      const res = await fetch(`http://127.0.0.1:${canaryPort}/debug/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: tc.prompt }]
        })
      });

      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(`HTTP ${res.status} on ${tc.name}: ${bodyText}`);
      }

      const data = await res.json() as any;
      console.log(`\n[${tc.name.toUpperCase()}] HTTP ${res.status}`);
      console.log(`  selectedProfile: ${data.quota?.selectedProfile ?? data.selectedProfile}`);
      console.log(`  selectedModel:   ${data.selectedModel}`);
      console.log(`  switchReason:    ${data.quota?.switchReason}`);
      console.log(`  selectionEffect: ${data.quota?.selectionEffect}`);

      const actualProfile = data.quota?.selectedProfile ?? data.selectedProfile;
      const actualModel = data.selectedModel;

      if (actualProfile !== tc.expectedProfile) {
        throw new Error(`Profile mismatch for ${tc.name}: expected ${tc.expectedProfile}, got ${actualProfile}`);
      }
      if (actualModel !== tc.expectedModel) {
        throw new Error(`Model mismatch for ${tc.name}: expected ${tc.expectedModel}, got ${actualModel}`);
      }

      results[tc.name] = {
        status: res.status,
        profile: actualProfile,
        model: actualModel,
        switchReason: data.quota?.switchReason ?? "none",
        selectionEffect: data.quota?.selectionEffect ?? "standard_routing"
      };
    }

    console.log("\nALL CANARY WORKLOADS PASSED PERFECTLY.");
  } finally {
    await canaryApp.close();
    quotaSource.close();
    console.log("Canary server stopped cleanly.");
  }

  return results;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
