import { DatabaseSync } from "node:sqlite";

async function fetchJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return await res.json();
}

async function getAccountInfo() {
  const pData = await fetchJson("http://127.0.0.1:20128/api/providers");
  const agConns = (pData.connections || []).filter((c: any) => c.provider === "antigravity");

  const accounts: Array<{ id: string; priority: number; remainingPct: number; used: number; total: number }> = [];
  for (const c of agConns) {
    const u = await fetchJson(`http://127.0.0.1:20128/api/usage/${c.id}`);
    const flash = u.quotas?.["gemini-3.8-flash-high"] ?? u.quotas?.["gemini-3.7-flash-high"] ?? {};
    accounts.push({
      id: c.id,
      priority: c.priority,
      used: flash.used ?? 0,
      total: flash.total ?? 1000,
      remainingPct: flash.remainingPercentage ?? 0
    });
  }

  accounts.sort((a, b) => b.remainingPct - a.remainingPct);
  return {
    healthy: accounts[0],
    reserve: accounts[1]
  };
}

async function main() {
  console.log("=== STEP 6 & 7: VERIFY ACCOUNT DISPATCH & CONSERVATION (QUOTA_POLICY=auto) ===");

  const startAccounts = await getAccountInfo();
  console.log("\n[1] STARTING ACCOUNT QUOTAS:");
  console.log(`- healthy_account: priority=${startAccounts.healthy.priority}, quota=${startAccounts.healthy.remainingPct.toFixed(4)}% (used: ${startAccounts.healthy.used}/${startAccounts.healthy.total})`);
  console.log(`- reserve_account: priority=${startAccounts.reserve.priority}, quota=${startAccounts.reserve.remainingPct.toFixed(4)}% (used: ${startAccounts.reserve.used}/${startAccounts.reserve.total})`);

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
  const healthyInitialCnt = initialCounts[startAccounts.healthy.id] ?? 0;
  const reserveInitialCnt = initialCounts[startAccounts.reserve.id] ?? 0;
  console.log("\n[2] INITIAL 9ROUTER SERVED REQUEST COUNTS:");
  console.log(`- healthy_account initial total: ${healthyInitialCnt}`);
  console.log(`- reserve_account initial total: ${reserveInitialCnt}`);

  // 15 representative requests: 5 routine, 5 normal coding, 5 hard reasoning
  const requests = [
    // Routine
    { cat: "routine", prompt: "Format these key-value pairs into a clean markdown table: Host=127.0.0.1, Port=8080" },
    { cat: "routine", prompt: "Convert this comma-separated list into numbered markdown: red, blue, green, yellow" },
    { cat: "routine", prompt: "Summarize in one sentence: HTTP status 200 means OK, 404 means Not Found, 500 means Internal Server Error." },
    { cat: "routine", prompt: "Capitalize each word: fast automated semantic model routing engine" },
    { cat: "routine", prompt: "Return the single word: ACKNOWLEDGED" },
    // Normal coding
    { cat: "normal coding", prompt: "Write a TypeScript function to debounce an async function with leading and trailing options." },
    { cat: "normal coding", prompt: "Write a Python function to safely validate and parse an IPv4 or IPv6 address string." },
    { cat: "normal coding", prompt: "Write a JavaScript function to flatten an array of nested objects up to a given depth." },
    { cat: "normal coding", prompt: "Write a Go function to compute the SHA-256 hash of a byte slice and return hex string." },
    { cat: "normal coding", prompt: "Write a Rust function that splits a string on commas and parses each item as u32." },
    // Hard reasoning
    { cat: "hard reasoning", prompt: "Implement a lock-free single-producer single-consumer ring buffer in C++ with atomic memory order semantics." },
    { cat: "hard reasoning", prompt: "Analyze potential deadlock scenarios in two-phase locking with distributed transactions across three shards." },
    { cat: "hard reasoning", prompt: "Formalize the safety invariants for Raft consensus leader election during asymmetric network partitions." },
    { cat: "hard reasoning", prompt: "Design an idempotent payment ledger allocation state machine with optimistic concurrency control and rollback guarantees." },
    { cat: "hard reasoning", prompt: "Prove or disprove whether strict serializability is preserved under snapshot isolation with read-only transaction anomalies." }
  ];

  console.log(`\n[3] SENDING ${requests.length} BOUNDED REQUESTS TO PRODUCTION (127.0.0.1:20200)...`);
  const dispatchRecords: any[] = [];
  let healthyServedCount = 0;
  let reserveServedCount = 0;

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const started = Date.now();
    try {
      const resp = await fetch("http://127.0.0.1:20200/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: req.prompt }],
          max_tokens: 60,
          stream: false
        })
      });

      const latency = Date.now() - started;
      const respJson = await resp.json() as any;

      const latestStmt = db.prepare(`
        SELECT id, timestamp, provider, model, connectionId, status
        FROM requestDetails
        ORDER BY timestamp DESC
        LIMIT 1
      `);
      const latest = latestStmt.get() as any;

      let servedAccount = "unknown";
      if (latest?.connectionId === startAccounts.healthy.id) {
        servedAccount = "healthy_account";
        healthyServedCount++;
      } else if (latest?.connectionId === startAccounts.reserve.id) {
        servedAccount = "reserve_account";
        reserveServedCount++;
      }

      console.log(`Req ${String(i + 1).padStart(2)}/15 [${req.cat.padEnd(14)}]: status=${resp.status}, latency=${String(latency).padStart(4)}ms, model=${respJson.model} -> servedBy=${servedAccount}`);

      dispatchRecords.push({
        index: i + 1,
        category: req.cat,
        status: resp.status,
        latencyMs: latency,
        responseModel: respJson.model,
        servedAccount,
        status9Router: latest?.status,
        model9Router: latest?.model
      });
    } catch (err: any) {
      console.error(`Req ${i + 1} error:`, err.message);
    }
  }

  db.close();

  console.log("\n[4] CAPTURING ENDING QUOTA...");
  const endAccounts = await getAccountInfo();
  console.log(`- healthy_account: quota=${endAccounts.healthy.remainingPct.toFixed(4)}% (used: ${endAccounts.healthy.used}/${endAccounts.healthy.total})`);
  console.log(`- reserve_account: quota=${endAccounts.reserve.remainingPct.toFixed(4)}% (used: ${endAccounts.reserve.used}/${endAccounts.reserve.total})`);

  const healthyUsedDelta = endAccounts.healthy.used - startAccounts.healthy.used;
  const reserveUsedDelta = endAccounts.reserve.used - startAccounts.reserve.used;

  console.log("\n=== DISPATCH & QUOTA VERIFICATION SUMMARY ===");
  console.log(`Total Requests Sent:        ${requests.length}`);
  console.log(`Healthy Account Requests:   ${healthyServedCount}`);
  console.log(`Reserve Account Requests:   ${reserveServedCount}`);
  console.log(`Healthy Quota Change:       ${startAccounts.healthy.remainingPct.toFixed(4)}% -> ${endAccounts.healthy.remainingPct.toFixed(4)}% (used delta: +${healthyUsedDelta})`);
  console.log(`Reserve Quota Change:       ${startAccounts.reserve.remainingPct.toFixed(4)}% -> ${endAccounts.reserve.remainingPct.toFixed(4)}% (used delta: +${reserveUsedDelta})`);

  const healthyServesAll = healthyServedCount === requests.length;
  const reserveConserved = reserveServedCount === 0 && reserveUsedDelta === 0;

  console.log("\nGATES:");
  console.log(`- Healthy Account Receives All Traffic (100%): ${healthyServesAll ? "PASS" : "FAIL"}`);
  console.log(`- Reserve Account Zero Requests & Conserved:   ${reserveConserved ? "PASS" : "FAIL"}`);

  if (!healthyServesAll || !reserveConserved) {
    console.error("STOP CONDITION TRIGGERED: Reserve account was not fully conserved or healthy account did not serve all traffic.");
    process.exit(1);
  } else {
    console.log("ALL DISPATCH & CONSERVATION GATES PASSED.");
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
