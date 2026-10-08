async function runSmoke() {
  console.log("=== STEP 5: PRODUCTION SMOKE TEST (PORT 20200, QUOTA_POLICY=auto) ===");

  const testCases = [
    {
      category: "A. routine",
      expectedProfile: "gemini-flash-low",
      expectedModel: "ag/gemini-3.8-flash-low",
      prompt: "Format these key-value pairs into a clean markdown table: Host=127.0.0.1, Port=8080"
    },
    {
      category: "B. normal coding",
      expectedProfile: "gemini-flash-medium",
      expectedModel: "ag/gemini-3.8-flash-medium",
      prompt: "Write a TypeScript function to debounce an async function with leading and trailing options."
    },
    {
      category: "C. hard/concurrency",
      expectedProfile: "gemini-flash-high",
      expectedModel: "ag/gemini-3.8-flash-high",
      prompt: "Implement a lock-free single-producer single-consumer ring buffer in C++ with atomic memory order semantics."
    },
    {
      category: "D. explicit review",
      expectedProfile: "gemini-flash-high",
      expectedModel: "ag/gemini-3.8-flash-high",
      prompt: "Please review this PR diff for security vulnerabilities, SQL injection, and race conditions."
    }
  ];

  const results: any[] = [];

  for (const tc of testCases) {
    console.log(`\n--- Testing ${tc.category} ---`);

    // 1. Check /debug/route
    const debugRes = await fetch("http://127.0.0.1:20200/debug/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: tc.prompt }]
      })
    });

    if (!debugRes.ok) {
      throw new Error(`Debug route failed with HTTP ${debugRes.status}`);
    }
    const debugData = await debugRes.json() as any;
    console.log(`  Debug Route: selectedProfile=${debugData.selectedProfile}, selectedModel=${debugData.selectedModel}`);
    console.log(`  Quota Debug: policy=${debugData.quota?.policy}, status=${debugData.quota?.status}, wouldSwitch=${debugData.quota?.wouldSwitch}, switchReason=${debugData.quota?.switchReason}`);

    // 2. Execute live /v1/chat/completions non-streaming
    const started = Date.now();
    const compRes = await fetch("http://127.0.0.1:20200/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: tc.prompt }],
        max_tokens: 60,
        stream: false
      })
    });
    const latency = Date.now() - started;

    const headers = Object.fromEntries(compRes.headers.entries());
    const profile = headers["x-auto-router-profile"];
    const model = headers["x-auto-router-model"];
    const mode = headers["x-auto-router-mode"];
    const reasoningPolicy = headers["x-auto-router-reasoning-policy"];
    const quotaPolicy = headers["x-auto-router-quota-policy"];
    const quotaEffect = headers["x-auto-router-quota-effect"];

    console.log(`  Live Completion: status=${compRes.status}, latency=${latency}ms`);
    console.log(`  Headers: mode=${mode}, profile=${profile}, model=${model}, reasoningPolicy=${reasoningPolicy}, quotaPolicy=${quotaPolicy}, quotaEffect=${quotaEffect}`);

    if (compRes.status !== 200) {
      throw new Error(`HTTP status ${compRes.status} on live completion`);
    }

    const compData = await compRes.json() as any;
    const upstreamModel = compData.model;
    console.log(`  Upstream response model: ${upstreamModel}`);

    // Verification checks
    const isSol = profile === "sol" || model?.includes("sol");
    const isAstra = profile === "astra" || model?.includes("astra");
    const isExhaustedCodex = model?.startsWith("cx/");

    if (isSol) throw new Error("CRITICAL SAFETY FAILURE: Sol activated unexpectedly!");
    if (isAstra) throw new Error("CRITICAL SAFETY FAILURE: Astra activated unexpectedly!");
    if (isExhaustedCodex) throw new Error("CRITICAL SAFETY FAILURE: Known-exhausted Codex requested!");

    results.push({
      category: tc.category,
      expectedProfile: tc.expectedProfile,
      actualProfile: profile,
      expectedModel: tc.expectedModel,
      actualModel: model,
      upstreamModel,
      httpStatus: compRes.status,
      latencyMs: latency,
      mode,
      reasoningPolicy,
      quotaPolicy,
      noSolAstra: !isSol && !isAstra,
      noExhaustedCodex: !isExhaustedCodex
    });
  }

  console.log("\n=== SMOKE TEST SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));

  for (const r of results) {
    if (r.httpStatus !== 200) throw new Error(`Smoke test failed HTTP 200 requirement on ${r.category}`);
    if (r.actualProfile !== r.expectedProfile) throw new Error(`Smoke test profile mismatch on ${r.category}: expected ${r.expectedProfile}, got ${r.actualProfile}`);
  }

  console.log("\nALL PRODUCTION SMOKE TESTS PASSED (HTTP 200, Exact Profiles, Zero Sol/Astra/Exhausted Codex)");
}

runSmoke().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
