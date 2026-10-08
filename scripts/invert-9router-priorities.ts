async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${txt}`);
  }
  return await res.json();
}

async function main() {
  console.log("=== 1. READ CURRENT STATE ===");
  const pData = await fetchJson("http://127.0.0.1:20128/api/providers");
  const sData = await fetchJson("http://127.0.0.1:20128/api/settings");

  const agConns = (pData.connections || []).filter((c: any) => c.provider === "antigravity");
  console.log(`Found ${agConns.length} Antigravity connections.`);

  if (agConns.length !== 2) {
    console.error("GATE FAILURE: Expected exactly 2 Antigravity connections, found", agConns.length);
    process.exit(1);
  }

  // Fetch usage for each to identify healthy vs reserve
  const connQuotas: Array<{ conn: any; quota: any; remainingPct: number }> = [];
  for (const c of agConns) {
    const uData = await fetchJson(`http://127.0.0.1:20128/api/usage/${c.id}`);
    const flash = uData.quotas?.["gemini-3.8-flash-high"] ?? uData.quotas?.["gemini-3.7-flash-high"] ?? {};
    connQuotas.push({
      conn: c,
      quota: flash,
      remainingPct: flash.remainingPercentage ?? 0
    });
  }

  // Sort descending by remaining quota
  connQuotas.sort((a, b) => b.remainingPct - a.remainingPct);
  const healthy = connQuotas[0];
  const reserve = connQuotas[1];

  console.log("Identified connections (anonymized):");
  console.log(`- healthy_account: remaining=${healthy.remainingPct.toFixed(2)}%, current_priority=${healthy.conn.priority}`);
  console.log(`- reserve_account: remaining=${reserve.remainingPct.toFixed(2)}%, current_priority=${reserve.conn.priority}`);

  console.log("\n=== 2. SAFETY GATE CHECK ===");
  const hasTwoConns = agConns.length === 2;
  const quotaMateriallyHigher = healthy.remainingPct > 50 && reserve.remainingPct < 10;
  const prioritiesInverted = reserve.conn.priority === 1 && healthy.conn.priority === 2;
  const roundRobinOff = (sData.capacityAdapter?.vision?.roundRobin ?? false) === false &&
                        Object.keys(sData.providerStrategies || {}).length === 0;

  console.log(`- Exactly 2 Antigravity connections: ${hasTwoConns ? "PASS" : "FAIL"}`);
  console.log(`- Healthy quota materially higher:     ${quotaMateriallyHigher ? "PASS" : "FAIL"}`);
  console.log(`- Priorities currently inverted:      ${prioritiesInverted ? "PASS" : "FAIL"}`);
  console.log(`- Round Robin OFF:                    ${roundRobinOff ? "PASS" : "FAIL"}`);

  if (!hasTwoConns || !quotaMateriallyHigher || !prioritiesInverted || !roundRobinOff) {
    console.error("SAFETY GATE FAILED. Aborting mutation.");
    process.exit(1);
  }
  console.log("ALL SAFETY GATES PASSED. Proceeding to update priorities via 9Router API...");

  // Capture pre-mutation snapshots from GET /api/providers/:id
  const preHealthy = await fetchJson(`http://127.0.0.1:20128/api/providers/${healthy.conn.id}`);
  const preReserve = await fetchJson(`http://127.0.0.1:20128/api/providers/${reserve.conn.id}`);

  console.log("\n=== 3. UPDATE PRIORITIES VIA PUT /api/providers/:id ===");

  // Update healthy account -> priority 1
  console.log("Setting healthy_account priority to 1...");
  const putHealthy = await fetchJson(`http://127.0.0.1:20128/api/providers/${healthy.conn.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priority: 1 })
  });
  console.log("PUT healthy_account response:", {
    success: !!putHealthy.connection,
    priority: putHealthy.connection?.priority
  });

  // Update reserve account -> priority 2
  console.log("Setting reserve_account priority to 2...");
  const putReserve = await fetchJson(`http://127.0.0.1:20128/api/providers/${reserve.conn.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priority: 2 })
  });
  console.log("PUT reserve_account response:", {
    success: !!putReserve.connection,
    priority: putReserve.connection?.priority
  });

  console.log("\n=== 4. VERIFY PERSISTENCE ===");
  // Immediate check
  const immData = await fetchJson("http://127.0.0.1:20128/api/providers");
  const immHealthy = immData.connections.find((c: any) => c.id === healthy.conn.id);
  const immReserve = immData.connections.find((c: any) => c.id === reserve.conn.id);
  console.log("Immediate GET /api/providers verification:");
  console.log(`- healthy_account priority: ${immHealthy?.priority} (expected: 1)`);
  console.log(`- reserve_account priority: ${immReserve?.priority} (expected: 2)`);

  // Bounded wait (3 seconds)
  console.log("Waiting 3 seconds to verify persistence...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Post-wait check
  const postData = await fetchJson("http://127.0.0.1:20128/api/providers");
  const postSettings = await fetchJson("http://127.0.0.1:20128/api/settings");

  const postHealthy = postData.connections.find((c: any) => c.id === healthy.conn.id);
  const postReserve = postData.connections.find((c: any) => c.id === reserve.conn.id);

  const healthyPriorityAfter = postHealthy?.priority;
  const reservePriorityAfter = postReserve?.priority;
  const rrAfter = (postSettings.capacityAdapter?.vision?.roundRobin ?? false) === false;

  console.log("Persistent GET /api/providers verification:");
  console.log(`- healthy_account priority: ${healthyPriorityAfter} (expected: 1)`);
  console.log(`- reserve_account priority: ${reservePriorityAfter} (expected: 2)`);
  console.log(`- Round Robin OFF: ${rrAfter ? "PASS" : "FAIL"}`);

  // Fetch full post-mutation snapshots to verify field immutability
  const postHealthyFull = await fetchJson(`http://127.0.0.1:20128/api/providers/${healthy.conn.id}`);
  const postReserveFull = await fetchJson(`http://127.0.0.1:20128/api/providers/${reserve.conn.id}`);

  function diffObjects(pre: Record<string, any>, post: Record<string, any>, ignoreKeys: string[] = ["updatedAt", "priority"]) {
    const changed: string[] = [];
    const allKeys = new Set([...Object.keys(pre), ...Object.keys(post)]);
    for (const k of allKeys) {
      if (ignoreKeys.includes(k)) continue;
      if (JSON.stringify(pre[k]) !== JSON.stringify(post[k])) {
        changed.push(`${k}: ${JSON.stringify(pre[k])} -> ${JSON.stringify(post[k])}`);
      }
    }
    return changed;
  }

  const healthyDiff = diffObjects(preHealthy.connection, postHealthyFull.connection);
  const reserveDiff = diffObjects(preReserve.connection, postReserveFull.connection);

  console.log("\nField immutability check:");
  console.log(`- healthy_account other changed fields: ${healthyDiff.length === 0 ? "NONE" : healthyDiff.join(", ")}`);
  console.log(`- reserve_account other changed fields: ${reserveDiff.length === 0 ? "NONE" : reserveDiff.join(", ")}`);

  const persistenceVerified = healthyPriorityAfter === 1 && reservePriorityAfter === 2;
  const otherFieldsUnchanged = healthyDiff.length === 0 && reserveDiff.length === 0;

  console.log("\n=== FINAL VERDICT SUMMARY ===");
  console.log(`HEALTHY ACCOUNT PRIORITY BEFORE: ${healthy.conn.priority}`);
  console.log(`HEALTHY ACCOUNT PRIORITY AFTER:  ${healthyPriorityAfter}`);
  console.log(`RESERVE ACCOUNT PRIORITY BEFORE: ${reserve.conn.priority}`);
  console.log(`RESERVE ACCOUNT PRIORITY AFTER:  ${reservePriorityAfter}`);
  console.log(`ROUND ROBIN:                     ${rrAfter ? "OFF" : "ON"}`);
  console.log(`PERSISTENCE VERIFIED:            ${persistenceVerified ? "YES" : "NO"}`);
  console.log(`OTHER FIELDS CHANGED:            ${otherFieldsUnchanged ? "NONE" : "DETECTED CHANGES"}`);
  console.log(`FINAL VERDICT:                   ${persistenceVerified && otherFieldsUnchanged ? "PRIORITY CHANGE ACTIVE" : "PRIORITY CHANGE FAILED"}`);
}

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
