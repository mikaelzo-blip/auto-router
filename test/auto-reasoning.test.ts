import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  type CanonicalReasoningEffort,
  type ReasoningPolicy,
  type ReasoningContext,
  determineAutoReasoning,
  clampReasoningEffort,
  resolveReasoningDecision,
  applyReasoningToPayload,
  normalizeReasoningEffort,
  EFFORT_LEVELS
} from "../src/reasoning.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";
import { createSessionStore, routeShadow, type ExecutionProfile, type ShadowRequest } from "../src/shadow-router.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const dummyProfileHighCap: ExecutionProfile = {
  id: "test-high-cap",
  model: "test/high-cap-model",
  enabled: true,
  hardCapabilities: { tools: true, vision: true },
  taskFit: ["general", "code", "analysis"],
  qualityTier: "strong",
  costClass: "medium",
  latencyClass: "medium",
  supportedReasoningEfforts: ["low", "medium", "high"],
  defaultReasoningEffort: "high",
  maximumReasoningEffort: "high"
};

const dummyProfileMaxCap: ExecutionProfile = {
  id: "test-max-cap",
  model: "test/max-cap-model",
  enabled: true,
  hardCapabilities: { tools: true, vision: true },
  taskFit: ["general", "code", "analysis"],
  qualityTier: "frontier",
  costClass: "high",
  latencyClass: "slow",
  supportedReasoningEfforts: ["medium", "high", "max"],
  defaultReasoningEffort: "high",
  maximumReasoningEffort: "max"
};

