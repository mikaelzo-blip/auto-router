import { createSessionStore, routeShadow, type ShadowRequest, type ExecutionProfile } from "../src/shadow-router.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";

export interface SessionTurn {
  step: string;
  intent: string;
  extra?: Partial<ShadowRequest>;
}

export interface SessionTrajectory {
  id: string;
  name: string;
  description: string;
  sessionId: string;
  turns: SessionTurn[];
}

export const CANONICAL_TRAJECTORIES: SessionTrajectory[] = [
  {
    id: "trajectory-a",
    name: "Trajectory A: End-to-End Bugfix & Delivery Cycle",
    description: "repo exploration -> implementation -> failing test -> diagnosis -> passing test -> docs",
    sessionId: "hermes-session-traj-a",
    turns: [
      {
        step: "repo exploration",
        intent: "Inspect repository structure and locate auth middleware in src/middleware/"
      },
      {
        step: "implementation",
        intent: "Implement role-based authorization check in src/middleware/auth.ts"
      },
      {
        step: "failing test",
        intent: "Run test suite on auth middleware after test failure",
        extra: {
          recentTestOutcome: "failed",
          recentFailure: "AssertionError: expected 403 but got 200 on missing role"
        }
      },
      {
        step: "diagnosis",
        intent: "Diagnose why role check allowed unauthenticated access and fix permission guard",
        extra: {
          recentFailure: "AssertionError: expected 403 but got 200 on missing role"
        }
      },
      {
        step: "passing test",
        intent: "Rerun test suite after fixing permission guard",
        extra: {
          recentTestOutcome: "passed"
        }
      },
      {
        step: "docs",
        intent: "Add JSDoc documentation and usage notes to auth middleware"
      }
    ]
  },
  {
    id: "trajectory-b",
    name: "Trajectory B: Routine Follow-up to Unrelated Hard Task",
    description: "simple task -> simple follow-up -> unrelated hard task",
    sessionId: "hermes-session-traj-b",
    turns: [
      {
        step: "simple task",
        intent: "Explain what an HTTP 502 status code means in plain terms"
      },
      {
        step: "simple follow-up",
        intent: "Summarize the explanation in one short sentence"
      },
      {
        step: "unrelated hard task",
        intent: "Prove that a concurrent lock-free queue with FAA is linearizable under arbitrary thread interleavings",
        extra: {
          riskHint: "high"
        }
      }
    ]
  },
  {
    id: "trajectory-c",
    name: "Trajectory C: Hard Reasoning to Resolution & Routine Follow-up",
    description: "hard task -> resolved hard reasoning -> routine follow-up",
    sessionId: "hermes-session-traj-c",
    turns: [
      {
        step: "hard task",
        intent: "Audit distributed payment webhook idempotency with critical financial double-spend risk",
        extra: {
          riskHint: "high"
        }
      },
      {
        step: "resolved hard reasoning",
        intent: "Implement strict database transaction with unique constraint on (provider, idempotency_key) and verified state machine",
        extra: {
          riskHint: "high"
        }
      },
      {
        step: "routine follow-up",
        intent: "Format the migration SQL file and fix table indentation",
        extra: {
          recentTestOutcome: "passed"
        }
      }
    ]
  }
];

export interface TurnEvaluationDetail {
  turn: number;
  step: string;
  intent: string;
  taskType: string;
  complexity: string;
  risk: string;
  tier: string;
  currentProfile?: string;
  selectedProfile: string;
  switched: boolean;
  switchReason: string;
  escalation: boolean;
  deEscalation: boolean;
}

export interface TrajectoryResult {
  trajectoryId: string;
  name: string;
  turnsCount: number;
  switchesCount: number;
  escalationCount: number;
  deEscalationCount: number;
  stickinessRate: number; // 0.0 - 1.0 (proportion of turns retaining existing profile when appropriate)
  turns: TurnEvaluationDetail[];
}

export interface SimulationSummary {
  totalTrajectories: number;
  totalTurns: number;
  totalSwitches: number;
  switchesPerSession: number;
  switchesPerTurn: number;
  totalEscalations: number;
  totalDeEscalations: number;
  overallStickinessRate: number;
  trajectories: TrajectoryResult[];
}

