import type { ExecutionProfile } from "./shadow-router.js";

export const DEFAULT_SHADOW_PROFILES: ExecutionProfile[] = [
  { id: "gemini-flash-low", model: "ag/gemini-3.8-flash-low", enabled: true, hardCapabilities: { tools: true, vision: true }, taskFit: ["general", "transformation"], qualityTier: "cheap", costClass: "very_low", latencyClass: "fast", reasoningEffort: "low" },
  { id: "gemini-flash-medium", model: "ag/gemini-3.8-flash-medium", enabled: true, hardCapabilities: { tools: true, vision: true }, taskFit: ["general", "transformation", "code", "analysis", "research", "multimodal"], qualityTier: "balanced", costClass: "low", latencyClass: "fast", reasoningEffort: "medium" },
  { id: "gemini-flash-high", model: "ag/gemini-3.8-flash-high", enabled: true, hardCapabilities: { tools: true, vision: true }, taskFit: ["general", "transformation", "code", "analysis", "research", "multimodal"], qualityTier: "strong", costClass: "medium", latencyClass: "medium", reasoningEffort: "high" },
  { id: "claude-sonnet", model: "ag/claude-sonnet-4-6", enabled: true, hardCapabilities: { tools: true, vision: true }, taskFit: ["general", "transformation", "code", "analysis", "research", "multimodal"], qualityTier: "strong", costClass: "high", latencyClass: "slow", reasoningEffort: "high" },
  { id: "claude-opus", model: "ag/claude-opus-4-6-thinking", enabled: true, hardCapabilities: { tools: true, vision: true }, taskFit: ["general", "transformation", "code", "analysis", "research", "multimodal"], qualityTier: "frontier", costClass: "very_high", latencyClass: "slow", reasoningEffort: "high" },
  { id: "astra", model: "cx/gpt-6-astra", enabled: true, hardCapabilities: { tools: true, vision: true }, taskFit: ["general", "transformation", "code", "analysis", "research", "multimodal"], qualityTier: "frontier", costClass: "very_high", latencyClass: "slow", reasoningEffort: "high" }
];