describe("CP5 Auto Reasoning Policy (25 Acceptance Gates)", () => {
  let sessionStore: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    sessionStore = createSessionStore(15 * 60_000);
  });

  // 1. trivial request -> minimal/low
  it("1. selects minimal or low reasoning for a trivial request", () => {
    const context: ReasoningContext = {
      taskType: "general",
      complexity: "trivial",
      risk: "low",
      promptText: "hi"
    };
    const decision = determineAutoReasoning(context);
    expect(["minimal", "low"]).toContain(decision.desired);
  });

  // 2. low complexity -> low
  it("2. selects low reasoning for low complexity task", () => {
    const context: ReasoningContext = {
      taskType: "transformation",
      complexity: "low",
      risk: "low",
      promptText: "reformat this json object to use 2-space indentation"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("low");
  });

  // 3. normal coding -> medium
  it("3. selects medium reasoning for normal coding", () => {
    const context: ReasoningContext = {
      taskType: "code",
      complexity: "medium",
      risk: "low",
      promptText: "implement a debounce helper function in typescript"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("medium");
  });

  // 4. difficult debugging -> high
  it("4. selects high reasoning for difficult debugging", () => {
    const context: ReasoningContext = {
      taskType: "code",
      complexity: "high",
      risk: "medium",
      promptText: "diagnose race condition and deadlock in distributed state machine"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("high");
  });

  // 5. critical reasoning -> max when supported
  it("5. selects max reasoning for critical complexity tasks", () => {
    const context: ReasoningContext = {
      taskType: "analysis",
      complexity: "critical",
      risk: "high",
      promptText: "formal proof of consensus protocol linearizability invariant"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("max");
  });

  // 6. high-risk task raises minimum reasoning
  it("6. raises minimum reasoning floor for high-risk tasks", () => {
    const context: ReasoningContext = {
      taskType: "code",
      complexity: "low",
      risk: "high",
      promptText: "update financial ledger balance calculation"
    };
    const decision = determineAutoReasoning(context);
    expect(["high", "max"]).toContain(decision.desired);
    expect(decision.reasons).toContain("risk_floor_applied");
  });

  // 7. prompt length alone does not force high reasoning
  it("7. does not force high reasoning from prompt length alone", () => {
    const longTrivialPrompt = "echo hello world ".repeat(300);
    const context: ReasoningContext = {
      taskType: "general",
      complexity: "trivial",
      risk: "low",
      promptText: longTrivialPrompt
    };
    const decision = determineAutoReasoning(context);
    expect(["minimal", "low"]).toContain(decision.desired);
  });

  // 8. first ordinary test failure does not jump immediately to maximum
  it("8. does not jump immediately to max on first ordinary test failure", () => {
    const context: ReasoningContext = {
      taskType: "code",
      complexity: "medium",
      risk: "low",
      recentTestOutcome: "failed",
      recentFailureCount: 1,
      promptText: "fix off-by-one error in pagination helper"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("high");
    expect(decision.desired).not.toBe("max");
    expect(decision.escalationApplied).toBe(true);
  });

  // 9. repeated quality failure escalates reasoning
  it("9. escalates reasoning to max on repeated quality failure", () => {
    const context: ReasoningContext = {
      taskType: "code",
      complexity: "high",
      risk: "medium",
      recentTestOutcome: "failed",
      recentFailureCount: 2,
      promptText: "test still failed after attempt 1; persistent type mismatch"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("max");
    expect(decision.escalationApplied).toBe(true);
    expect(decision.reasons).toContain("repeated_quality_failure_escalation");
  });

  // 10. HTTP 429 does not reasoning-escalate
  it("10. does not escalate reasoning for HTTP 429 rate limit errors", () => {
    const context: ReasoningContext = {
      taskType: "code",
      complexity: "medium",
      risk: "low",
      failureType: "429",
      recentFailure: "rate_limit_exceeded",
      promptText: "implement user profile route"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("medium");
    expect(decision.escalationApplied).toBe(false);
  });

  // 11. provider timeout does not reasoning-escalate
  it("11. does not escalate reasoning for provider timeout errors", () => {
    const context: ReasoningContext = {
      taskType: "code",
      complexity: "medium",
      risk: "low",
      failureType: "timeout",
      recentFailure: "upstream_timeout",
      promptText: "implement user profile route"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("medium");
    expect(decision.escalationApplied).toBe(false);
  });

  // 12. successful verification permits de-escalation
  it("12. permits de-escalation when verification passes", () => {
    const context: ReasoningContext = {
      taskType: "general",
      complexity: "low",
      risk: "low",
      recentTestOutcome: "passed",
      promptText: "document the newly passing auth functions in markdown"
    };
    const decision = determineAutoReasoning(context);
    expect(["minimal", "low"]).toContain(decision.desired);
    expect(decision.deescalationApplied).toBe(true);
  });

  // 13. supported-effort clamp works
  it("13. clamps effort to profile capabilities", () => {
    const clampResult = clampReasoningEffort("minimal", dummyProfileHighCap);
    expect(clampResult.effective).toBe("low");
    expect(clampResult.clamped).toBe(true);
    expect(clampResult.clampReason).toBe("clamped_to_min_supported");
  });

  // 14. max desired + high-cap model -> high effective
  it("14. clamps max desired to high on high-capped model", () => {
    const clampResult = clampReasoningEffort("max", dummyProfileHighCap);
    expect(clampResult.effective).toBe("high");
    expect(clampResult.clamped).toBe(true);
    expect(clampResult.clampReason).toBe("clamped_to_max_supported");
  });

  // 15. disabled Sol remains disabled regardless of reasoning demand
  it("15. does not activate disabled Sol regardless of reasoning demand", () => {
    const solProfile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "sol")!;
    expect(solProfile.enabled).toBe(false);

    const shadowReq: ShadowRequest = {
      sessionId: "test-sol-session",
      messages: [{ role: "user", content: "extreme formal reasoning proof with critical invariants" }],
      policy: "quality",
      requiresExtremeReasoning: true
    };
    const decision = routeShadow(shadowReq, DEFAULT_SHADOW_PROFILES, sessionStore);
    expect(decision.selectedProfile).not.toBe("sol");
  });

  // 16. Astra remains disabled
  it("16. leaves Astra disabled in execution profiles", () => {
    const astra = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "astra")!;
    expect(astra.enabled).toBe(false);
  });

  // 17. frontier remains optional
  it("17. does not force frontier profile when strong profile suffices", () => {
    const shadowReq: ShadowRequest = {
      sessionId: "test-frontier-optional",
      messages: [{ role: "user", content: "write postgres transaction with row lock" }],
      policy: "balanced"
    };
    const decision = routeShadow(shadowReq, DEFAULT_SHADOW_PROFILES, sessionStore);
    expect(["gemini-flash-medium", "gemini-flash-high"]).toContain(decision.selectedProfile);
    expect(["claude-opus", "astra"]).not.toContain(decision.selectedProfile);
  });

  // 18. manual passthrough mode preserves client effort
  it("18. preserves client reasoning in passthrough mode", () => {
    const clientEffort: CanonicalReasoningEffort = "low";
    const resolved = resolveReasoningDecision({
      policy: "passthrough",
      clientEffort,
      autoDesired: "high",
      profile: dummyProfileHighCap
    });
    expect(resolved.effectiveReasoningEffort).toBe("low");
    expect(resolved.requestedReasoningEffort).toBe("low");
  });

  // 19. auto mode deterministically replaces fixed client effort where designed
  it("19. replaces fixed client effort in auto mode", () => {
    const clientEffort: CanonicalReasoningEffort = "high"; // e.g. Hermes desktop default dropdown
    const resolved = resolveReasoningDecision({
      policy: "auto",
      clientEffort,
      autoDesired: "low",
      profile: dummyProfileHighCap
    });
    expect(resolved.effectiveReasoningEffort).toBe("low");
    expect(resolved.requestedReasoningEffort).toBe("high");
    expect(resolved.desiredReasoningEffort).toBe("low");
  });

  // 20. no duplicate reasoning fields forwarded
  it("20. prevents duplicate reasoning fields in payload forwarding", () => {
    const rawPayload = {
      model: "auto",
      messages: [{ role: "user", content: "test" }],
      reasoning_effort: "high",
      reasoning: { effort: "high" }
    };
    const sanitized = applyReasoningToPayload(rawPayload, "medium");
    expect(sanitized.reasoning_effort).toBe("medium");
    expect(sanitized.reasoning).toBeUndefined();
  });

  // 21. Chat Completions compatibility
  it("21. normalizes client string variants for Chat Completions", () => {
    expect(normalizeReasoningEffort("Minimal")).toBe("minimal");
    expect(normalizeReasoningEffort("Low")).toBe("low");
    expect(normalizeReasoningEffort("Medium")).toBe("medium");
    expect(normalizeReasoningEffort("High")).toBe("high");
    expect(normalizeReasoningEffort("Extra High")).toBe("max");
    expect(normalizeReasoningEffort("Ultra")).toBe("max");
    expect(normalizeReasoningEffort("Max")).toBe("max");
  });

  // 22. Responses API compatibility if supported
  it("22. applies reasoning to Responses API request payload", () => {
    const responsesPayload = {
      model: "auto",
      input: "test question",
      reasoning_effort: "high"
    };
    const sanitized = applyReasoningToPayload(responsesPayload, "low");
    expect(sanitized.reasoning_effort).toBe("low");
    expect(sanitized.reasoning).toBeUndefined();
  });

  // 23. debug route reports reasoning decision
  it("23. constructs structured reasoning observability for debug route", () => {
    const resolved = resolveReasoningDecision({
      policy: "auto",
      clientEffort: "high",
      autoDesired: "high",
      profile: dummyProfileHighCap,
      reasons: ["high_complexity", "hard_debugging"]
    });
    expect(resolved.debugSummary.policy).toBe("auto");
    expect(resolved.debugSummary.requested).toBe("high");
    expect(resolved.debugSummary.desired).toBe("high");
    expect(resolved.debugSummary.effective).toBe("high");
    expect(resolved.debugSummary.clamped).toBe(false);
    expect(resolved.debugSummary.reason).toEqual(
      expect.arrayContaining(["high_complexity", "hard_debugging"])
    );
  });

  // 24. model selection does not unnecessarily change when only reasoning effort needs escalation
  it("24. escalates reasoning effort without unnecessarily switching model", () => {
    // Session starts with gemini-flash-medium on normal coding
    const req1: ShadowRequest = {
      sessionId: "test-sess-decoupled",
      messages: [{ role: "user", content: "implement a simple cache map" }],
      policy: "balanced"
    };
    const dec1 = routeShadow(req1, DEFAULT_SHADOW_PROFILES, sessionStore);
    expect(dec1.selectedProfile).toBe("gemini-flash-medium");

    // First attempt fails a test: we want reasoning escalation (medium -> high)
    // Model should stay gemini-flash-medium if it supports high reasoning!
    const mediumProfile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;
    expect(mediumProfile.supportedReasoningEfforts).toContain("high");

    const reasoningDec = determineAutoReasoning({
      taskType: dec1.taskType,
      complexity: "medium",
      risk: dec1.risk,
      recentTestOutcome: "failed",
      recentFailureCount: 1
    });
    expect(reasoningDec.desired).toBe("high");

    const clamped = clampReasoningEffort(reasoningDec.desired, mediumProfile);
    expect(clamped.effective).toBe("high");
    // Model remains gemini-flash-medium, reasoning escalated from medium to high!
  });

  // 25. reasoning effort can decrease without switching models
  it("25. de-escalates reasoning effort without switching models", () => {
    const highProfile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-high")!;
    // Hard debugging required high reasoning
    const hardReasoning = determineAutoReasoning({
      taskType: "code",
      complexity: "high",
      risk: "medium"
    });
    expect(hardReasoning.desired).toBe("high");

    // Next step is documentation after test passed
    const docReasoning = determineAutoReasoning({
      taskType: "general",
      complexity: "low",
      risk: "low",
      recentTestOutcome: "passed"
    });
    expect(["minimal", "low"]).toContain(docReasoning.desired);

    const clamped = clampReasoningEffort(docReasoning.desired, highProfile);
    // highProfile supports ["low", "medium", "high"], so minimal/low clamps to "low"
    expect(clamped.effective).toBe("low");
  });

  // 26. targeted PostgreSQL concurrency regression (Section 10)
  it("26. targeted PostgreSQL concurrency regression: selects strong profile, Gemini Flash High, high effort, serializable payload", () => {
    const prompt = "Diagnose a PostgreSQL concurrency race condition and prevent double allocation.";
    const shadowReq: ShadowRequest = {
      sessionId: "sess-concurrency-test",
      messages: [{ role: "user", content: prompt }],
      policy: "balanced"
    };
    const shadowDecision = routeShadow(shadowReq, DEFAULT_SHADOW_PROFILES, sessionStore);
    expect(["code", "analysis"]).toContain(shadowDecision.taskType);
    expect(shadowDecision.complexity).toBe("high");
    expect(shadowDecision.minimumQualityTier).toBe("strong");
    expect(shadowDecision.selectedProfile).toBe("gemini-flash-high");

    const matchedProfile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === shadowDecision.selectedProfile)!;
    expect(matchedProfile.model).toBe("ag/gemini-3.8-flash-high");

    const reasoningContext: ReasoningContext = {
      taskType: shadowDecision.taskType,
      complexity: shadowDecision.complexity,
      risk: shadowDecision.risk,
      promptText: prompt,
      selectedProfile: shadowDecision.selectedProfile
    };
    const autoReasoning = determineAutoReasoning(reasoningContext);
    expect(autoReasoning.desired).toBe("high");

    const resolved = resolveReasoningDecision({
      policy: "auto",
      clientEffort: "high",
      autoDesired: autoReasoning.desired,
      profile: matchedProfile
    });
    expect(resolved.desiredReasoningEffort).toBe("high");
    expect(resolved.effectiveReasoningEffort).toBe("high");
    expect(resolved.clamped).toBe(false);

    // Verify serializable & forwardable payload (no duplicate reasoning fields)
    const rawPayload = {
      model: "auto",
      messages: [{ role: "user", content: prompt }],
      reasoning_effort: "high",
      reasoning: { effort: "high" }
    };
    const forwarded = applyReasoningToPayload(
      { ...rawPayload, model: matchedProfile.model },
      resolved.effectiveReasoningEffort
    );
    expect(forwarded.model).toBe("ag/gemini-3.8-flash-high");
    expect(forwarded.reasoning_effort).toBe("high");
    expect((forwarded as any).reasoning).toBeUndefined();
    expect(JSON.stringify(forwarded)).toContain('"reasoning_effort":"high"');
  });

  // 27. HTTP 5xx isolation (Section 15)
  it("27. does not escalate reasoning for HTTP 5xx server errors", () => {
    const context: ReasoningContext = {
      taskType: "code",
      complexity: "medium",
      risk: "low",
      failureType: "5xx",
      recentFailure: "upstream_502_bad_gateway",
      promptText: "implement user profile route"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("medium");
    expect(decision.escalationApplied).toBe(false);
  });

  // 28. provider unavailable isolation (Section 15)
  it("28. does not escalate reasoning for provider unavailable / infrastructure failures", () => {
    const context: ReasoningContext = {
      taskType: "code",
      complexity: "medium",
      risk: "low",
      failureType: "infrastructure",
      recentFailure: "provider_unavailable",
      promptText: "implement user profile route"
    };
    const decision = determineAutoReasoning(context);
    expect(decision.desired).toBe("medium");
    expect(decision.escalationApplied).toBe(false);
  });

  // 29. multi-turn trajectory (Section 16)
  it("29. multi-turn trajectory: medium implementation -> high on quality failure -> low on docs after verification passes", () => {
    const mediumProfile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === "gemini-flash-medium")!;

    // Turn 1: Normal implementation
    const t1 = determineAutoReasoning({
      taskType: "code",
      complexity: "medium",
      risk: "low",
      promptText: "implement payment webhook handler"
    });
    expect(t1.desired).toBe("medium");
    const r1 = clampReasoningEffort(t1.desired, mediumProfile);
    expect(r1.effective).toBe("medium");

    // Turn 2: Test fails with assertion error
    const t2 = determineAutoReasoning({
      taskType: "code",
      complexity: "medium",
      risk: "low",
      recentTestOutcome: "failed",
      recentFailureCount: 1,
      recentFailure: "AssertionError: expected webhook signature to match",
      promptText: "fix signature validation logic"
    });
    expect(t2.desired).toBe("high");
    expect(t2.escalationApplied).toBe(true);
    const r2 = clampReasoningEffort(t2.desired, mediumProfile);
    expect(r2.effective).toBe("high"); // Gemini Medium supports high reasoning!

    // Turn 3: Test passes -> next task is documentation/cleanup
    const t3 = determineAutoReasoning({
      taskType: "general",
      complexity: "low",
      risk: "low",
      recentTestOutcome: "passed",
      promptText: "add JSDoc comments to webhook handler functions"
    });
    expect(["minimal", "low"]).toContain(t3.desired);
    expect(t3.deescalationApplied).toBe(true);
    const r3 = clampReasoningEffort(t3.desired, mediumProfile);
    expect(r3.effective).toBe("low");
    // Model remains gemini-flash-medium throughout!
  });

  // Section 13: 10 Representative Shadow Verification Cases
  describe("Section 13: Shadow Reasoning Mode & Representative Verification Cases", () => {
    const shadowCases = [
      { id: "1. simple transformation", prompt: "Format the following JSON with 2-space indentation and sorted keys: {\"z\": 1, \"a\": 2}", expectedDesired: "low", expectedEffective: "low", expectedProfile: "gemini-flash-low", expectedModel: "ag/gemini-3.8-flash-low" },
      { id: "2. normal coding", prompt: "implement a debounce helper function in typescript", expectedDesired: "medium", expectedEffective: "medium", expectedProfile: "gemini-flash-medium", expectedModel: "ag/gemini-3.8-flash-medium" },
      { id: "3. repository exploration", prompt: "explore and summarize the product features and documentation", expectedDesired: "low", expectedEffective: "low", expectedProfile: "gemini-flash-low", expectedModel: "ag/gemini-3.8-flash-low" },
      { id: "4. hard debugging", prompt: "diagnose race condition and deadlock in distributed state machine", expectedDesired: "high", expectedEffective: "high", expectedProfile: "gemini-flash-high", expectedModel: "ag/gemini-3.8-flash-high" },
      { id: "5. concurrency", prompt: "Diagnose a PostgreSQL concurrency race condition and prevent double allocation.", expectedDesired: "high", expectedEffective: "high", expectedProfile: "gemini-flash-high", expectedModel: "ag/gemini-3.8-flash-high" },
      { id: "6. financial/data-integrity", prompt: "validate financial ledger transaction balancing debits and credits", expectedDesired: "high", expectedEffective: "high", expectedProfile: "gemini-flash-high", expectedModel: "ag/gemini-3.8-flash-high" },
      { id: "7. security", prompt: "implement constant-time cryptographic hash verification against timing attacks for security compliance", expectedDesired: "high", expectedEffective: "high", expectedProfile: "gemini-flash-high", expectedModel: "ag/gemini-3.8-flash-high" },
      { id: "8. documentation after hard task", prompt: "generate markdown documentation for the rate limiter", recentTestOutcome: "passed" as const, expectedDesired: "low", expectedEffective: "low", expectedProfile: "gemini-flash-low", expectedModel: "ag/gemini-3.8-flash-low" },
      { id: "9. provider timeout simulation", prompt: "implement cache lookup", failureType: "timeout" as const, recentFailure: "upstream timeout", expectedDesired: "medium", expectedEffective: "medium", expectedProfile: "gemini-flash-medium", expectedModel: "ag/gemini-3.8-flash-medium" },
      { id: "10. quality failure simulation", prompt: "fix assertion error in rate limiter test", recentTestOutcome: "failed" as const, expectedDesired: "max", expectedEffective: "high", expectedProfile: "gemini-flash-high", expectedModel: "ag/gemini-3.8-flash-high" }
    ];

    for (const c of shadowCases) {
      it(`verifies shadow case: ${c.id}`, () => {
        const shadowReq: ShadowRequest = {
          sessionId: `shadow-sess-${c.id}`,
          messages: [{ role: "user", content: c.prompt }],
          policy: "balanced",
          recentTestOutcome: c.recentTestOutcome,
          failureType: c.failureType,
          recentFailure: c.recentFailure
        };
        const shadowDec = routeShadow(shadowReq, DEFAULT_SHADOW_PROFILES, sessionStore);
        expect(shadowDec.selectedProfile).toBe(c.expectedProfile);

        const profile = DEFAULT_SHADOW_PROFILES.find((p) => p.id === shadowDec.selectedProfile)!;
        expect(profile.model).toBe(c.expectedModel);

        const autoReasoning = determineAutoReasoning({
          taskType: shadowDec.taskType,
          complexity: shadowDec.complexity,
          risk: shadowDec.risk,
          recentTestOutcome: c.recentTestOutcome,
          failureType: c.failureType,
          recentFailure: c.recentFailure,
          promptText: c.prompt,
          selectedProfile: shadowDec.selectedProfile
        });

        const clientRequestedEffort = "high"; // Hermes UI fixed-High
        const resolved = resolveReasoningDecision({
          policy: "shadow",
          clientEffort: clientRequestedEffort,
          autoDesired: autoReasoning.desired,
          profile
        });

        // In shadow mode, auto reasoning is computed and available, client effort is preserved in forwarding
        expect(autoReasoning.desired).toBe(c.expectedDesired);
        expect(clampReasoningEffort(autoReasoning.desired, profile).effective).toBe(c.expectedEffective);
      });
    }
  });

  describe("End-to-End HTTP Endpoints & Observability", () => {
    const testRoutingConfig = {
      virtualModel: "auto",
      virtualModels: {
        auto: {},
        code: { route: "coding" },
        fast: { route: "chat" }
      },
      globalFallbackModel: "ag/gemini-3.8-flash-low",
      defaultRoute: "chat",
      ambiguousFallback: "chat",
      precedence: ["coding", "chat"],
      routes: {
        chat: {
          upstreamModel: "ag/gemini-3.8-flash-low",
          description: "Routine chat",
          capabilities: { vision: true, tools: true },
          keywords: ["hello", "hi"]
        },
        coding: {
          upstreamModel: "ag/gemini-3.8-flash-medium",
          description: "Coding tasks",
          capabilities: { vision: true, tools: true },
          keywords: ["code", "typescript", "function"]
        }
      },
      modelCapabilities: {
        "ag/gemini-3.8-flash-low": { vision: true, tools: true },
        "ag/gemini-3.8-flash-medium": { vision: true, tools: true },
        "ag/gemini-3.8-flash-high": { vision: true, tools: true }
      }
    };

    it("reports structured reasoning block in /debug/route", async () => {
      const app = buildApp({
        host: "127.0.0.1",
        port: 20202,
        routerMode: "v2",
        reasoningPolicy: "auto",
        upstreamBaseUrl: "http://127.0.0.1:20128/v1",
        classifierTimeoutMs: 100,
        upstreamTimeoutMs: 100,
        logLevel: "silent",
        routing: testRoutingConfig as any
      });

      const res = await app.inject({
        method: "POST",
        url: "/debug/route",
        headers: { "content-type": "application/json" },
        payload: {
          model: "auto",
          messages: [{ role: "user", content: "diagnose race condition in transaction ledger" }]
        }
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json).toHaveProperty("reasoning");
      expect(json.reasoning.policy).toBe("auto");
      expect(json.reasoning.desired).toBeDefined();
      expect(json.reasoning.effective).toBeDefined();
      expect(typeof json.reasoning.clamped).toBe("boolean");
      await app.close();
    });

    it("attaches reasoning observability headers on /v1/chat/completions", async () => {
      let forwardedBody: any = null;
      const app = buildApp({
        host: "127.0.0.1",
        port: 20203,
        routerMode: "v2",
        reasoningPolicy: "auto",
        upstreamBaseUrl: "http://127.0.0.1:20128/v1",
        classifierTimeoutMs: 100,
        upstreamTimeoutMs: 100,
        logLevel: "silent",
        routing: testRoutingConfig as any
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        forwardedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 10,
              completion_tokens_details: { reasoning_tokens: 15 }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "content-type": "application/json" },
        payload: {
          model: "auto",
          reasoning_effort: "high",
          reasoning: { effort: "high" }, // Client sent duplicate/nested field
          messages: [{ role: "user", content: "format json text cleanly" }]
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-auto-router-reasoning-policy"]).toBe("auto");
      expect(res.headers["x-auto-router-reasoning-desired"]).toBeDefined();
      expect(res.headers["x-auto-router-reasoning-effective"]).toBeDefined();

      // Check forwarded body sanitization (no conflicting reasoning object)
      expect(forwardedBody).toBeDefined();
      expect(forwardedBody.reasoning_effort).toBeDefined();
      expect(forwardedBody.reasoning).toBeUndefined();

      fetchSpy.mockRestore();
      await app.close();
    });

    it("attaches reasoning headers and sanitizes /v1/responses payload", async () => {
      let forwardedBody: any = null;
      const app = buildApp({
        host: "127.0.0.1",
        port: 20204,
        routerMode: "legacy",
        reasoningPolicy: "auto",
        upstreamBaseUrl: "http://127.0.0.1:20128/v1",
        classifierTimeoutMs: 100,
        upstreamTimeoutMs: 100,
        logLevel: "silent",
        routing: testRoutingConfig as any
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        forwardedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "resp-test",
            object: "response",
            status: "completed",
            output: []
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      });

      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { "content-type": "application/json" },
        payload: {
          model: "auto",
          input: "implement quicksort in typescript",
          reasoning_effort: "high",
          reasoning: { effort: "high" }
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-auto-router-reasoning-policy"]).toBe("auto");
      expect(res.headers["x-auto-router-reasoning-effective"]).toBeDefined();
      expect(forwardedBody).toBeDefined();
      expect(forwardedBody.reasoning_effort).toBeDefined();
      expect(forwardedBody.reasoning).toBeUndefined();

      fetchSpy.mockRestore();
      await app.close();
    });
  });
});
