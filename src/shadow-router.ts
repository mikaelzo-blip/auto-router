import type { ChatMessage } from "./types.js";

export type ShadowTaskType = "general" | "transformation" | "code" | "analysis" | "research" | "multimodal";
export type Complexity = "trivial" | "low" | "medium" | "high" | "critical";
export type Risk = "low" | "medium" | "high";
export type QualityTier = "cheap" | "balanced" | "strong" | "frontier";
export type Policy = "economy" | "balanced" | "quality";
export type SwitchReason = "capability_change" | "task_change" | "complexity_increase" | "risk_increase" | "quality_escalation" | "provider_unavailable" | "manual_policy_change" | "de_escalation" | "none";

export interface ExecutionProfile {
  id: string;
  model: string;
  enabled: boolean;
  hardCapabilities: { tools: boolean; vision: boolean };
  taskFit: ShadowTaskType[];
  qualityTier: QualityTier;
  costClass: "very_low" | "low" | "medium" | "high" | "very_high";
  latencyClass: "fast" | "medium" | "slow";
  reasoningEffort?: "low" | "medium" | "high";
}

export interface ShadowRequest {
  sessionId: string;
  messages: ChatMessage[];
  currentIntent?: string;
  history?: string[];
  recentToolOutcome?: "success" | "failure";
  recentFailure?: string;
  recentTestOutcome?: "passed" | "failed";
  hasVisionInput?: boolean;
  toolsProvided?: boolean;
  policy: Policy;
  riskHint?: Risk;
}

export interface ShadowDecision {
  taskType: ShadowTaskType;
  complexity: Complexity;
  risk: Risk;
  minimumQualityTier: QualityTier;
  policy: Policy;
  requiredCapabilities: { tools: boolean; vision: boolean };
  currentProfile?: string;
  selectedProfile: string;
  alternatives: string[];
  switchRecommended: boolean;
  switchReason: SwitchReason;
  explanation: string;
  fallbackEngaged?: boolean;
  fallbackReason?: string;
}

interface SessionState { currentExecutionProfile: string; currentTaskType: ShadowTaskType; currentQualityTier: QualityTier; lastSwitchReason: SwitchReason; recentFailureCount: number; lastSeenAt: number; }
export function createSessionStore(ttlMs: number, maxSessions = 1000) {
  const state = new Map<string, SessionState>();
  return {
    ttlMs,
    get(id: string) {
      const value = state.get(id);
      if (!value || Date.now() - value.lastSeenAt > ttlMs) {
        state.delete(id);
        return undefined;
      }
      return value;
    },
    set(id: string, value: SessionState) {
      for (const [key, entry] of state) {
        if (Date.now() - entry.lastSeenAt > ttlMs) state.delete(key);
      }
      if (state.size >= maxSessions && !state.has(id)) state.delete(state.keys().next().value!);
      state.set(id, value);
    }
  };
}
export type SessionStore = ReturnType<typeof createSessionStore>;

const tiers: QualityTier[] = ["cheap", "balanced", "strong", "frontier"];
const words = (value: string) => value.normalize("NFKC").toLowerCase();
function textOf(request: ShadowRequest): string { return [request.currentIntent, ...request.messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "")].filter(Boolean).join(" "); }
function classify(request: ShadowRequest): ShadowTaskType {
  const text = words(request.currentIntent || textOf(request));
  if (request.hasVisionInput) return "multimodal";
  if (
    /code|repository|repo|typescript|javascript|python|node\.?js|fastify|express|diagnos|debug|\btest\b|build|compile|git|github|implement|function|class|method|concurr|database|sql|postgres|mysql|sqlite|query|mutex|thread|lock|race condition|socket|sse|stream|endpoint|api|route|handler|exception|stack trace|crash/.test(text)
  ) {
    return "code";
  }
  if (
    /research|latest|today|\bcurrent\b|news|source|web search|benchmarks?|state of the art|sota|literature|survey|releases?|trends?/.test(text)
  ) {
    return "research";
  }
  if (
    /analy[sz]|reconcil|settlement|ledger|accounting|audit|discrepan|invoice|contract|financial|risk|strategy|reason|architecture|review|hazard|trade.?off|evaluat|compare|explain deeply/.test(text)
  ) {
    return "analysis";
  }
  if (
    /\b(translate|rewrite|rephrase|format|summariz[a-z]*|reformat[a-z]*|prettify|convert)\b/.test(text)
  ) {
    return "transformation";
  }
  return "general";
}
function complexity(request: ShadowRequest): Complexity {
  const text = words(textOf(request));
  if (/linearizable|race condition|concurr|distributed|architecture|security invariant|financial ledger|lock-free|critical/.test(text)) return "high";
  if (request.recentFailure || request.recentTestOutcome === "failed") return "high";
  if (/step by step|trade.?off|in depth|deeply|multiple files|migration/.test(text)) return "medium";
  if (text.trim().length < 40 && !/implement|debug|prove|design/.test(text)) return "trivial";
  return "low";
}
function riskOf(request: ShadowRequest): Risk {
  const text = words(textOf(request));
  if (request.riskHint) return request.riskHint;
  if (/financial|ledger|payment|security|legal|medical|data integrity|production|reconcil|settlement|invoice/.test(text)) return "high";
  if (/database|migration|delete|deploy|auth|concurr|race condition|lock/.test(text)) return "medium";
  return "low";
}
function floor(complexityLevel: Complexity, risk: Risk, request: ShadowRequest): QualityTier {
  if (risk === "high" || complexityLevel === "critical") return "strong";
  if (complexityLevel === "high" || request.recentFailure || request.recentTestOutcome === "failed") return "strong";
  if (complexityLevel === "medium") return "balanced";
  return "cheap";
}
function tierForPolicy(minimum: QualityTier, policy: Policy): QualityTier { const minimumIndex = tiers.indexOf(minimum); const desired = policy === "quality" ? 2 : 0; return tiers[Math.max(minimumIndex, desired)]!; }
function costRank(profile: ExecutionProfile, policy: Policy): number { const cost = ["very_low", "low", "medium", "high", "very_high"].indexOf(profile.costClass); return policy === "economy" ? -cost : policy === "quality" ? cost : -Math.abs(cost - 1); }

