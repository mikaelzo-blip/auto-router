import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RoutingConfig } from "./types.js";
import { normalizeTimeoutConfig, validateTimeoutConfig } from "./reliability.js";
import { validateProfileRegistry, validateProfileCoverage, type ExecutionProfile } from "./shadow-router.js";
import type { QuotaPolicy, QuotaThresholds, QuotaSource } from "./quota/types.js";
import { DEFAULT_QUOTA_THRESHOLDS } from "./quota/policy.js";

async function loadShadowProfiles(): Promise<ExecutionProfile[]> {
  const path = resolve(process.env.SHADOW_PROFILE_CONFIG ?? "./config/shadow-profiles.json");
  const payload = JSON.parse(await readFile(path, "utf8")) as { profiles?: ExecutionProfile[] };
  if (!payload.profiles) throw new Error("Invalid shadow profile config");
  validateProfileRegistry(payload.profiles);
  validateProfileCoverage(payload.profiles);
  return payload.profiles;
}

export interface AppConfig {
  host: string;
  port: number;
  routerMode?: "legacy" | "shadow" | "v2";
  reasoningPolicy?: "passthrough" | "auto" | "shadow";
  quotaPolicy?: QuotaPolicy;
  quotaSourceBaseUrl?: string;
  quotaRefreshTtlMs?: number;
  quotaStaleFallbackMs?: number;
  quotaSourceTimeoutMs?: number;
  quotaThresholds?: QuotaThresholds;
  quotaSource?: QuotaSource;
  sonnetAgenticEnabled?: boolean;
  agenticPrimaryEnabled?: boolean;
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  classifierModel?: string;
  classifierTimeoutMs: number;
  upstreamTimeoutMs: number;
  connectTimeoutMs?: number;
  headerTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  logLevel: string;
  routing: RoutingConfig;
  shadowProfiles?: ExecutionProfile[];
}

const integer = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
};

