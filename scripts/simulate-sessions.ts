import { createSessionStore, routeShadow, type ShadowRequest } from "../src/shadow-router.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";

interface Turn {
  intent: string;
  extra?: Partial<ShadowRequest>;
}

interface SessionScenario {
  name: string;
  sessionId: string;
  turns: Turn[];
}

const scenarios: SessionScenario[] = [
  {
    name: "Scenario 1: Routine Feature Implementation (High Stickiness)",
    sessionId: "session-routine-1",
    turns: [
      { intent: "Inspect repository structure for auth middleware" },
      { intent: "Read auth.ts and locate the token verification function" },
      { intent: "Implement role-based authorization check in auth.ts" },
      { intent: "Run npm test on auth.test.ts" }
    ]
  },
  {
    name: "Scenario 2: Failure Escalation & Passing De-escalation",
    sessionId: "session-escalation-2",
    turns: [
      { intent: "Implement concurrent account balance transfer endpoint" },
      {
        intent: "Debug the race condition after tests failed",
        extra: { recentTestOutcome: "failed", recentFailure: "Deadlock detected in concurrent transfer" }
      },
      { intent: "Fix the deadlock using SELECT FOR UPDATE with ascending ID lock ordering", extra: { riskHint: "high" } },
      { intent: "Run the concurrent transfer test suite again", extra: { recentTestOutcome: "passed" } },
      { intent: "Add JSDoc documentation to the transfer function" }
    ]
  },
  {
    name: "Scenario 3: Critical Security & Financial Risk",
    sessionId: "session-security-3",
    turns: [
      { intent: "Examine security boundary in payment webhook receiver" },
      { intent: "Analyze distributed double-spend race condition with critical financial risk", extra: { riskHint: "high" } },
      { intent: "Continue auditing state machine transitions and retry semantics", extra: { riskHint: "high" } }
    ]
  },
  {
    name: "Scenario 4: Multi-turn Routine Refactoring",
    sessionId: "session-refactor-4",
    turns: [
      { intent: "Format code and fix indentation in routes.ts" },
      { intent: "Rename helper function in routes.ts" },
      { intent: "Update import paths across 3 files" },
      { intent: "Check for any unused imports" },
      { intent: "Add comments explaining the changes" }
    ]
  }
];

export function runSessionSimulation(profiles = DEFAULT_SHADOW_PROFILES) {
  const store = createSessionStore(300_000);
  const results = [];
  let totalSwitches = 0;
  let totalTurns = 0;

  for (const s of scenarios) {
    let sessionSwitches = 0;
    const turnDetails = [];

    for (let i = 0; i < s.turns.length; i++) {
      const t = s.turns[i]!;
      totalTurns++;
      const req: ShadowRequest = {
        sessionId: s.sessionId,
        messages: [{ role: "user", content: t.intent }],
        policy: "balanced",
        ...t.extra
      };

      const decision = routeShadow(req, profiles, store);
      if (decision.switchRecommended && decision.currentProfile && decision.currentProfile !== decision.selectedProfile) {
        sessionSwitches++;
        totalSwitches++;
      }

      turnDetails.push({
        turn: i + 1,
        intent: t.intent.slice(0, 50),
        taskType: decision.taskType,
        complexity: decision.complexity,
        tier: decision.minimumQualityTier,
        current: decision.currentProfile,
        selected: decision.selectedProfile,
        switched: decision.switchRecommended && decision.currentProfile !== decision.selectedProfile,
        reason: decision.switchReason
      });
    }

    results.push({
      scenario: s.name,
      turns: s.turns.length,
      switches: sessionSwitches,
      switchesPerTurn: +(sessionSwitches / s.turns.length).toFixed(3),
      details: turnDetails
    });
  }

  const switchesPerSession = +(totalSwitches / scenarios.length).toFixed(2);
  const switchesPerTurn = +(totalSwitches / totalTurns).toFixed(3);

  return {
    scenarios: results,
    totalTurns,
    totalSwitches,
    switchesPerSession,
    switchesPerTurn
  };
}

if (process.argv[1]?.includes("simulate-sessions")) {
  const sim = runSessionSimulation();
  console.log("=== MULTI-TURN SESSION STICKINESS SIMULATION ===");
  console.log(`Total Scenarios: ${scenarios.length} | Total Turns: ${sim.totalTurns} | Total Switches: ${sim.totalSwitches}`);
  console.log(`Switches per Session: ${sim.switchesPerSession} | Switches per Turn: ${sim.switchesPerTurn}`);
  console.log(JSON.stringify(sim, null, 2));
}
