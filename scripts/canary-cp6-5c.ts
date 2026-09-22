import "dotenv/config";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { NineRouterQuotaSource } from "../src/quota/source.js";

async function main() {
  console.log("=== CP6.5C NON-PRODUCTION QUOTA AUTO CANARY ===");

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
  console.log(`Canary running on http://127.0.0.1:${canaryPort} (v2 / auto / auto)`);

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
      name: "explicit review",
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
      console.log(`\nTesting [${tc.name.toUpperCase()}]...`);

      // 1. Debug route verification
      const routeRes = await fetch(`http://127.0.0.1:${canaryPort}/debug/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: tc.prompt }]
        })
      });

      if (!routeRes.ok) {
        const bodyText = await routeRes.text();
        throw new Error(`HTTP ${routeRes.status} on /debug/route ${tc.name}: ${bodyText}`);
      }

      const routeData = (await routeRes.json()) as any;
      const actualProfile = routeData.quota?.selectedProfile ?? routeData.selectedProfile;
      const actualModel = routeData.selectedModel;
      const switchReason = routeData.quota?.switchReason ?? "none";
      const selectionEffect = routeData.quota?.selectionEffect ?? "standard_routing";

      console.log(`  /debug/route -> profile: ${actualProfile}, model: ${actualModel}`);
      console.log(`  quota switchReason: ${switchReason}, selectionEffect: ${selectionEffect}`);

      if (actualProfile !== tc.expectedProfile) {
        throw new Error(`Profile mismatch for ${tc.name}: expected ${tc.expectedProfile}, got ${actualProfile}`);
      }
      if (actualModel !== tc.expectedModel) {
        throw new Error(`Model mismatch for ${tc.name}: expected ${tc.expectedModel}, got ${actualModel}`);
      }
      if (tc.expectedSwitchReason && switchReason !== tc.expectedSwitchReason) {
        throw new Error(`SwitchReason mismatch for ${tc.name}: expected ${tc.expectedSwitchReason}, got ${switchReason}`);
      }
      if (tc.expectedEffect && selectionEffect !== tc.expectedEffect) {
        throw new Error(`SelectionEffect mismatch for ${tc.name}: expected ${tc.expectedEffect}, got ${selectionEffect}`);
      }

      // 2. Real completion verification (HTTP 200)
      const compRes = await fetch(`http://127.0.0.1:${canaryPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: tc.prompt }],
          max_tokens: 20,
          stream: false
        })
      });

      console.log(`  /v1/chat/completions -> HTTP ${compRes.status} ${compRes.statusText}`);
      if (!compRes.ok) {
        const errText = await compRes.text();
        throw new Error(`HTTP ${compRes.status} on /v1/chat/completions ${tc.name}: ${errText}`);
      }

      const compData = (await compRes.json()) as any;
      console.log(`  completion model: ${compData.model}, content: ${JSON.stringify(compData.choices?.[0]?.message?.content?.slice(0, 50))}`);

      results[tc.name] = {
        routeStatus: routeRes.status,
        completionStatus: compRes.status,
        profile: actualProfile,
        model: actualModel,
        switchReason,
        selectionEffect,
        responseModel: compData.model
      };
    }

    console.log("\nALL 4 CANARY WORKLOADS PASSED SUCCESSFULLY (HTTP 200 + Correct Model Routing).");
  } finally {
    await canaryApp.close();
    quotaSource.close();
    console.log("Canary server closed cleanly.");
  }

  return results;
}

main().catch((err) => {
  console.error("CANARY FAILURE:", err);
  process.exit(1);
});