export async function loadConfig(): Promise<AppConfig> {
  const path = resolve(process.env.ROUTING_CONFIG ?? "./config/routes.json");
  const routing = JSON.parse(await readFile(path, "utf8")) as RoutingConfig;
  validateRoutingConfig(routing);
  const timeoutConfig = normalizeTimeoutConfig({
    connectTimeoutMs: integer(process.env.UPSTREAM_CONNECT_TIMEOUT_MS, 30_000),
    headerTimeoutMs: integer(process.env.UPSTREAM_HEADER_TIMEOUT_MS, 30_000),
    firstByteTimeoutMs: integer(process.env.UPSTREAM_FIRST_BYTE_TIMEOUT_MS, 60_000),
    streamIdleTimeoutMs: integer(process.env.UPSTREAM_STREAM_IDLE_TIMEOUT_MS, 30_000)
  });
  validateTimeoutConfig(timeoutConfig);
  const shadowProfiles = await loadShadowProfiles();
  const host = process.env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("HOST must be 127.0.0.1 or localhost; AutoRouter is localhost-only");
  }
  const upstreamBaseUrl = (process.env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:20128/v1").replace(/\/$/, "");
  const upstream = new URL(upstreamBaseUrl);
  if (!["127.0.0.1", "localhost"].includes(upstream.hostname)) {
    throw new Error("UPSTREAM_BASE_URL must point to localhost");
  }
  const modeRaw = (process.env.ROUTER_MODE ?? "legacy").toLowerCase();
  if (!["legacy", "shadow", "v2"].includes(modeRaw)) {
    throw new Error(`Invalid ROUTER_MODE: ${process.env.ROUTER_MODE}. Must be legacy, shadow, or v2`);
  }
  const routerMode = modeRaw as "legacy" | "shadow" | "v2";
  const reasoningPolicyRaw = (process.env.REASONING_POLICY ?? "passthrough").toLowerCase();
  if (!["passthrough", "auto", "shadow"].includes(reasoningPolicyRaw)) {
    throw new Error(`Invalid REASONING_POLICY: ${process.env.REASONING_POLICY}. Must be passthrough, auto, or shadow`);
  }
  const reasoningPolicy = reasoningPolicyRaw as "passthrough" | "auto" | "shadow";

  const quotaPolicyRaw = (process.env.QUOTA_POLICY ?? "off").toLowerCase();
  if (!["off", "shadow", "auto"].includes(quotaPolicyRaw)) {
    throw new Error(`Invalid QUOTA_POLICY: ${process.env.QUOTA_POLICY}. Must be off, shadow, or auto`);
  }
  const quotaPolicy = quotaPolicyRaw as QuotaPolicy;
  const quotaSourceBaseUrl = process.env.QUOTA_SOURCE_BASE_URL ?? upstream.origin;
  const quotaRefreshTtlMs = integer(process.env.QUOTA_REFRESH_TTL_MS, 30_000);
  const quotaStaleFallbackMs = integer(process.env.QUOTA_STALE_FALLBACK_MS, 60_000);
  const quotaSourceTimeoutMs = integer(process.env.QUOTA_SOURCE_TIMEOUT_MS, 5000);

  const healthyMin = process.env.QUOTA_HEALTHY_MIN !== undefined ? Number(process.env.QUOTA_HEALTHY_MIN) : DEFAULT_QUOTA_THRESHOLDS.healthyMin;
  const conserveMin = process.env.QUOTA_CONSERVE_MIN !== undefined ? Number(process.env.QUOTA_CONSERVE_MIN) : DEFAULT_QUOTA_THRESHOLDS.conserveMin;
  const conserveExit = process.env.QUOTA_CONSERVE_EXIT !== undefined ? Number(process.env.QUOTA_CONSERVE_EXIT) : DEFAULT_QUOTA_THRESHOLDS.conserveExit;
  const reserveExit = process.env.QUOTA_RESERVE_EXIT !== undefined ? Number(process.env.QUOTA_RESERVE_EXIT) : DEFAULT_QUOTA_THRESHOLDS.reserveExit;

  const quotaThresholds: QuotaThresholds = {
    healthyMin,
    conserveMin,
    conserveExit,
    reserveExit
  };

  const agenticPrimaryEnabled = (process.env.AGENTIC_PRIMARY_ENABLED ?? process.env.SONNET_AGENTIC_ENABLED ?? "false").toLowerCase() === "true";
  const sonnetAgenticEnabled = agenticPrimaryEnabled;

  return {
    host,
    port: integer(process.env.PORT, 20200),
    routerMode,
    reasoningPolicy,
    quotaPolicy,
    quotaSourceBaseUrl,
    quotaRefreshTtlMs,
    quotaStaleFallbackMs,
    quotaSourceTimeoutMs,
    quotaThresholds,
    sonnetAgenticEnabled,
    agenticPrimaryEnabled,
    upstreamBaseUrl,
    upstreamApiKey: process.env.UPSTREAM_API_KEY || undefined,
    classifierModel: process.env.CLASSIFIER_MODEL || undefined,
    classifierTimeoutMs: integer(process.env.CLASSIFIER_TIMEOUT_MS, 5000),
    upstreamTimeoutMs: timeoutConfig.headerTimeoutMs,
    connectTimeoutMs: timeoutConfig.connectTimeoutMs,
    headerTimeoutMs: timeoutConfig.headerTimeoutMs,
    firstByteTimeoutMs: timeoutConfig.firstByteTimeoutMs,
    streamIdleTimeoutMs: timeoutConfig.streamIdleTimeoutMs,
    logLevel: process.env.LOG_LEVEL ?? "info",
    routing,
    shadowProfiles
  };
}

function validateRoutingConfig(config: RoutingConfig): void {
  if (!config.virtualModel || !config.virtualModels || !config.globalFallbackModel || !config.routes || Object.keys(config.routes).length === 0 || !config.modelCapabilities) throw new Error("Invalid routing config");
  if (!config.virtualModels[config.virtualModel] || config.virtualModels[config.virtualModel]!.route) throw new Error("Semantic virtual model must be configured without a forced route");
  for (const [alias, virtual] of Object.entries(config.virtualModels)) {
    if (alias !== config.virtualModel && (!virtual.route || !config.routes[virtual.route])) throw new Error(`Invalid virtual model alias: ${alias}`);
  }
  for (const name of [config.defaultRoute, config.ambiguousFallback, ...config.precedence]) {
    if (!config.routes[name]) throw new Error(`Unknown route in routing config: ${name}`);
  }
  for (const [name, route] of Object.entries(config.routes)) {
    if (!route.upstreamModel || !Array.isArray(route.keywords) || !route.capabilities) throw new Error(`Invalid route: ${name}`);
    if (route.selectionPriority && !route.selectionPriority.includes(route.upstreamModel)) throw new Error(`Selected model is absent from priority list: ${name}`);
    for (const model of route.selectionPriority ?? [route.upstreamModel, config.globalFallbackModel]) {
      if (!config.modelCapabilities[model]) throw new Error(`Missing capabilities for model: ${model}`);
    }
  }
}
