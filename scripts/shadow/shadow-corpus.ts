import { DEFAULT_SHADOW_PROFILES } from "../../src/shadow-profiles.js";
import { routeShadow, type ShadowRequest } from "../../src/shadow-router.js";

const cases: Array<[string, ShadowRequest]> = [
  ["simple-chat", { sessionId: "chat", messages: [{ role: "user", content: "hello" }], policy: "balanced" }],
  ["simple-code", { sessionId: "code", messages: [{ role: "user", content: "fix this TypeScript error" }], policy: "balanced" }],
  ["repo-inspection", { sessionId: "inspect", messages: [{ role: "user", content: "inspect the repository, read files, and run tests" }], policy: "balanced" }],
  ["normal-implementation", { sessionId: "implementation", messages: [{ role: "user", content: "implement a small API endpoint" }], policy: "balanced" }],
  ["hard-debugging", { sessionId: "debug", messages: [{ role: "user", content: "debug a race condition in concurrent database writes" }], policy: "balanced" }],
  ["database-concurrency", { sessionId: "database", messages: [{ role: "user", content: "prove this transaction lock is safe under concurrent writes" }], policy: "balanced", riskHint: "high" }],
  ["analysis", { sessionId: "analysis", messages: [{ role: "user", content: "compare these two architecture trade-offs" }], policy: "balanced" }],
  ["research", { sessionId: "research", messages: [{ role: "user", content: "research the latest release and cite sources" }], policy: "balanced" }],
  ["long-easy-procedure", { sessionId: "long", messages: [{ role: "user", content: "step by step " + "document the routine process ".repeat(150) }], policy: "balanced" }],
  ["mixed-history", { sessionId: "mixed", history: ["design a distributed system", "debug a compiler"], currentIntent: "translate this sentence", messages: [{ role: "user", content: "translate this sentence" }], policy: "balanced" }]
];

const counts = { taskType: {} as Record<string, number>, complexity: {} as Record<string, number>, risk: {} as Record<string, number>, selectedProfile: {} as Record<string, number> };
for (const [name, request] of cases) {
  const result = routeShadow(request, DEFAULT_SHADOW_PROFILES);
  for (const [key, value] of [["taskType", result.taskType], ["complexity", result.complexity], ["risk", result.risk], ["selectedProfile", result.selectedProfile]] as const) counts[key][value] = (counts[key][value] ?? 0) + 1;
  console.log(`${name}: ${result.taskType}/${result.complexity}/${result.risk} -> ${result.selectedProfile}`);
}
console.log(JSON.stringify({ cases: cases.length, counts }, null, 2));
