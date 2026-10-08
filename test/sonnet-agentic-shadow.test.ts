import { describe, it, expect } from "vitest";
import {
  detectAgenticIntent,
  evaluateAgenticShadow,
  createAgenticSessionStore,
  type AgenticEvaluationInput,
  type ShadowAgenticDecision
} from "../src/agentic-shadow.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";

describe("Sonnet Agentic Shadow Routing (CP7.3)", () => {
  const store = createAgenticSessionStore(60_000);

  describe("Section 5 & 20: Positive Agentic Signals", () => {
    it("detects multi-file implementation across repository", () => {
      const input: AgenticEvaluationInput = {
        messages: [
          {
            role: "user",
            content: "Implement this approved architecture across API, database and tests, then verify all tests pass."
          }
        ],
        claudeQuotaStatus: "healthy",
        claudeQuotaRatio: 0.85
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.shadowAgenticEligible).toBe(true);
      expect(decision.wouldUseSonnet).toBe(true);
      expect(decision.shadowAgenticProfile).toBe("sonnet-agentic");
      expect(decision.shadowAgenticModel).toBe("ag/claude-sonnet-4-6");
      expect(decision.agenticIntent).toBe("execution");
      expect(decision.agenticSignals.length).toBeGreaterThan(0);
    });

    it("detects test-fix-test loop and repository repair", () => {
      const input: AgenticEvaluationInput = {
        messages: [
          {
            role: "user",
            content: "Tests are failing after my implementation. Diagnose the repo, fix it, rerun tests until green."
          }
        ],
        recentTestOutcome: "failed",
        claudeQuotaStatus: "healthy",
        claudeQuotaRatio: 0.75
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.shadowAgenticEligible).toBe(true);
      expect(decision.wouldUseSonnet).toBe(true);
      expect(decision.shadowAgenticProfile).toBe("sonnet-agentic");
    });

    it("detects cross-module refactoring under constraints", () => {
      const input: AgenticEvaluationInput = {
        messages: [
          {
            role: "user",
            content: "Refactor multiple modules across the repository to extract BaseKeyValueStore while maintaining backward compatibility."
          }
        ],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.shadowAgenticEligible).toBe(true);
      expect(decision.wouldUseSonnet).toBe(true);
    });

    it("detects multi-file feature addition with test-driven loop", () => {
      const input: AgenticEvaluationInput = {
        messages: [
          {
            role: "user",
            content: "Implement wildcard event bus across several files in src/events/, update types, and run tests until passing."
          }
        ],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.shadowAgenticEligible).toBe(true);
      expect(decision.wouldUseSonnet).toBe(true);
    });
  });

  describe("Section 6 & 20: Critical Negative / Exclusion Signals", () => {
    it("excludes architecture design without implementation", () => {
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "Design a modular architecture for distributed caching." }],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.shadowAgenticProfile).toBe("gemini-flash-high");
      expect(decision.agenticExclusions).toContain("architecture_design_only");
    });

    it("excludes PRD creation", () => {
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "Create a PRD for our new user authentication system." }],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.agenticExclusions).toContain("prd_creation");
    });

    it("excludes explanation of code or race conditions", () => {
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "Explain this race condition and why double-checked locking can fail." }],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.agenticExclusions).toContain("explanation");
    });

    it("excludes code review only", () => {
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "Review this implementation of the payment processor for security flaws." }],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "luna-review", "cx/gpt-5.6-luna-review");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.agenticExclusions).toContain("code_review_only");
    });

    it("excludes small isolated edits / typos in README", () => {
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "Fix typo in README.md line 12." }],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-low", "ag/gemini-3.8-flash-low");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.agenticExclusions).toContain("small_isolated_edit");
    });

    it("excludes simple coding questions / one-line snippets", () => {
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "Write a regex to validate an email address in TypeScript." }],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-medium", "ag/gemini-3.8-flash-medium");
      expect(decision.wouldUseSonnet).toBe(false);
    });

    it("excludes general reasoning and comparisons", () => {
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "Compare JWT vs sessions for mobile applications." }],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(false);
    });
  });

  describe("Section 7 & 8: Plan vs Execute Distinction & Mixed Prompts", () => {
    it("distinguishes pure planning from execution", () => {
      const planInput: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "Design migration architecture for migrating users to auth0." }],
        claudeQuotaStatus: "healthy"
      };
      const planDecision = evaluateAgenticShadow(planInput, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(planDecision.wouldUseSonnet).toBe(false);

      const execInput: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "Implement migration architecture for migrating users to auth0 across repo, run tests until green." }],
        claudeQuotaStatus: "healthy"
      };
      const execDecision = evaluateAgenticShadow(execInput, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(execDecision.wouldUseSonnet).toBe(true);
    });

    it("determines dominant intent in mixed prompts: execution qualifies when deliverables include repo modification & verification", () => {
      const mixedExecInput: AgenticEvaluationInput = {
        messages: [{
          role: "user",
          content: "Review this repo, choose the safest design, then implement it across the codebase and verify all tests pass."
        }],
        claudeQuotaStatus: "healthy"
      };
      const mixedExecDecision = evaluateAgenticShadow(mixedExecInput, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(mixedExecDecision.wouldUseSonnet).toBe(true);
      expect(mixedExecDecision.agenticIntent).toBe("mixed_execution");
    });

    it("determines dominant intent in mixed prompts: planning excluded when user only asks for a plan", () => {
      const mixedPlanInput: AgenticEvaluationInput = {
        messages: [{
          role: "user",
          content: "Review this repo, choose the safest design, and write an implementation plan for my review. Do not write code yet."
        }],
        claudeQuotaStatus: "healthy"
      };
      const mixedPlanDecision = evaluateAgenticShadow(mixedPlanInput, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(mixedPlanDecision.wouldUseSonnet).toBe(false);
      expect(mixedPlanDecision.agenticIntent).toBe("mixed_planning");
    });
  });

  describe("Section 9: Tool Availability is NOT Agentic Intent", () => {
    it("does not recommend Sonnet merely because tools are advertised", () => {
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "What is a closure in JavaScript?" }],
        toolsProvided: true,
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-medium", "ag/gemini-3.8-flash-medium");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.shadowAgenticProfile).toBe("gemini-flash-medium");
    });
  });

  describe("Section 22: Long-Prompt False Positive Prevention", () => {
    it("does not recommend Sonnet for very long analytical prompt", () => {
      const longAnalysisText = `
        We are conducting an exhaustive technical evaluation of our distributed transaction processing system.
        The current architecture uses a 2-phase commit protocol across four regional datacenters.
        However, under network partitions, latency spikes to unacceptable levels.
        Please analyze the CAP theorem implications, compare Paxos vs Raft consensus algorithms,
        evaluate the trade-offs of using Percolator-style snapshot isolation vs Spanner-style TrueTime,
        and write a comprehensive 10-page architecture decision record (ADR) explaining your findings.
        Do not modify the repository or run tests. We only need the architectural documentation.
      `.repeat(5);

      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: longAnalysisText }],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.agenticExclusions).toContain("architecture_design_only");
    });

    it("recommends Sonnet for short but execution-oriented prompt", () => {
      const shortExecText = "Implement approved payment validator across src/ and test/, run tests until green.";
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: shortExecText }],
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(true);
    });
  });

  describe("Section 10, 11, 12, 21: Multi-Turn Trajectory, Stickiness & De-escalation", () => {
    it("follows 4-turn trajectory: plan -> execute -> sticky fix -> de-escalate without flapping", () => {
      const sessionId = "session_trajectory_1";

      // Turn 1: Architecture design -> Gemini High
      const turn1: AgenticEvaluationInput = {
        sessionId,
        messages: [{ role: "user", content: "Design a safe 3-phase schema migration architecture for user accounts." }],
        claudeQuotaStatus: "healthy"
      };
      const d1 = evaluateAgenticShadow(turn1, "gemini-flash-high", "ag/gemini-3.8-flash-high", store);
      expect(d1.wouldUseSonnet).toBe(false);
      expect(d1.actualProfile).toBe("gemini-flash-high");

      // Turn 2: Approve design, implement across repo -> Sonnet shadow
      const turn2: AgenticEvaluationInput = {
        sessionId,
        messages: [
          { role: "user", content: "Design a safe 3-phase schema migration architecture for user accounts." },
          { role: "assistant", content: "Here is the 3-phase plan..." },
          { role: "user", content: "The plan is approved. Implement the migration across the repository and run tests until passing." }
        ],
        claudeQuotaStatus: "healthy"
      };
      const d2 = evaluateAgenticShadow(turn2, "gemini-flash-high", "ag/gemini-3.8-flash-high", store);
      expect(d2.wouldUseSonnet).toBe(true);
      expect(d2.shadowAgenticProfile).toBe("sonnet-agentic");

      // Turn 3: Failed tests -> Sonnet remains sticky
      const turn3: AgenticEvaluationInput = {
        sessionId,
        messages: [
          ...turn2.messages,
          { role: "assistant", content: "I have updated the migrator files." },
          { role: "user", content: "Tests failed with Assertion error in test/migrator.test.ts line 45. Fix it and rerun tests." }
        ],
        recentTestOutcome: "failed",
        claudeQuotaStatus: "healthy"
      };
      const d3 = evaluateAgenticShadow(turn3, "gemini-flash-high", "ag/gemini-3.8-flash-high", store);
      expect(d3.wouldUseSonnet).toBe(true);
      expect(d3.shadowAgenticProfile).toBe("sonnet-agentic");

      // Turn 4: Tests pass, produce summary -> De-escalate away from Sonnet
      const turn4: AgenticEvaluationInput = {
        sessionId,
        messages: [
          ...turn3.messages,
          { role: "assistant", content: "Fixed the index order, all tests now pass." },
          { role: "user", content: "Tests pass. Summarize what changed across the repository." }
        ],
        recentTestOutcome: "passed",
        claudeQuotaStatus: "healthy"
      };
      const d4 = evaluateAgenticShadow(turn4, "gemini-flash-medium", "ag/gemini-3.8-flash-medium", store);
      expect(d4.wouldUseSonnet).toBe(false);
      expect(d4.shadowAgenticProfile).toBe("gemini-flash-medium");
    });
  });

  describe("Section 13: Failure Handling Separation", () => {
    it("does not switch to Sonnet merely due to infrastructure/429/timeout failure", () => {
      const input: AgenticEvaluationInput = {
        messages: [{ role: "user", content: "What is the capital of France?" }],
        failureType: "429",
        recentFailure: "rate_limit_exceeded",
        claudeQuotaStatus: "healthy"
      };

      const decision = evaluateAgenticShadow(input, "gemini-flash-low", "ag/gemini-3.8-flash-low");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.shadowAgenticProfile).toBe("gemini-flash-low");
    });
  });

  describe("Section 14: Quota Awareness Integration", () => {
    const agenticPrompt: AgenticEvaluationInput = {
      messages: [{ role: "user", content: "Implement the approved payment gateway across the repository, run tests until green." }]
    };

    it("recommends Sonnet when Claude quota is healthy (> 30%)", () => {
      const input = { ...agenticPrompt, claudeQuotaStatus: "healthy" as const, claudeQuotaRatio: 0.75 };
      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(true);
      expect(decision.shadowAgenticProfile).toBe("sonnet-agentic");
    });

    it("suppresses Sonnet when Claude quota is reserve (< 10%)", () => {
      const input = { ...agenticPrompt, claudeQuotaStatus: "reserve" as const, claudeQuotaRatio: 0.08 };
      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.shadowAgenticReason).toContain("claude_quota_reserve");
    });

    it("suppresses Sonnet when Claude quota is exhausted (<= 0%)", () => {
      const input = { ...agenticPrompt, claudeQuotaStatus: "exhausted" as const, claudeQuotaRatio: 0.0 };
      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(false);
      expect(decision.shadowAgenticReason).toContain("claude_quota_exhausted");
    });

    it("suppresses Sonnet when Claude provider is unavailable", () => {
      const input = { ...agenticPrompt, claudeQuotaStatus: "unavailable" as const, claudeQuotaRatio: 0.0 };
      const decision = evaluateAgenticShadow(input, "gemini-flash-high", "ag/gemini-3.8-flash-high");
      expect(decision.wouldUseSonnet).toBe(false);
    });
  });
});