export function validateProfileRegistry(profiles: ExecutionProfile[]): void {
  if (!Array.isArray(profiles) || profiles.length === 0) throw new Error("Profile registry must not be empty");
  const ids = new Set<string>();
  const validCosts = ["very_low", "low", "medium", "high", "very_high"];
  const validLatencies = ["fast", "medium", "slow"];
  const validEfforts = ["low", "medium", "high", undefined];
  const validTasks: ShadowTaskType[] = ["general", "transformation", "code", "analysis", "research", "multimodal"];
  for (const profile of profiles) {
    if (!profile.id || !profile.model || ids.has(profile.id) || !tiers.includes(profile.qualityTier) || !Array.isArray(profile.taskFit) || profile.taskFit.some((task) => !validTasks.includes(task)) || !validCosts.includes(profile.costClass) || !validLatencies.includes(profile.latencyClass) || !validEfforts.includes(profile.reasoningEffort) || typeof profile.enabled !== "boolean" || typeof profile.hardCapabilities?.tools !== "boolean" || typeof profile.hardCapabilities?.vision !== "boolean") throw new Error(`Malformed execution profile: ${profile.id || "unknown"}`);
    ids.add(profile.id);
  }
}

export function validateProfileCoverage(profiles: ExecutionProfile[]): void {
  const allTasks: ShadowTaskType[] = ["general", "transformation", "code", "analysis", "research", "multimodal"];
  const allTiers: QualityTier[] = ["cheap", "balanced", "strong", "frontier"];
  const missing: string[] = [];

  for (const task of allTasks) {
    for (const tools of [false, true]) {
      for (const vision of [false, true]) {
        for (const tier of allTiers) {
          const tierIndex = tiers.indexOf(tier);
          const hasMatch = profiles.some(
            (p) =>
              p.enabled &&
              p.taskFit.includes(task) &&
              (!tools || p.hardCapabilities.tools) &&
              (!vision || p.hardCapabilities.vision) &&
              tiers.indexOf(p.qualityTier) >= tierIndex
          );
          if (!hasMatch) {
            missing.push(`task=${task}, tier>=${tier}, tools=${tools}, vision=${vision}`);
          }
        }
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Profile registry has coverage gaps (${missing.length} unservable combinations): ${missing.slice(0, 5).join("; ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`
    );
  }
}

export function routeShadow(request: ShadowRequest, profiles: ExecutionProfile[], store?: SessionStore): ShadowDecision {
  validateProfileRegistry(profiles);
  const taskType = classify(request);
  const level = complexity(request);
  const risk = riskOf(request);
  const minimumQualityTier = floor(level, risk, request);
  const requiredCapabilities = { tools: Boolean(request.toolsProvided || /inspect|read files?|write files?|run tests?|search (the )?repo|execute|patch|implement/.test(words(textOf(request)))), vision: Boolean(request.hasVisionInput) };
  const minimumIndex = tiers.indexOf(minimumQualityTier);
  let eligible = profiles.filter((p) => p.enabled && p.taskFit.includes(taskType) && (!requiredCapabilities.tools || p.hardCapabilities.tools) && (!requiredCapabilities.vision || p.hardCapabilities.vision) && tiers.indexOf(p.qualityTier) >= minimumIndex);
  let fallbackEngaged = false;
  let fallbackReason: string | undefined;

  if (!eligible.length) {
    fallbackEngaged = true;
    // 1. Try relaxing taskFit while respecting hard capabilities and minimum quality tier
    eligible = profiles.filter((p) => p.enabled && (!requiredCapabilities.tools || p.hardCapabilities.tools) && (!requiredCapabilities.vision || p.hardCapabilities.vision) && tiers.indexOf(p.qualityTier) >= minimumIndex);
    if (eligible.length > 0) {
      fallbackReason = `relaxed taskFit [${taskType}] to capability-compatible profiles meeting ${minimumQualityTier} tier`;
    } else {
      // 2. Try relaxing quality floor while strictly maintaining hard capabilities
      eligible = profiles.filter((p) => p.enabled && (!requiredCapabilities.tools || p.hardCapabilities.tools) && (!requiredCapabilities.vision || p.hardCapabilities.vision));
      if (eligible.length > 0) {
        fallbackReason = `relaxed minimum quality tier [${minimumQualityTier}] to satisfy hard capabilities`;
      } else {
        // 3. Fallback to any enabled profile
        eligible = profiles.filter((p) => p.enabled);
        if (eligible.length > 0) {
          fallbackReason = "relaxed hard capabilities to best available enabled profile";
        } else {
          throw new Error("No enabled profile in registry satisfies shadow request");
        }
      }
    }
  }
  const desiredTier = tierForPolicy(minimumQualityTier, request.policy);
  const ranked = [...eligible].sort((a, b) => Math.abs(tiers.indexOf(a.qualityTier) - tiers.indexOf(desiredTier)) - Math.abs(tiers.indexOf(b.qualityTier) - tiers.indexOf(desiredTier)) || costRank(b, request.policy) - costRank(a, request.policy));
  const previous = store?.get(request.sessionId);
  const failureEscalates = Boolean(request.recentFailure || request.recentToolOutcome === "failure" || request.recentTestOutcome === "failed");
  const initialSelection = ranked[0]!;
  const previousCandidate = previous ? eligible.find((profile) => profile.id === previous.currentExecutionProfile) : undefined;
  const materiallyChanged = level === "high" || risk !== "low" || failureEscalates || Boolean(previous && previous.currentTaskType !== taskType);
  const selectedProfile = previousCandidate && !materiallyChanged && tiers.indexOf(previousCandidate.qualityTier) === tiers.indexOf(initialSelection.qualityTier)
    ? previousCandidate.id
    : initialSelection.id;
  const alternatives = ranked.filter((profile) => profile.id !== selectedProfile).slice(0, 3).map((profile) => profile.id);
  let switchRecommended = Boolean((previous && previous.currentExecutionProfile !== selectedProfile) || failureEscalates);
  let switchReason: SwitchReason = request.recentTestOutcome === "passed" ? "de_escalation" : "none";
  if (switchRecommended) {
    switchReason = failureEscalates ? "quality_escalation" : level === "high" ? "quality_escalation" : previous && risk !== "low" && previous.currentQualityTier !== minimumQualityTier ? "risk_increase" : previous && taskType !== previous.currentTaskType ? "task_change" : "de_escalation";
    if (switchReason === "de_escalation") switchRecommended = Boolean(request.recentTestOutcome === "passed");
  }
  if (store) store.set(request.sessionId, { currentExecutionProfile: selectedProfile, currentTaskType: taskType, currentQualityTier: tiers[Math.max(minimumIndex, tiers.indexOf(desiredTier))]!, lastSwitchReason: switchReason, recentFailureCount: request.recentFailure ? 1 : 0, lastSeenAt: Date.now() });
  const reasons = [taskType !== "general" ? `latest intent classified as ${taskType}` : "latest intent is routine", `complexity is ${level}`, `risk is ${risk}`, `minimum quality is ${minimumQualityTier}`, "pipeline: capability, health, classification, complexity, risk, quality floor, candidate pool, policy, hysteresis, ranking"];
  if (request.recentFailure) reasons.push("recent failure recommends escalation");
  if (request.recentTestOutcome === "passed") reasons.push("recent passing verification permits de-escalation");
  if (fallbackEngaged && fallbackReason) reasons.push(`fallback: ${fallbackReason}`);
  return {
    taskType,
    complexity: level,
    risk,
    minimumQualityTier,
    policy: request.policy,
    requiredCapabilities,
    currentProfile: previous?.currentExecutionProfile,
    selectedProfile,
    alternatives,
    switchRecommended,
    switchReason,
    explanation: reasons.join("; ") + (request.currentIntent ? "; latest intent outweighs old history" : ""),
    ...(fallbackEngaged ? { fallbackEngaged, fallbackReason } : {})
  };
}
