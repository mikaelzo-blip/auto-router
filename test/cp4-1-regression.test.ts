import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  routeShadow,
  validateProfileCoverage,
  createSessionStore,
  type ExecutionProfile,
  type ShadowRequest
} from "../src/shadow-router.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";

describe("CP4.1 Release Verification & Sol Challenger Regressions", () => {
  // Test profile fixtures with Sol and Terra enabled
  const profilesWithSol: ExecutionProfile[] = DEFAULT_SHADOW_PROFILES.map((p) => {
    if (p.id === "sol") return { ...p, enabled: true };
    return p;
  });

  const baseReq = (content: string, extra: Partial<ShadowRequest> = {}): ShadowRequest => ({
    sessionId: "test-sess-" + Math.random().toString(36).slice(2),
    messages: [{ role: "user", content }],
    policy: "balanced",
    ...extra
  });

  describe("1. Sol heavy-reasoning eligibility", () => {
    it("makes Sol eligible when explicit extreme reasoning is required on hard tasks", () => {
      const decision = routeShadow(
        baseReq("Formal proof and deep verification of concurrent non-blocking transaction ordering", {
          requiresExtremeReasoning: true
        }),
        profilesWithSol
      );
      expect(decision.selectedProfile).toBe("sol");
      expect(decision.minimumQualityTier).toBe("strong");
    });

    it("makes Sol eligible after repeated failure count >= 2 on strong tasks", () => {
      const decision = routeShadow(
        baseReq("Solve persistent memory corruption in lock-free queue after 2 failed attempts", {
          recentFailureCount: 2,
          recentFailure: "AssertionError: Linearizability violation at step 4"
        }),
        profilesWithSol
      );
      expect(decision.selectedProfile).toBe("sol");
    });
  });

  describe("2. Sol not selected for trivial work", () => {
    it("never routes trivial greetings or routine tasks to Sol even if Sol is enabled", () => {
      expect(routeShadow(baseReq("hello there"), profilesWithSol).selectedProfile).toBe("gemini-flash-low");
      expect(routeShadow(baseReq("format this markdown table"), profilesWithSol).selectedProfile).toBe("gemini-flash-low");
      expect(routeShadow(baseReq("write a simple utility function to sum numbers"), profilesWithSol).selectedProfile).toBe("gemini-flash-medium");
    });

    it("does not select Sol for prompt length alone without extreme reasoning need", () => {
      const longRoutinePrompt = "Explain basic git commands in detail: " + "commit push pull branch status ".repeat(200);
      const decision = routeShadow(baseReq(longRoutinePrompt), profilesWithSol);
      expect(decision.selectedProfile).not.toBe("sol");
    });
  });

  describe("3. Infrastructure failure does not semantic-escalate to Sol", () => {
    it("does not escalate to Sol on timeout, 429, or 5xx infrastructure failures", () => {
      const store = createSessionStore(60_000);
      const sessId = "sess-infra-test";

      // Turn 1: On Gemini High
      routeShadow(
        baseReq("Debug database deadlock with row lock ordering", { sessionId: sessId }),
        profilesWithSol,
        store
      );

      // Turn 2: Upstream provider timed out / 503
      const timeoutDecision = routeShadow(
        baseReq("Debug database deadlock with row lock ordering", {
          sessionId: sessId,
          failureType: "timeout",
          recentFailure: "Gateway timeout 504"
        }),
        profilesWithSol,
        store
      );
      expect(timeoutDecision.selectedProfile).not.toBe("sol");

      const rateLimitDecision = routeShadow(
        baseReq("Debug database deadlock with row lock ordering", {
          sessionId: sessId,
          failureType: "429",
          recentFailure: "Rate limit 429 exceeded"
        }),
        profilesWithSol,
        store
      );
      expect(rateLimitDecision.selectedProfile).not.toBe("sol");
    });
  });

  describe("4. Quality failure can make Sol eligible", () => {
    it("escalates to Sol when previous Gemini High run produced an observable test failure", () => {
      const store = createSessionStore(60_000);
      const sessId = "sess-quality-fail";

      // Turn 1 on Gemini High
      const turn1 = routeShadow(
        baseReq("Implement concurrent two-phase commit coordinator with distributed fencing tokens", { sessionId: sessId }),
        profilesWithSol,
        store
      );
      expect(turn1.selectedProfile).toBe("gemini-flash-high");

      // Turn 2: Tests failed on Gemini High
      const escalated = routeShadow(
        baseReq("Diagnose race condition in two-phase commit coordinator: test failed with split-brain error", {
          sessionId: sessId,
          recentTestOutcome: "failed",
          recentFailure: "SplitBrainException in coordinator election"
        }),
        profilesWithSol,
        store
      );

      expect(escalated.selectedProfile).toBe("sol");
      expect(escalated.switchReason).toBe("quality_escalation");
    });
  });

  describe("5. De-escalation after Sol success", () => {
    it("de-escalates from Sol to Gemini Medium or Low after passing verification and does not lock session", () => {
      const store = createSessionStore(60_000);
      const sessId = "sess-de-escalate";

      // Turn 1: Escalated to Sol
      const turn1 = routeShadow(
        baseReq("Formal proof of lock-free queue linearizability", {
          sessionId: sessId,
          requiresExtremeReasoning: true
        }),
        profilesWithSol,
        store
      );
      expect(turn1.selectedProfile).toBe("sol");

      // Turn 2: Sol solved it, verification passed, now routine next task
      const turn2 = routeShadow(
        baseReq("Add unit test comments and update README documentation for the queue", {
          sessionId: sessId,
          recentTestOutcome: "passed"
        }),
        profilesWithSol,
        store
      );

      expect(turn2.selectedProfile).not.toBe("sol");
      expect(turn2.selectedProfile).toBe("gemini-flash-medium");
      expect(turn2.switchReason).toBe("de_escalation");
      expect(turn2.switchRecommended).toBe(true);

      // Turn 3: Trivial formatting task
      const turn3 = routeShadow(
        baseReq("Format the changelog entry into a concise markdown bullet list", {
          sessionId: sessId
        }),
        profilesWithSol,
        store
      );
      expect(turn3.selectedProfile).toBe("gemini-flash-low");
    });
  });

  describe("6. Provider diversity & resilience behavior", () => {
    it("routes to Terra (cx) when AG provider path is unavailable, without escalating to Sol", () => {
      const decision = routeShadow(
        baseReq("Implement zero-downtime database migration for user settings", {
          unavailableProviders: ["ag"]
        }),
        profilesWithSol
      );
      // AG models are filtered out; Terra (cx) is selected, not Sol
      expect(decision.selectedProfile).toBe("terra");
    });

    it("includes Terra as a top alternative candidate for Gemini High during normal operation", () => {
      const decision = routeShadow(
        baseReq("Implement PostgreSQL deadlock avoidance in fund transfers"),
        DEFAULT_SHADOW_PROFILES
      );
      expect(decision.selectedProfile).toBe("gemini-flash-high");
      expect(decision.alternatives).toContain("terra");
    });
  });

  describe("7. Astra remains disabled", () => {
    it("verifies Astra is disabled in DEFAULT_SHADOW_PROFILES and is never selected", () => {
      const astraProfile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "astra");
      expect(astraProfile).toBeDefined();
      expect(astraProfile?.enabled).toBe(false);

      const decision = routeShadow(
        baseReq("Deploy critical production cluster with maximum frontier intelligence"),
        DEFAULT_SHADOW_PROFILES
      );
      expect(decision.selectedProfile).not.toBe("astra");
      expect(decision.alternatives).not.toContain("astra");
    });
  });

  describe("8. Frontier-free routing", () => {
    it("serves critical requests safely without throwing when FRONTIER is unassigned", () => {
      // In DEFAULT_SHADOW_PROFILES, both claude-opus and astra are enabled: false
      expect(DEFAULT_SHADOW_PROFILES.filter((p) => p.enabled && p.qualityTier === "frontier")).toHaveLength(0);

      expect(() => {
        const decision = routeShadow(
          baseReq("Solve critical architectural trade-off for distributed consensus"),
          DEFAULT_SHADOW_PROFILES
        );
        expect(["gemini-flash-high", "terra"]).toContain(decision.selectedProfile);
      }).not.toThrow();
    });

    it("validates profile coverage without requiring frontier when frontier is unassigned", () => {
      expect(() => validateProfileCoverage(DEFAULT_SHADOW_PROFILES)).not.toThrow();
    });
  });

  describe("9. Specialist Review optionality", () => {
    it("declares general, resilience, and specialist profile classes", () => {
      const classes = Object.fromEntries(
        DEFAULT_SHADOW_PROFILES.map((profile) => [profile.id, profile.profileClass])
      );

      expect(classes["gemini-flash-low"]).toBe("general");
      expect(classes["gemini-flash-medium"]).toBe("general");
      expect(classes["gemini-flash-high"]).toBe("general");
      expect(classes.terra).toBe("resilience");
      expect(classes["luna-review"]).toBe("specialist");
    });

    it("does not treat implementation of audit logging as specialist review", () => {
      const decision = routeShadow(
        baseReq("Implement financial audit logging"),
        DEFAULT_SHADOW_PROFILES
      );

      expect(decision.taskType).toBe("code");
      expect(decision.risk).toBe("high");
      expect(decision.selectedProfile).toBe("gemini-flash-high");
      expect(decision.alternatives).not.toContain("luna-review");
    });

    it.each([
      "The code review comments are resolved; implement the fix",
      "Review comments are resolved; implement the fix",
      "I do not need a security review; implement the authentication middleware",
      "I don't need a code review; implement the authentication middleware",
      "I don’t need a code review; implement the authentication middleware",
      "I wouldn’t request a security audit; implement the fix",
      "Audit logs are already enabled; implement retention controls",
      "Review comments mention a race condition; implement the fix",
      "Audit logs show repeated failures",
      "Review status remains blocked",
      "Review feedback has been addressed",
      "Audit report is available in Jira",
      "Review is complete; please deploy the release",
      "Audit was finished yesterday",
      "Review has finished; merge the PR",
      "Skip code review and proceed with merge",
      "Avoid code review for this hotfix"
    ])("does not infer specialist intent from review context: %s", (content) => {
      const decision = routeShadow(baseReq(content), DEFAULT_SHADOW_PROFILES);

      expect(decision.specialistIntent).toBeUndefined();
      expect(decision.selectedProfile).not.toBe("luna-review");
    });

    it("does not carry specialist intent over from an earlier user turn", () => {
      const decision = routeShadow(
        {
          ...baseReq("implement the fix"),
          messages: [
            { role: "user", content: "Review this function for correctness" },
            { role: "assistant", content: "The review is complete" },
            { role: "user", content: "implement the fix" }
          ]
        },
        DEFAULT_SHADOW_PROFILES
      );

      expect(decision.specialistIntent).toBeUndefined();
      expect(decision.selectedProfile).not.toBe("luna-review");
    });

    it.each([
      "Give this function a security review",
      "Provide a code audit of this middleware",
      "I would like a code review of this function",
      "Perform an independent review of this function",
      "Carry out an audit of this function",
      "Could you audit the authentication middleware for security flaws?",
      "Review this function for correctness",
      "Please review this function for correctness",
      "Kindly review the implementation for flaws",
      "Please perform a code review of this middleware",
      "Could you please review this patch?",
      "Can you please review this pull request?",
      "I need a code review of this module",
      "We need a security audit of the authentication flow",
      "I want a review of this pull request",
      "Review the diff after addressing review comments"
    ])("preserves explicit specialist intent: %s", (content) => {
      const decision = routeShadow(baseReq(content), DEFAULT_SHADOW_PROFILES);

      expect(decision.specialistIntent).toBe("review");
      expect(decision.selectedProfile).toBe("luna-review");
    });

    it("lets explicit specialist intent override same-tier session hysteresis", () => {
      const store = createSessionStore(60_000);
      const sessionId = "specialist-hysteresis";
      const first = routeShadow(
        baseReq("Debug a critical race condition in this function", { sessionId }),
        DEFAULT_SHADOW_PROFILES,
        store
      );
      const review = routeShadow(
        baseReq("Review this function for correctness", { sessionId }),
        DEFAULT_SHADOW_PROFILES,
        store
      );

      expect(first.selectedProfile).toBe("gemini-flash-high");
      expect(review.specialistIntent).toBe("review");
      expect(review.selectedProfile).toBe("luna-review");
      expect(review.switchRecommended).toBe(true);
    });

    it("routes explicit conversational audit requests to luna-review", () => {
      const decision = routeShadow(
        baseReq("Could you audit the authentication middleware for security flaws?"),
        DEFAULT_SHADOW_PROFILES
      );

      expect(decision.specialistIntent).toBe("review");
      expect(decision.selectedProfile).toBe("luna-review");
    });

    it("routes review tasks to luna-review when available", () => {
      const decision = routeShadow(
        baseReq("Perform security audit and code review of authentication middleware"),
        DEFAULT_SHADOW_PROFILES
      );
      expect(decision.selectedProfile).toBe("luna-review");
    });

    it("falls back to Gemini High when luna-review is disabled or omitted", () => {
      const withoutLuna = DEFAULT_SHADOW_PROFILES.filter((p) => p.id !== "luna-review");
      const decision = routeShadow(
        baseReq("Perform security audit and code review of authentication middleware"),
        withoutLuna
      );
      expect(decision.selectedProfile).toBe("gemini-flash-high");
      expect(decision.fallbackEngaged).toBeUndefined();
    });
  });

  describe("10. Metric reconciliation calculations", () => {
    it("reconciles all CP4 telemetry mathematical invariants from canary-telemetry.json", () => {
      const telemetryPath = resolve(process.cwd(), "audit/telemetry/canary-telemetry.json");
      const records = JSON.parse(readFileSync(telemetryPath, "utf8"));

      expect(records).toHaveLength(101);

      // Model attempts & final requests
      const totalModelAttempts = records.length;
      const timeouts = records.filter((r: any) => r.terminationReason === "timeout");
      const operationalSuccesses = records.filter((r: any) => r.terminationReason !== "timeout");

      expect(totalModelAttempts).toBe(101);
      expect(timeouts).toHaveLength(4);
      expect(operationalSuccesses).toHaveLength(97);

      const operationalSuccessRate = (operationalSuccesses.length / totalModelAttempts) * 100;
      expect(operationalSuccessRate.toFixed(1)).toBe("96.0");

      // Cheap eligibility reconciliation
      const cheapFloorTurns = records.filter((r: any) => r.qualityTier === "cheap");
      const cheapSelectedTurns = records.filter((r: any) => r.selectedProfile === "gemini-flash-low");
      const cheapEligibleNotSelected = records.filter((r: any) => r.qualityTier === "cheap" && r.selectedProfile !== "gemini-flash-low");

      expect(cheapFloorTurns).toHaveLength(54);
      expect(cheapSelectedTurns).toHaveLength(21);
      expect(cheapEligibleNotSelected).toHaveLength(33);

      // All 33 non-selected turns had capability / taskFit requirements (code/analysis/research)
      for (const r of cheapEligibleNotSelected) {
        expect(["code", "analysis", "research"]).toContain(r.taskType);
      }

      // Switches & oscillations reconciliation
      const bySession: Record<string, any[]> = {};
      for (const r of records) {
        (bySession[r.sessionId] ||= []).push(r);
      }

      let totalSwitches = 0;
      let returnSwitchesWithTaskChange = 0;
      let harmfulOscillations = 0;

      for (const sess of Object.values(bySession)) {
        for (let i = 1; i < sess.length; i++) {
          if (sess[i].selectedProfile !== sess[i - 1].selectedProfile) {
            totalSwitches++;
          }
          if (i >= 2 && sess[i].selectedProfile === sess[i - 2].selectedProfile && sess[i].selectedProfile !== sess[i - 1].selectedProfile) {
            const hasMaterialChange = sess[i].taskType !== sess[i - 1].taskType || sess[i].risk !== sess[i - 1].risk || sess[i].complexity !== sess[i - 1].complexity || sess[i].switchReason === "task_change" || sess[i].switchReason === "narrowly_justified_critical_escalation" || sess[i].switchReason === "cross_provider_resilience";
            if (hasMaterialChange) {
              returnSwitchesWithTaskChange++;
            } else {
              harmfulOscillations++;
            }
          }
        }
      }

      expect(totalSwitches).toBe(34);
      expect(returnSwitchesWithTaskChange).toBe(12);
      expect(harmfulOscillations).toBe(0);
    });
  });
});