export function runSessionSimulation(
  profiles: ExecutionProfile[] = DEFAULT_SHADOW_PROFILES,
  trajectories: SessionTrajectory[] = CANONICAL_TRAJECTORIES
): SimulationSummary {
  const store = createSessionStore(300_000);
  const results: TrajectoryResult[] = [];

  let totalSwitches = 0;
  let totalTurns = 0;
  let totalEscalations = 0;
  let totalDeEscalations = 0;

  for (const traj of trajectories) {
    let trajSwitches = 0;
    let trajEscalations = 0;
    let trajDeEscalations = 0;
    const turnDetails: TurnEvaluationDetail[] = [];

    for (let i = 0; i < traj.turns.length; i++) {
      const turn = traj.turns[i]!;
      totalTurns++;

      const req: ShadowRequest = {
        sessionId: traj.sessionId,
        messages: [{ role: "user", content: turn.intent }],
        policy: "balanced",
        ...turn.extra
      };

      const decision = routeShadow(req, profiles, store);
      const hasPriorProfile = Boolean(decision.currentProfile);
      const didSwitch = Boolean(
        hasPriorProfile && decision.currentProfile !== decision.selectedProfile
      );

      const isEscalation = decision.switchReason === "quality_escalation" || decision.switchReason === "risk_increase";
      const isDeEscalation = decision.switchReason === "de_escalation";

      if (didSwitch) {
        trajSwitches++;
        totalSwitches++;
      }
      if (isEscalation && didSwitch) {
        trajEscalations++;
        totalEscalations++;
      }
      if (isDeEscalation && didSwitch) {
        trajDeEscalations++;
        totalDeEscalations++;
      }

      turnDetails.push({
        turn: i + 1,
        step: turn.step,
        intent: turn.intent.slice(0, 60),
        taskType: decision.taskType,
        complexity: decision.complexity,
        risk: decision.risk,
        tier: decision.minimumQualityTier,
        currentProfile: decision.currentProfile,
        selectedProfile: decision.selectedProfile,
        switched: didSwitch,
        switchReason: decision.switchReason,
        escalation: isEscalation,
        deEscalation: isDeEscalation
      });
    }

    // Stickiness: proportion of eligible follow-up turns where profile stayed sticky
    const followUpTurns = traj.turns.length - 1;
    const stickyTurns = followUpTurns - trajSwitches;
    const stickinessRate = followUpTurns > 0 ? +(Math.max(0, stickyTurns) / followUpTurns).toFixed(3) : 1.0;

    results.push({
      trajectoryId: traj.id,
      name: traj.name,
      turnsCount: traj.turns.length,
      switchesCount: trajSwitches,
      escalationCount: trajEscalations,
      deEscalationCount: trajDeEscalations,
      stickinessRate,
      turns: turnDetails
    });
  }

  const switchesPerSession = +(totalSwitches / trajectories.length).toFixed(2);
  const switchesPerTurn = +(totalSwitches / totalTurns).toFixed(3);
  const totalFollowUpTurns = totalTurns - trajectories.length;
  const overallStickinessRate =
    totalFollowUpTurns > 0 ? +((totalFollowUpTurns - totalSwitches) / totalFollowUpTurns).toFixed(3) : 1.0;

  return {
    totalTrajectories: trajectories.length,
    totalTurns,
    totalSwitches,
    switchesPerSession,
    switchesPerTurn,
    totalEscalations,
    totalDeEscalations,
    overallStickinessRate,
    trajectories: results
  };
}

if (process.argv[1]?.includes("simulate-sessions")) {
  const sim = runSessionSimulation();
  console.log("=== MULTI-TURN SESSION SIMULATION REPORT ===");
  console.log(`Trajectories: ${sim.totalTrajectories} | Turns: ${sim.totalTurns} | Total Switches: ${sim.totalSwitches}`);
  console.log(`Switches per Session: ${sim.switchesPerSession} | Switches per Turn: ${sim.switchesPerTurn}`);
  console.log(`Escalations: ${sim.totalEscalations} | De-escalations: ${sim.totalDeEscalations}`);
  console.log(`Overall Stickiness Rate: ${(sim.overallStickinessRate * 100).toFixed(1)}%`);
  console.log("\nTrajectory Breakdown:");
  for (const t of sim.trajectories) {
    console.log(`\n[${t.trajectoryId}] ${t.name} (Turns: ${t.turnsCount}, Switches: ${t.switchesCount}, Stickiness: ${(t.stickinessRate * 100).toFixed(1)}%)`);
    for (const turn of t.turns) {
      const switchStr = turn.switched ? `SWITCHED -> ${turn.selectedProfile} (${turn.switchReason})` : `STICKY [${turn.selectedProfile}]`;
      console.log(`  Turn ${turn.turn} [${turn.step.padEnd(22)}]: ${switchStr}`);
    }
  }
}
