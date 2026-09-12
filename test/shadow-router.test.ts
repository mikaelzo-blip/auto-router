import { describe, expect, it } from "vitest";
import {
  createSessionStore,
  routeShadow,
  validateProfileRegistry,
  type ExecutionProfile,
  type ShadowRequest
} from "../src/shadow-router.js";

const profiles: ExecutionProfile[] = [
  { id: "cheap", model: "synthetic-cheap", enabled: true, hardCapabilities: { tools: false, vision: false }, taskFit: ["general", "transformation"], qualityTier: "cheap", costClass: "very_low", latencyClass: "fast" },
  { id: "balanced", model: "synthetic-balanced", enabled: true, hardCapabilities: { tools: true, vision: true }, taskFit: ["general", "code", "analysis", "research", "transformation", "multimodal"], qualityTier: "balanced", costClass: "low", latencyClass: "medium" },
  { id: "strong", model: "synthetic-strong", enabled: true, hardCapabilities: { tools: true, vision: true }, taskFit: ["code", "analysis", "research", "general", "multimodal"], qualityTier: "strong", costClass: "high", latencyClass: "slow" },
  { id: "frontier", model: "synthetic-frontier", enabled: true, hardCapabilities: { tools: true, vision: true }, taskFit: ["code", "analysis", "research", "general", "multimodal"], qualityTier: "frontier", costClass: "very_high", latencyClass: "slow" }
];
let sessionCounter = 0;
const base = (content: string, extra: Partial<ShadowRequest> = {}): ShadowRequest => ({ sessionId: "session-" + ++sessionCounter, messages: [{ role: "user", content }], policy: "balanced", ...extra });
const selected = (input: ShadowRequest) => routeShadow(input, profiles).selectedProfile;

describe("CP2 shadow router", () => {
  it("chooses cheap for trivial work and balanced for normal coding", () => {
    expect(selected(base("hello"))).toBe("cheap");
    expect(selected(base("fix this TypeScript function and run the tests"))).toBe("balanced");
  });
  it("raises quality for difficult concurrency and high risk", () => {
    expect(selected(base("debug a race condition in concurrent database writes"))).toBe("strong");
    expect(routeShadow(base("migrate critical financial ledger data", { riskHint: "high" }), profiles).minimumQualityTier).toBe("strong");
  });
  it("does not use prompt length alone and catches a short hard prompt", () => {
    expect(routeShadow(base("word ".repeat(1000)), profiles).complexity).not.toBe("high");
    expect(routeShadow(base("prove this lock-free algorithm is linearizable"), profiles).complexity).toBe("high");
  });
  it("weights latest intent and recent failures over old history", () => {
    const result = routeShadow(base("write a short explanation", { history: ["build a compiler", "design a distributed system"], currentIntent: "translate this sentence" }), profiles);
    expect(result.taskType).toBe("transformation");
    expect(result.explanation).toContain("latest");
  });
  it("requires tools only for explicit tool actions", () => {
    expect(routeShadow(base("inspect the repository and run tests"), profiles).requiredCapabilities.tools).toBe(true);
    expect(routeShadow(base("explain what tools are available"), profiles).requiredCapabilities.tools).toBe(false);
    expect(routeShadow(base("answer normally", { toolsProvided: true }), profiles).requiredCapabilities.tools).toBe(true);
  });
  it("filters vision and changes policy ranking without violating the floor", () => {
    const vision = routeShadow(base("describe this image", { hasVisionInput: true }), profiles);
    expect(vision.requiredCapabilities.vision).toBe(true);
    expect(vision.alternatives.every((id) => id !== "cheap")).toBe(true);
    expect(selected(base("implement a normal feature", { policy: "economy" }))).toBe("balanced");
    expect(selected(base("implement a normal feature", { policy: "quality" }))).toBe("strong");
  });
  it("uses hysteresis and permits material task changes", () => {
    const store = createSessionStore(60_000);
    const first = routeShadow(base("implement a feature", { sessionId: "sticky" }), profiles, store);
    const stable = routeShadow(base("implement another routine feature", { sessionId: "sticky" }), profiles, store);
    expect(stable.switchRecommended).toBe(false);
    expect(stable.currentProfile).toBe(first.selectedProfile);
    const changed = routeShadow(base("prove a concurrent financial transaction invariant", { sessionId: "sticky", riskHint: "high" }), profiles, store);
    expect(changed.switchRecommended).toBe(true);
    expect(changed.switchReason).toBe("quality_escalation");
  });
  it("escalates after failure and de-escalates only after certainty", () => {
    const failed = routeShadow(base("fix this code", { recentFailure: "tests failed with the same error" }), profiles);
    expect(failed.switchRecommended).toBe(true);
    expect(failed.switchReason).toBe("quality_escalation");
    const routine = routeShadow(base("format this text", { recentTestOutcome: "passed" }), profiles);
    expect(routine.switchReason).toBe("de_escalation");
  });
  it("rejects malformed registries", () => {
    expect(() => validateProfileRegistry([{ ...profiles[0]!, qualityTier: "unknown" as never }])).toThrow();
  });
});
