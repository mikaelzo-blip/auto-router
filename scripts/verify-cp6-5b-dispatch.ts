import { DatabaseSync } from "node:sqlite";

async function fetchJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return await res.json();
}

async function getAccountQuotas() {
  const ag1 = await fetchJson("http://127.0.0.1:20128/api/usage/b59bebec-107b-4fde-917e-cc627864df88");
  const ag2 = await fetchJson("http://127.0.0.1:20128/api/usage/4acde0a7-dcbb-4e53-bde5-4d0c5f5049d5");

  function extract(u: any) {
    const flash = u.quotas?.["gemini-3.8-flash-high"] ?? u.quotas?.["gemini-3.7-flash-high"] ?? {};
    const weekly = u.quotas?.["gemini_weekly"] ?? {};
    return {
      used: flash.used ?? 0,
      total: flash.total ?? 1000,
      remaining: (flash.total ?? 1000) - (flash.used ?? 0),
      remainingPercentage: flash.remainingPercentage ?? 0,
      weeklyUsed: weekly.used ?? 0,
      weeklyPercentage: weekly.remainingPercentage ?? 0
    };
  }

  return {
    account_1: extract(ag1), // reserve (b59bebec)
    account_2: extract(ag2)  // healthy (4acde0a7)
  };
}

async function main() {
  console.log("=== CP6.5B: REAL DISPATCH & QUOTA VERIFICATION ===");

  const startQuotas = await getAccountQuotas();
  console.log("\nSTARTING QUOTAS:");
  console.log("Account 1 (reserve):", startQuotas.account_1);
  console.log("Account 2 (healthy):", startQuotas.account_2);

  const db = new DatabaseSync("C:/Users/Fikri/AppData/Roaming/9router/db/data.sqlite", { open: true, readOnly: true });

  const startCountsStmt = db.prepare(`
    SELECT connectionId, COUNT(*) as cnt
    FROM requestDetails
    WHERE provider='antigravity'
    GROUP BY connectionId
  `);
  const initialCountsRows = startCountsStmt.all() as Array<{ connectionId: string; cnt: number }>;
  const initialCounts: Record<string, number> = {};
  for (const r of initialCountsRows) {
    initialCounts[r.connectionId] = r.cnt;
  }
  console.log("\nINITIAL 9ROUTER REQUEST COUNTS:", initialCounts);

  // Send 10 bounded real Gemini requests to 127.0.0.1:20200
  console.log("\nSending 10 bounded real Gemini requests to 127.0.0.1:20200...");
  const results: any[] = [];
  const prompts = [
    "Return the single word: apple",
    "Return the single word: banana",
    "Return the single word: cherry",
    "Return the single word: date",
    "Return the single word: elderberry",
    "Return the single word: fig",
    "Return the single word: grape",
    "Return the single word: honeydew",
    "Return the single word: kiwi",
    "Return the single word: lemon"
  ];

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const started = Date.now();
    try {
      const resp = await fetch("http://127.0.0.1:20200/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: prompt }]
        })
      });
      const latency = Date.now() - started;
      const bodyText = await resp.text();

      // Check the latest request from requestDetails in 9Router
      const latestStmt = db.prepare(`
        SELECT id, timestamp, provider, model, connectionId, status
        FROM requestDetails
        ORDER BY timestamp DESC
        LIMIT 1
      `);
      const latest = latestStmt.get() as any;

      const servedAccount = latest?.connectionId === "b59bebec-107b-4fde-917e-cc627864df88"
        ? "account_1"
        : latest?.connectionId === "4acde0a7-dcbb-4e53-bde5-4d0c5f5049d5"
          ? "account_2"
          : "unknown";

      console.log(`Req ${i + 1}/${prompts.length}: status=${resp.status}, latency=${latency}ms -> servedBy=${servedAccount} (${latest?.connectionId?.slice(0, 8)}...)`);

      results.push({
        reqIndex: i + 1,
        status: resp.status,
        latencyMs: latency,
        servedAccount,
        connectionId: latest?.connectionId,
        timestamp: latest?.timestamp
      });
    } catch (err: any) {
      console.error(`Req ${i + 1} error:`, err.message);
    }
  }

  // Final counts
  const finalCountsRows = startCountsStmt.all() as Array<{ connectionId: string; cnt: number }>;
  const finalCounts: Record<string, number> = {};
  for (const r of finalCountsRows) {
    finalCounts[r.connectionId] = r.cnt;
  }
  db.close();

  const delta1 = (finalCounts["b59bebec-107b-4fde-917e-cc627864df88"] ?? 0) - (initialCounts["b59bebec-107b-4fde-917e-cc627864df88"] ?? 0);
  const delta2 = (finalCounts["4acde0a7-dcbb-4e53-bde5-4d0c5f5049d5"] ?? 0) - (initialCounts["4acde0a7-dcbb-4e53-bde5-4d0c5f5049d5"] ?? 0);

  const endQuotas = await getAccountQuotas();
  console.log("\nENDING QUOTAS:");
  console.log("Account 1 (reserve):", endQuotas.account_1);
  console.log("Account 2 (healthy):", endQuotas.account_2);

  console.log("\nSUMMARY OF DISPATCH:");
  console.log(`Account 1 (reserve) Requests: ${delta1}`);
  console.log(`Account 2 (healthy) Requests: ${delta2}`);
  console.log(`Account 1 Starting Quota: ${startQuotas.account_1.remainingPercentage.toFixed(4)}%`);
  console.log(`Account 1 Ending Quota:   ${endQuotas.account_1.remainingPercentage.toFixed(4)}%`);
  console.log(`Account 2 Starting Quota: ${startQuotas.account_2.remainingPercentage.toFixed(4)}%`);
  console.log(`Account 2 Ending Quota:   ${endQuotas.account_2.remainingPercentage.toFixed(4)}%`);

  const account1Conserved = delta1 === 0 && (startQuotas.account_1.used === endQuotas.account_1.used);
  const account2Active = delta2 > 0;
  console.log("\nGATES:");
  console.log(`Account 2 Serves Requests: ${account2Active ? "PASS" : "FAIL"}`);
  console.log(`Account 1 Conserved:       ${account1Conserved ? "PASS" : "FAIL"}`);
}

main().catch(console.error);
