import { Readable } from "node:stream";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { routeRequest, supportsRequirements } from "./router.js";
import { createSessionStore, routeShadow, type ShadowRequest } from "./shadow-router.js";
import { DEFAULT_SHADOW_PROFILES } from "./shadow-profiles.js";
import type { ChatCompletionRequest, ChatMessage } from "./types.js";
import { sanitizedUpstreamError, UpstreamClient } from "./upstream.js";
import { StreamLifecycleTracker, classifyUpstreamError, withStreamTimeouts } from "./reliability.js";
import {
  determineAutoReasoning,
  resolveReasoningDecision,
  applyReasoningToPayload,
  normalizeReasoningEffort,
  type ReasoningContext
} from "./reasoning.js";
import { QuotaCooldownTracker } from "./quota/cooldown.js";
import { NineRouterQuotaSource } from "./quota/source.js";
import {
  resolveQuotaDecision,
  filterAndRankWithQuota,
  evaluateCandidateQuota,
  DEFAULT_QUOTA_THRESHOLDS
} from "./quota/policy.js";
import type { QuotaDecisionResult } from "./quota/policy.js";
import type { QuotaSource } from "./quota/types.js";
import {
  evaluateAgenticShadow,
  createAgenticSessionStore,
  type ShadowAgenticDecision
} from "./agentic-shadow.js";

const chatSchema = {
  type: "object",
  required: ["model", "messages"],
  additionalProperties: true,
  properties: {
    model: { type: "string", minLength: 1, maxLength: 200 },
    messages: {
      type: "array",
      minItems: 1,
      maxItems: 1000,
      items: {
        type: "object",
        required: ["role"],
        additionalProperties: true,
        properties: {
          role: { type: "string", minLength: 1 },
          content: {}
        }
      }
    },
    stream: { type: "boolean" },
    tools: { type: "array", maxItems: 128 },
    functions: { type: "array", maxItems: 128 }
  }
} as const;

type ReadinessResult = {
  status: "ready" | "not_ready";
  upstream: "ok" | "error";
  modelsDiscovered: number;
  configuredModels: string[];
  missingModels: string[];
  checkedAt: string;
};

export function buildApp(config: AppConfig): FastifyInstance {

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "headers.authorization",
        "body.messages",
        "body.tools",
        "body.functions"
      ]
    },
    bodyLimit: 10 * 1024 * 1024
  });

  const upstream = new UpstreamClient(
    config.upstreamBaseUrl,
    config.upstreamApiKey,
    {
      connectTimeoutMs: config.connectTimeoutMs ?? config.upstreamTimeoutMs,
      headerTimeoutMs: config.headerTimeoutMs ?? config.upstreamTimeoutMs,
      firstByteTimeoutMs: config.firstByteTimeoutMs ?? config.upstreamTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? config.upstreamTimeoutMs
    },
    config.classifierModel,
    config.classifierTimeoutMs
  );

  const timeoutConfig = {
    connectTimeoutMs: config.connectTimeoutMs ?? config.upstreamTimeoutMs,
    headerTimeoutMs: config.headerTimeoutMs ?? config.upstreamTimeoutMs,
    firstByteTimeoutMs: config.firstByteTimeoutMs ?? config.upstreamTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? config.upstreamTimeoutMs
  };

  const startedAt = Date.now();

  const metrics = {
    requestsTotal: 0,
    requestsSuccess: 0,
    requestsError: 0,
    upstreamAttempts: 0,
    fallbackEvents: 0,
    routeCounts: {} as Record<string, number>,
    statusCounts: {} as Record<string, number>,
    streamLifecycle: {} as Record<string, number>,
    latencySamples: [] as number[]
  };

  let readinessCache:
    | { at: number; value: ReadinessResult }
    | undefined;

  const MAX_LATENCY_SAMPLES = 200;
  const READINESS_CACHE_MS = 15_000;
  const shadowStore = createSessionStore(15 * 60_000);
  const shadowProfiles = config.shadowProfiles ?? DEFAULT_SHADOW_PROFILES;

  const quotaTracker = new QuotaCooldownTracker();
  const quotaSource: QuotaSource = config.quotaSource ?? new NineRouterQuotaSource({
    baseUrl: config.quotaSourceBaseUrl ?? "http://127.0.0.1:20128",
    refreshTtlMs: config.quotaRefreshTtlMs ?? 30_000,
    staleFallbackMs: config.quotaStaleFallbackMs ?? 60_000,
    timeoutMs: config.quotaSourceTimeoutMs ?? 5000
  });
  const quotaPolicy = config.quotaPolicy ?? "off";
  const quotaThresholds = config.quotaThresholds ?? DEFAULT_QUOTA_THRESHOLDS;

  app.addHook("onClose", async () => {
    quotaSource.close();
  });

  function computeShadow(body: ChatCompletionRequest, sessionId = "anonymous") {
    const latestUser = [...body.messages].reverse().find((message) => message.role === "user");
    const currentIntent = typeof latestUser?.content === "string" ? latestUser.content : undefined;
    const recentMessages = body.messages.slice(-3);
    const recentFailure = recentMessages.some((message) => message.role === "tool" && /fail|error|reject/i.test(String(message.content)))
      ? "recent tool failure"
      : undefined;
    const recentTestOutcome = recentMessages.some((message) => /tests? (passed|green)|build passed/i.test(String(message.content)))
      ? "passed"
      : recentMessages.some((message) => /tests? (failed|red)|build failed/i.test(String(message.content)))
        ? "failed"
        : undefined;
    const shadowRequest: ShadowRequest = {
      sessionId,
      messages: body.messages,
      currentIntent,
      recentFailure,
      recentTestOutcome,
      hasVisionInput: Boolean(body.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part && typeof part === "object" && ["image_url", "input_image", "image"].includes(String((part as { type?: unknown }).type))))),
      toolsProvided: Boolean(body.tools?.length || body.functions?.length),
      policy: "balanced"
    };
    return routeShadow(shadowRequest, shadowProfiles, shadowStore);
  }

  const agenticSessionStore = createAgenticSessionStore(120_000);

  function computeAgenticShadow(
    body: ChatCompletionRequest,
    actualProfile: string,
    actualModel: string,
    quotaSnapshot?: any,
    sessionId = "anonymous"
  ): ShadowAgenticDecision {
    const sonnetProfile = shadowProfiles.find((p) => p.id === "sonnet-agentic");
    const sonnetQuotaState = (sonnetProfile && quotaSnapshot)
      ? evaluateCandidateQuota(sonnetProfile, quotaSnapshot, quotaTracker, undefined, quotaThresholds)
      : undefined;

    const recentMessages = body.messages.slice(-3);
    const recentFailure = recentMessages.some((message) => message.role === "tool" && /fail|error|reject/i.test(String(message.content)))
      ? "recent tool failure"
      : undefined;
    const recentTestOutcome = recentMessages.some((message) => /tests? (passed|green)|build passed/i.test(String(message.content)))
      ? "passed"
      : recentMessages.some((message) => /tests? (failed|red)|build failed/i.test(String(message.content)))
        ? "failed"
        : undefined;

    return evaluateAgenticShadow(
      {
        sessionId,
        messages: body.messages,
        recentFailure,
        recentTestOutcome,
        toolsProvided: Boolean(body.tools?.length || body.functions?.length),
        claudeQuotaStatus: sonnetQuotaState?.status,
        claudeQuotaRatio: sonnetQuotaState?.effectiveRemainingRatio
      },
      actualProfile,
      actualModel,
      agenticSessionStore
    );
  }

  function configuredUpstreams(): string[] {
    const models: string[] = [];

    for (const route of Object.values(config.routing.routes)) {
      const candidates =
        route.selectionPriority?.length
          ? route.selectionPriority
          : [
              route.upstreamModel,
              config.routing.globalFallbackModel
            ];

      models.push(...candidates);
    }

    return [...new Set(models.filter(Boolean))];
  }

  async function checkReadiness(
    force = false
  ): Promise<ReadinessResult> {

    const now = Date.now();

    if (
      !force &&
      readinessCache &&
      now - readinessCache.at < READINESS_CACHE_MS
    ) {
      return readinessCache.value;
    }

    const configured = configuredUpstreams();

    try {
      const response = await upstream.models(
        AbortSignal.timeout(5000)
      );

      if (!response.ok) {
        throw new Error("models endpoint unavailable");
      }

      const payload = await response.json() as {
        data?: Array<{ id?: unknown }>;
      };

      const ids = new Set(
        (payload.data ?? [])
          .map((entry) =>
            typeof entry.id === "string" ? entry.id : undefined
          )
          .filter((id): id is string => Boolean(id))
      );

      const missing = configured.filter(
        (model) => !ids.has(model)
      );

      const result: ReadinessResult = {
        status: missing.length === 0 ? "ready" : "not_ready",
        upstream: "ok",
        modelsDiscovered: ids.size,
        configuredModels: configured,
        missingModels: missing,
        checkedAt: new Date().toISOString()
      };

      readinessCache = {
        at: now,
        value: result
      };

      return result;

    } catch {

      const result: ReadinessResult = {
        status: "not_ready",
        upstream: "error",
        modelsDiscovered: 0,
        configuredModels: configured,
        missingModels: configured,
        checkedAt: new Date().toISOString()
      };

      readinessCache = {
        at: now,
        value: result
      };

      return result;
    }
  }

  function percentile(
    values: number[],
    percentileValue: number
  ): number {

    if (!values.length) return 0;

    const sorted = [...values].sort((a, b) => a - b);

    const index = Math.max(
      0,
      Math.ceil(
        (percentileValue / 100) * sorted.length
      ) - 1
    );

    return Math.round(sorted[index]! * 10) / 10;
  }

  function latencyStats() {

    const samples = metrics.latencySamples;

    if (!samples.length) {
      return {
        samples: 0,
        avgMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0
      };
    }

    const avg =
      samples.reduce((sum, n) => sum + n, 0) /
      samples.length;

    return {
      samples: samples.length,
      avgMs: Math.round(avg * 10) / 10,
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
      maxMs: Math.round(Math.max(...samples) * 10) / 10
    };
  }

  // ----------------------------------------------------------
  // LIVENESS
  // Hanya memastikan proses AutoRouter hidup.
  // ----------------------------------------------------------

  app.get("/health", async () => ({
    status: "ok",
    service: "auto-router"
  }));

  // ----------------------------------------------------------
  // READINESS
  // Zero LLM token:
  // AutoRouter -> 9Router /v1/models
  // ----------------------------------------------------------

  app.get("/health/ready", async (_request, reply) => {

    const result = await checkReadiness();

    return reply
      .code(result.status === "ready" ? 200 : 503)
      .send(result);
  });

  // ----------------------------------------------------------
  // METRICS
  // Tidak melakukan network request / LLM request.
  // ----------------------------------------------------------

  app.get("/metrics", async () => {

    const memory = process.memoryUsage();

    return {
      service: "auto-router",
      mode: "production",

      uptimeSeconds:
        Math.round((Date.now() - startedAt) / 1000),

      process: {
        pid: process.pid,
        rssMb:
          Math.round(memory.rss / 1024 / 1024 * 10) / 10,
        heapUsedMb:
          Math.round(memory.heapUsed / 1024 / 1024 * 10) / 10
      },

      requests: {
        total: metrics.requestsTotal,
        success: metrics.requestsSuccess,
        error: metrics.requestsError,
        upstreamAttempts: metrics.upstreamAttempts,
        fallbackEvents: metrics.fallbackEvents
      },

      routes: metrics.routeCounts,
      statusCodes: metrics.statusCounts,

      latency: latencyStats(),
      streamLifecycle: metrics.streamLifecycle,

      readiness: readinessCache?.value
        ? {
            status: readinessCache.value.status,
            upstream: readinessCache.value.upstream,
            modelsDiscovered:
              readinessCache.value.modelsDiscovered,
            missingModels:
              readinessCache.value.missingModels,
            checkedAt:
              readinessCache.value.checkedAt
          }
        : {
            status: "unknown"
          }
    };
  });

  app.get("/v1/models", async () => ({
    object: "list",
    data: Object.keys(
      config.routing.virtualModels
    ).map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "auto-router"
    }))
  }));

  app.post<{ Body: ChatCompletionRequest }>(
    "/debug/route",
    { schema: { body: chatSchema } },
    async (request, reply) => {

      if (
        !config.routing.virtualModels[
          request.body.model
        ]
      ) {
        return reply.code(400).send(
          openAiError(
            `Unknown model '${request.body.model}'.`,
            "invalid_model"
          )
        );
      }

      try {
        const actual = await routeRequest(
          request.body,
          config.routing,
          config.classifierModel
            ? upstream
            : undefined
        );
        let shadowV2;
        try {
          shadowV2 = computeShadow(request.body, request.headers["x-session-id"]?.toString());
        } catch {
          shadowV2 = { error: "shadow routing unavailable" };
        }

        const clientEffort = normalizeReasoningEffort(request.body.reasoning_effort ?? (request.body.reasoning as any)?.effort);
        const reasoningContext: ReasoningContext = {
          taskType: shadowV2 && typeof shadowV2 === "object" && "taskType" in shadowV2 ? (shadowV2 as any).taskType : undefined,
          complexity: shadowV2 && typeof shadowV2 === "object" && "complexity" in shadowV2 ? (shadowV2 as any).complexity : undefined,
          risk: shadowV2 && typeof shadowV2 === "object" && "risk" in shadowV2 ? (shadowV2 as any).risk : undefined,
          promptText: typeof request.body.messages?.[request.body.messages.length - 1]?.content === "string" ? String(request.body.messages[request.body.messages.length - 1]?.content) : undefined,
          selectedProfile: shadowV2 && typeof shadowV2 === "object" && "selectedProfile" in shadowV2 ? (shadowV2 as any).selectedProfile : undefined
        };
        const autoReasoning = determineAutoReasoning(reasoningContext);
        const matchedProfile = (reasoningContext.selectedProfile ? shadowProfiles.find((p) => p.id === reasoningContext.selectedProfile) : undefined) ??
          shadowProfiles.find((p) => p.model === actual.upstreamModel) ??
          shadowProfiles[0]!;

        const currentPolicy = config.reasoningPolicy ?? "passthrough";
        const resolvedReasoning = resolveReasoningDecision({
          policy: currentPolicy,
          clientEffort,
          autoDesired: autoReasoning.desired,
          profile: matchedProfile,
          escalationApplied: autoReasoning.escalationApplied,
          deescalationApplied: autoReasoning.deescalationApplied,
          reasons: autoReasoning.reasons
        });

        const quotaSnapshot = await quotaSource.getSnapshot();
        const quotaDecision = resolveQuotaDecision({
          standardSelectedProfile: shadowV2 && typeof shadowV2 === "object" && "selectedProfile" in shadowV2 ? (shadowV2 as any).selectedProfile : undefined,
          taskType: reasoningContext.taskType ?? "general",
          specialistIntent: shadowV2 && typeof shadowV2 === "object" && "specialistIntent" in shadowV2 ? (shadowV2 as any).specialistIntent : undefined,
          complexity: reasoningContext.complexity ?? "medium",
          risk: reasoningContext.risk ?? "low",
          minimumQualityTier: shadowV2 && typeof shadowV2 === "object" && "minimumQualityTier" in shadowV2 ? (shadowV2 as any).minimumQualityTier : "cheap",
          requiredCapabilities: shadowV2 && typeof shadowV2 === "object" && "requiredCapabilities" in shadowV2 ? (shadowV2 as any).requiredCapabilities : { tools: false, vision: false },
          profiles: shadowProfiles,
          snapshot: quotaSnapshot,
          cooldownTracker: quotaTracker,
          quotaPolicy,
          thresholds: quotaThresholds
        });

        const effectiveProfile = (quotaPolicy === "auto" && quotaDecision.selectedProfile)
          ? shadowProfiles.find((p) => p.id === quotaDecision.selectedProfile) ?? matchedProfile
          : matchedProfile;

        const shadowAgentic = computeAgenticShadow(
          request.body,
          effectiveProfile.id,
          effectiveProfile.model,
          quotaSnapshot,
          request.headers["x-session-id"]?.toString()
        );

        return {
          ...actual,
          actual: { route: actual.route, upstreamModel: actual.upstreamModel },
          selectedProfile: effectiveProfile.id,
          selectedModel: effectiveProfile.model,
          complexity: reasoningContext.complexity ?? "medium",
          risk: reasoningContext.risk ?? "low",
          shadowV2,
          shadowAgentic,
          reasoning: resolvedReasoning.debugSummary,
          quota: {
            policy: quotaDecision.policy,
            status: quotaDecision.status,
            effectiveRemainingRatio: quotaDecision.effectiveRemainingRatio,
            limitingBuckets: quotaDecision.limitingBuckets,
            snapshotAgeMs: quotaDecision.snapshotAgeMs,
            stale: quotaDecision.stale,
            selectionEffect: quotaDecision.selectionEffect,
            decisionReason: quotaDecision.decisionReason,
            hypotheticalProfile: quotaDecision.hypotheticalProfile,
            hypotheticalModel: quotaDecision.hypotheticalModel,
            wouldSwitch: quotaDecision.wouldSwitch,
            switchReason: quotaDecision.switchReason,
            candidateStates: quotaDecision.candidateStates
          }
        };
      } catch (error) {
        return reply.code(400).send(
          openAiError(
            error instanceof Error
              ? error.message
              : "Routing failed",
            "routing_error"
          )
        );
      }
    }
  );

  app.get("/debug/quota", async (request, reply) => {
    const snapshot = await quotaSource.getSnapshot();
    const activeCooldowns = quotaTracker.getActiveCooldowns();

    const candidateStates: Record<string, any> = {};
    for (const profile of shadowProfiles) {
      candidateStates[profile.id] = evaluateCandidateQuota(
        profile,
        snapshot,
        quotaTracker,
        undefined,
        quotaThresholds
      );
    }

    const pools: Record<string, any> = {};
    if (snapshot.accounts) {
      const agProfile = shadowProfiles.find((p) => p.id === "gemini-flash-low");
      if (agProfile && candidateStates[agProfile.id]?.pool) {
        const p = candidateStates[agProfile.id].pool;
        pools["antigravity"] = {
          provider: "antigravity",
          accountsTotal: p.totalAccountCount,
          accountsUsable: p.usableAccountCount,
          poolStatus: p.status,
          bestRemainingRatio: p.bestRemainingRatio,
          accounts: p.accounts?.map((a: any) => ({
            accountAlias: a.accountAlias,
            status: a.status,
            effectiveRemainingRatio: a.effectiveRemainingRatio,
            limitingBuckets: a.limitingBuckets,
            resetAt: a.resetAt,
            providerHealth: a.providerHealth
          }))
        };
      }
      const cxProfile = shadowProfiles.find((p) => p.id === "codex-5.3");
      if (cxProfile && candidateStates[cxProfile.id]?.pool) {
        const p = candidateStates[cxProfile.id].pool;
        pools["codex"] = {
          provider: "codex",
          accountsTotal: p.totalAccountCount,
          accountsUsable: p.usableAccountCount,
          poolStatus: p.status,
          bestRemainingRatio: p.bestRemainingRatio,
          accounts: p.accounts?.map((a: any) => ({
            accountAlias: a.accountAlias,
            status: a.status,
            effectiveRemainingRatio: a.effectiveRemainingRatio,
            limitingBuckets: a.limitingBuckets,
            resetAt: a.resetAt,
            providerHealth: a.providerHealth
          }))
        };
      }
    }

    return {
      policy: quotaPolicy,
      stale: snapshot.stale,
      observedAt: snapshot.observedAt,
      providerHealth: snapshot.providerHealth,
      buckets: snapshot.buckets,
      candidateStates,
      activeCooldowns,
      pools
    };
  });

  app.post<{ Body: ChatCompletionRequest }>(
    "/v1/chat/completions",
    { schema: { body: chatSchema } },
    async (request, reply) => {

      const started = Date.now();

      metrics.requestsTotal += 1;

      let measuredRoute = "unrouted";

      reply.raw.once("finish", () => {

        const latency = Date.now() - started;

        metrics.latencySamples.push(latency);

        if (
          metrics.latencySamples.length >
          MAX_LATENCY_SAMPLES
        ) {
          metrics.latencySamples.shift();
        }

        const status = reply.raw.statusCode;

        metrics.statusCounts[String(status)] =
          (metrics.statusCounts[String(status)] ?? 0) + 1;

        metrics.routeCounts[measuredRoute] =
          (metrics.routeCounts[measuredRoute] ?? 0) + 1;

        if (status < 400) {
          metrics.requestsSuccess += 1;
        } else {
          metrics.requestsError += 1;
        }
      });

      if (
        !config.routing.virtualModels[
          request.body.model
        ]
      ) {
        return reply.code(400).send(
          openAiError(
            `Unknown model '${request.body.model}'.`,
            "invalid_model"
          )
        );
      }

      let decision;

      try {
        decision = await routeRequest(
          request.body,
          config.routing,
          config.classifierModel
            ? upstream
            : undefined
        );
      } catch (error) {
        return reply.code(400).send(
          openAiError(
            error instanceof Error
              ? error.message
              : "Routing failed",
            "routing_error"
          )
        );
      }

      measuredRoute = decision.route;
      let shadowResult: ReturnType<typeof computeShadow> | undefined;
      try {
        shadowResult = computeShadow(request.body, request.headers["x-session-id"]?.toString());
      } catch (error) {
        request.log.warn({ category: "shadow_router_failure", error: error instanceof Error ? error.name : "unknown" }, "shadow routing failed; production route unchanged");
      }

      // Automatic grounded search hanya untuk virtual model "auto".
      //
      // Explicit aliases tetap deterministic:
      // research -> ar-research
      // code     -> ar-code
      // analysis -> ar-analysis
      //
      // Streaming juga tetap menggunakan native Combo.

      if (
        request.body.model === "auto" &&
        decision.route === "web-research" &&
        !request.body.stream
      ) {

        const lastUserMessage =
          [...request.body.messages]
            .reverse()
            .find(
              (message) =>
                message.role === "user"
            );

        const query =
          typeof lastUserMessage?.content === "string"
            ? lastUserMessage.content.trim()
            : "";

        if (query) {

          const provider =
            process.env
              .AUTOROUTER_SEARCH_PROVIDER
              ?.trim()
            || "antigravity";

          try {

            metrics.upstreamAttempts += 1;

            const searchResponse =
              await upstream.search({
                provider,
                query,
                max_results: 5,
                search_type: "web"
              });

            if (searchResponse.ok) {

              const searchPayload: any =
                await searchResponse.json();

              const answerText =
                typeof searchPayload.answer === "string"
                  ? searchPayload.answer
                  : searchPayload.answer?.text;

              if (
                typeof answerText === "string" &&
                answerText.trim()
              ) {

                const sources =
                  Array.isArray(searchPayload.results)
                    ? searchPayload.results
                        .filter(
                          (source: any) =>
                            typeof source?.url === "string"
                        )
                        .slice(0, 5)
                    : [];

                const sourceText =
                  sources.length
                    ? "\n\nSumber:\n" +
                      sources
                        .map(
                          (
                            source: any,
                            index: number
                          ) =>
                            `[${index + 1}] ${
                              source.title ||
                              `Source ${index + 1}`
                            }\n${source.url}`
                        )
                        .join("\n\n")
                    : "";

                const content =
                  answerText.trim() +
                  sourceText;

                reply.header(
                  "x-auto-router-route",
                  decision.route
                );

                reply.header(
                  "x-auto-router-model",
                  decision.upstreamModel
                );

                reply.header(
                  "x-auto-router-grounded",
                  "true"
                );

                reply.header(
                  "x-auto-router-search-provider",
                  searchPayload.provider ||
                  provider
                );

                return reply.send({
                  id:
                    `chatcmpl-search-${Date.now()}`,
                  object: "chat.completion",
                  created:
                    Math.floor(Date.now() / 1000),
                  model:
                    decision.upstreamModel,

                  choices: [{
                    index: 0,
                    message: {
                      role: "assistant",
                      content
                    },
                    finish_reason: "stop"
                  }]
                });
              }
            }

            metrics.fallbackEvents += 1;

          } catch {

            metrics.fallbackEvents += 1;
          }
        }
      }

      let selectedModel = decision.upstreamModel;
      let selectionCandidates = uniqueModels(
        config.routing.routes[
          decision.route
        ]?.selectionPriority ?? [
          decision.upstreamModel,
          config.routing.globalFallbackModel
        ]
      ).filter((model) =>
        supportsRequirements(
          config.routing.modelCapabilities[model]!,
          decision.requirements
        )
      );

      let quotaDecision: QuotaDecisionResult | undefined;
      let quotaSnapshot: any | undefined;
      if (config.routerMode === "v2" && shadowResult) {
        quotaSnapshot = await quotaSource.getSnapshot();
        quotaDecision = resolveQuotaDecision({
          standardSelectedProfile: shadowResult.selectedProfile,
          taskType: shadowResult.taskType,
          specialistIntent: shadowResult.specialistIntent,
          complexity: shadowResult.complexity,
          risk: shadowResult.risk,
          minimumQualityTier: shadowResult.minimumQualityTier,
          requiredCapabilities: shadowResult.requiredCapabilities,
          profiles: shadowProfiles,
          snapshot: quotaSnapshot,
          cooldownTracker: quotaTracker,
          quotaPolicy,
          thresholds: quotaThresholds
        });

        if (quotaPolicy === "auto") {
          if (!quotaDecision.selectedProfile) {
            reply.header("x-auto-router-quota-policy", "auto");
            reply.header("x-auto-router-quota-status", "exhausted");
            reply.header("x-auto-router-quota-effect", "no_eligible_candidate");
            return reply.code(503).send(
              openAiError("No eligible model currently available", "model_unavailable")
            );
          }
          const selectedProfileId = quotaDecision.selectedProfile;
          const profile = shadowProfiles.find((p) => p.id === selectedProfileId);
          if (profile) {
            selectedModel = profile.model;
            const quotaRanked = filterAndRankWithQuota({
              taskType: shadowResult.taskType,
              specialistIntent: shadowResult.specialistIntent,
              complexity: shadowResult.complexity,
              risk: shadowResult.risk,
              minimumQualityTier: shadowResult.minimumQualityTier,
              requiredCapabilities: shadowResult.requiredCapabilities,
              profiles: shadowProfiles,
              snapshot: quotaSnapshot,
              cooldownTracker: quotaTracker,
              policy: "auto",
              thresholds: quotaThresholds
            });
            const altModels = quotaRanked
              .filter((p) => p.id !== profile.id)
              .map((p) => p.model);
            selectionCandidates = uniqueModels([profile.model, ...altModels, config.routing.globalFallbackModel]);
          }
        } else {
          const profile = shadowProfiles.find((p) => p.id === shadowResult.selectedProfile);
          if (profile) {
            selectedModel = profile.model;
            const altModels = shadowResult.alternatives
              .map((altId) => shadowProfiles.find((p) => p.id === altId)?.model)
              .filter((m): m is string => Boolean(m));
            selectionCandidates = uniqueModels([profile.model, ...altModels, config.routing.globalFallbackModel]);
          }
        }
      }

      let forwarded = {
        ...request.body,
        model: selectedModel
      };

      const clientEffort = normalizeReasoningEffort(request.body.reasoning_effort ?? (request.body.reasoning as any)?.effort);
      const reasoningContext: ReasoningContext = {
        taskType: shadowResult?.taskType,
        complexity: shadowResult?.complexity,
        risk: shadowResult?.risk,
        recentFailure: shadowResult && "recentFailure" in shadowResult ? (shadowResult as any).recentFailure : undefined,
        recentTestOutcome: shadowResult && "recentTestOutcome" in shadowResult ? (shadowResult as any).recentTestOutcome : undefined,
        selectedProfile: shadowResult?.selectedProfile
      };
      const autoReasoning = determineAutoReasoning(reasoningContext);
      const effectiveProfileId = (quotaPolicy === "auto" && quotaDecision?.selectedProfile)
        ? quotaDecision.selectedProfile
        : shadowResult?.selectedProfile;

      const matchedProfile = (effectiveProfileId ? shadowProfiles.find((p) => p.id === effectiveProfileId) : undefined) ??
        shadowProfiles.find((p) => p.model === selectedModel) ??
        shadowProfiles[0]!;

      const currentPolicy = config.reasoningPolicy ?? "passthrough";
      const resolvedReasoning = resolveReasoningDecision({
        policy: currentPolicy,
        clientEffort,
        autoDesired: autoReasoning.desired,
        profile: matchedProfile,
        escalationApplied: autoReasoning.escalationApplied,
        deescalationApplied: autoReasoning.deescalationApplied,
        reasons: autoReasoning.reasons
      });

      if (currentPolicy === "auto") {
        forwarded = applyReasoningToPayload(forwarded, resolvedReasoning.effectiveReasoningEffort);
      } else if (currentPolicy === "passthrough") {
        if (clientEffort) {
          forwarded = applyReasoningToPayload(forwarded, resolvedReasoning.effectiveReasoningEffort);
        } else {
          delete (forwarded as Record<string, unknown>).reasoning;
        }
      } else if (currentPolicy === "shadow") {
        if (clientEffort) {
          forwarded = applyReasoningToPayload(forwarded, clientEffort);
        } else {
          delete (forwarded as Record<string, unknown>).reasoning;
        }
      }

      const candidates = selectionCandidates;

      let agenticShadow: ReturnType<typeof computeAgenticShadow> | undefined;
      try {
        agenticShadow = computeAgenticShadow(
          request.body,
          matchedProfile.id,
          selectedModel,
          quotaSnapshot,
          request.headers["x-session-id"]?.toString()
        );
      } catch (err) {
        request.log.warn({ err }, "agentic shadow calculation failed; continuing");
      }

      if (candidates.length === 0) {
        return reply.code(400).send(
          openAiError(
            "No configured model supports the requested capabilities",
            "unsupported_capability"
          )
        );
      }

      const cancellation =
        requestCancellationSignal(
          request.raw,
          reply.raw
        );

      try {

        let response: Response | undefined;

        for (
          let index = 0;
          index < candidates.length;
          index += 1
        ) {

          const model = candidates[index]!;

          metrics.upstreamAttempts += 1;

          try {

            response = await upstream.chat(
              {
                ...forwarded,
                model
              },
              cancellation.signal
            );

          } catch (error) {

            if (
              index ===
              candidates.length - 1
            ) {
              throw error;
            }

            metrics.fallbackEvents += 1;

            request.log.warn(
              {
                err:
                  error instanceof Error
                    ? error.name
                    : "unknown",
                route: decision.route,
                fallbackModel:
                  candidates[index + 1]
              },
              "upstream unavailable; trying configured fallback"
            );

            continue;
          }

          if (response.status === 429 || response.status === 403) {
            const errClone = response.clone();
            const text = await errClone.text().catch(() => "");
            const headerObj: Record<string, string> = {};
            response.headers.forEach((v, k) => {
              headerObj[k.toLowerCase()] = v;
            });
            quotaTracker.recordResponse(model, response.status, text, headerObj);
          }

          if (
            !await shouldFallback(
              response,
              config.routing
            ) ||
            index ===
              candidates.length - 1
          ) {
            break;
          }

          metrics.fallbackEvents += 1;

          request.log.warn(
            {
              route: decision.route,
              statusCode: response.status,
              fallbackModel:
                candidates[index + 1]
            },
            "trying configured fallback model"
          );
        }

        if (!response) {
          throw new Error(
            "No upstream response"
          );
        }

        if (quotaDecision) {
          reply.header("x-auto-router-quota-policy", quotaDecision.policy);
          reply.header("x-auto-router-quota-status", quotaDecision.status);
          reply.header("x-auto-router-quota-remaining", quotaDecision.effectiveRemainingRatio.toFixed(4));
          reply.header("x-auto-router-quota-limiting-bucket", quotaDecision.limitingBuckets.join(","));
          reply.header("x-auto-router-quota-effect", quotaDecision.selectionEffect);
        } else {
          reply.header("x-auto-router-quota-policy", quotaPolicy);
        }

        if (!response.ok) {
          return reply
            .code(
              publicUpstreamStatus(
                response.status
              )
            )
            .send(
              sanitizedUpstreamError(
                response.status
              )
            );
        }

        reply.header(
          "x-auto-router-route",
          decision.route
        );

        reply.header(
          "x-auto-router-model",
          selectedModel
        );

        reply.header(
          "x-auto-router-mode",
          config.routerMode
        );

        reply.header(
          "x-auto-router-reasoning-policy",
          resolvedReasoning.policy
        );
        reply.header(
          "x-auto-router-reasoning-desired",
          resolvedReasoning.desiredReasoningEffort
        );
        reply.header(
          "x-auto-router-reasoning-effective",
          resolvedReasoning.effectiveReasoningEffort
        );
        reply.header(
          "x-auto-router-reasoning-clamped",
          String(resolvedReasoning.clamped)
        );

        if (agenticShadow) {
          reply.header("x-auto-router-shadow-agentic-eligible", agenticShadow.shadowAgenticEligible ? "true" : "false");
          reply.header("x-auto-router-shadow-agentic-profile", agenticShadow.shadowAgenticProfile);
          reply.header("x-auto-router-shadow-agentic-model", agenticShadow.shadowAgenticModel);
          reply.header("x-auto-router-shadow-agentic-reason", agenticShadow.shadowAgenticReason);
        }

        if (config.routerMode === "v2" && shadowResult) {
          const effectiveProfile = (quotaPolicy === "auto" && quotaDecision?.selectedProfile)
            ? quotaDecision.selectedProfile
            : shadowResult.selectedProfile;
          reply.header(
            "x-auto-router-profile",
            effectiveProfile
          );
          reply.header(
            "x-auto-router-tier",
            shadowResult.minimumQualityTier
          );
          reply.header(
            "x-auto-router-switch-reason",
            quotaDecision?.wouldSwitch && quotaPolicy === "auto" ? quotaDecision.switchReason : shadowResult.switchReason
          );
        }

        const contentType =
          response.headers.get(
            "content-type"
          ) ??
          (
            request.body.stream
              ? "text/event-stream"
              : "application/json"
          );

        reply.type(contentType);

        if (
          request.body.stream &&
          response.body
        ) {

          reply.header(
            "cache-control",
            "no-cache"
          );

          reply.header(
            "connection",
            "keep-alive"
          );

          const lifecycle = new StreamLifecycleTracker((state) => {
            metrics.streamLifecycle[state] = (metrics.streamLifecycle[state] ?? 0) + 1;
          });
          const timedBody = withStreamTimeouts(
            response.body as unknown as ReadableStream<Uint8Array>,
            timeoutConfig,
            lifecycle
          );
          request.log.info(
            { lifecycle: lifecycle.snapshot().state, route: decision.route },
            "upstream stream started"
          );
          return reply.send(Readable.fromWeb(
            timedBody as unknown as import("node:stream/web").ReadableStream
          ));
        }

        const body =
          await response.arrayBuffer();

        return reply.send(
          Buffer.from(body)
        );

      } catch (error) {

        request.log.warn(
          {
            category:
                          classifyUpstreamError(error),
            route: decision.route
          },
          "upstream request failed"
        );

        return reply.code(502).send(
          openAiError(
            "Upstream service is unavailable",
            "upstream_unavailable"
          )
        );

      } finally {
        cancellation.cleanup();
      }
    }
  );



  // ----------------------------------------------------------
  // NATIVE WEB SEARCH
  //
  // AutoRouter exposes one stable endpoint.
  // Search execution itself is handled by 9Router.
  // ----------------------------------------------------------

  app.post<{
    Body: {
      query?: string;
      max_results?: number;
      search_type?: string;
      country?: string;
      language?: string;
      time_range?: string;
      domain_filter?: unknown;
      content_options?: unknown;
      provider_options?: unknown;
    };
  }>(
    "/v1/search",
    async (request, reply) => {

      const query = request.body?.query;

      if (
        typeof query !== "string" ||
        !query.trim()
      ) {
        return reply.code(400).send(
          openAiError(
            "A non-empty search query is required.",
            "invalid_search_query"
          )
        );
      }

      const provider =
        process.env.AUTOROUTER_SEARCH_PROVIDER?.trim()
        || "antigravity";

      metrics.requestsTotal += 1;
      metrics.upstreamAttempts += 1;

      const started = Date.now();

      try {

        const response =
          await upstream.search({
            provider,
            query: query.trim(),
            max_results:
              request.body.max_results ?? 5,
            search_type:
              request.body.search_type ?? "web",
            country:
              request.body.country,
            language:
              request.body.language,
            time_range:
              request.body.time_range,
            domain_filter:
              request.body.domain_filter,
            content_options:
              request.body.content_options,
            provider_options:
              request.body.provider_options
          });

        const latency =
          Date.now() - started;

        metrics.latencySamples.push(latency);

        if (
          metrics.latencySamples.length >
          MAX_LATENCY_SAMPLES
        ) {
          metrics.latencySamples.shift();
        }

        metrics.routeCounts["web-research"] =
          (metrics.routeCounts["web-research"] ?? 0) + 1;

        metrics.statusCounts[String(response.status)] =
          (metrics.statusCounts[String(response.status)] ?? 0) + 1;

        if (!response.ok) {

          metrics.requestsError += 1;

          return reply
            .code(
              publicUpstreamStatus(
                response.status
              )
            )
            .send(
              sanitizedUpstreamError(
                response.status
              )
            );
        }

        metrics.requestsSuccess += 1;

        reply.header(
          "x-auto-router-route",
          "web-research"
        );

        reply.header(
          "x-auto-router-search-provider",
          provider
        );

        const result =
          await response.arrayBuffer();

        reply.type(
          response.headers.get(
            "content-type"
          ) ?? "application/json"
        );

        return reply.send(
          Buffer.from(result)
        );

      } catch {

        metrics.requestsError += 1;

        return reply.code(502).send(
          openAiError(
            "Search service is unavailable",
            "search_unavailable"
          )
        );
      }
    }
  );
  app.post<{ Body: ResponsesRequest }>(
    "/v1/responses",
    async (request, reply) => {

      const started = Date.now();

      metrics.requestsTotal += 1;

      let measuredRoute = "unrouted";

      reply.raw.once("finish", () => {

        const latency = Date.now() - started;

        metrics.latencySamples.push(latency);

        if (
          metrics.latencySamples.length >
          MAX_LATENCY_SAMPLES
        ) {
          metrics.latencySamples.shift();
        }

        const status = reply.raw.statusCode;

        metrics.statusCounts[String(status)] =
          (metrics.statusCounts[String(status)] ?? 0) + 1;

        metrics.routeCounts[measuredRoute] =
          (metrics.routeCounts[measuredRoute] ?? 0) + 1;

        if (status < 400) {
          metrics.requestsSuccess += 1;
        } else {
          metrics.requestsError += 1;
        }
      });

      const body = request.body;

      if (
        !body ||
        typeof body.model !== "string" ||
        !body.model.trim()
      ) {
        return reply.code(400).send(
          openAiError(
            "A valid model is required.",
            "invalid_model"
          )
        );
      }

      if (!config.routing.virtualModels[body.model]) {

        return reply.code(400).send(
          openAiError(
            `Unknown model '${body.model}'.`,
            "invalid_model"
          )
        );
      }

      const routingRequest =
        responsesToRoutingRequest(body);

      let decision;

      try {

        decision = await routeRequest(
          routingRequest,
          config.routing,
          config.classifierModel
            ? upstream
            : undefined
        );

      } catch (error) {

        return reply.code(400).send(
          openAiError(
            error instanceof Error
              ? error.message
              : "Routing failed",
            "routing_error"
          )
        );
      }

      measuredRoute = decision.route;
      let shadowResult: ReturnType<typeof computeShadow> | undefined;
      try {
        shadowResult = computeShadow(routingRequest, request.headers["x-session-id"]?.toString());
      } catch (error) {
        request.log.warn({ category: "shadow_router_failure", error: error instanceof Error ? error.name : "unknown" }, "shadow routing failed; production route unchanged");
      }

      const clientEffort = normalizeReasoningEffort(body.reasoning_effort ?? (body.reasoning as any)?.effort);
      const reasoningContext: ReasoningContext = {
        taskType: shadowResult?.taskType,
        complexity: shadowResult?.complexity,
        risk: shadowResult?.risk,
        selectedProfile: shadowResult?.selectedProfile
      };
      const autoReasoning = determineAutoReasoning(reasoningContext);
      const matchedProfile = (shadowResult ? shadowProfiles.find((p) => p.id === shadowResult.selectedProfile) : undefined) ??
        shadowProfiles.find((p) => p.model === decision.upstreamModel) ??
        shadowProfiles[0]!;

      const currentPolicy = config.reasoningPolicy ?? "passthrough";
      const resolvedReasoning = resolveReasoningDecision({
        policy: currentPolicy,
        clientEffort,
        autoDesired: autoReasoning.desired,
        profile: matchedProfile,
        escalationApplied: autoReasoning.escalationApplied,
        deescalationApplied: autoReasoning.deescalationApplied,
        reasons: autoReasoning.reasons
      });

      let forwardedBody: Record<string, unknown> = {
        ...body
      };
      if (currentPolicy === "auto") {
        forwardedBody = applyReasoningToPayload(forwardedBody, resolvedReasoning.effectiveReasoningEffort);
      } else if (currentPolicy === "passthrough") {
        if (clientEffort) {
          forwardedBody = applyReasoningToPayload(forwardedBody, resolvedReasoning.effectiveReasoningEffort);
        } else {
          delete forwardedBody.reasoning;
        }
      } else if (currentPolicy === "shadow") {
        if (clientEffort) {
          forwardedBody = applyReasoningToPayload(forwardedBody, clientEffort);
        } else {
          delete forwardedBody.reasoning;
        }
      }

      let selectedModel = decision.upstreamModel;
      let selectionCandidates = uniqueModels(
        config.routing.routes[
          decision.route
        ]?.selectionPriority ?? [
          decision.upstreamModel,
          config.routing.globalFallbackModel
        ]
      ).filter((model) =>
        supportsRequirements(
          config.routing.modelCapabilities[model]!,
          decision.requirements
        )
      );

      let quotaDecision: QuotaDecisionResult | undefined;
      let quotaSnapshot: any | undefined;
      if (config.routerMode === "v2" && shadowResult) {
        quotaSnapshot = await quotaSource.getSnapshot();
        quotaDecision = resolveQuotaDecision({
          standardSelectedProfile: shadowResult.selectedProfile,
          taskType: shadowResult.taskType,
          specialistIntent: shadowResult.specialistIntent,
          complexity: shadowResult.complexity,
          risk: shadowResult.risk,
          minimumQualityTier: shadowResult.minimumQualityTier,
          requiredCapabilities: shadowResult.requiredCapabilities,
          profiles: shadowProfiles,
          snapshot: quotaSnapshot,
          cooldownTracker: quotaTracker,
          quotaPolicy,
          thresholds: quotaThresholds
        });

        if (quotaPolicy === "auto") {
          if (!quotaDecision.selectedProfile) {
            reply.header("x-auto-router-quota-policy", "auto");
            reply.header("x-auto-router-quota-status", "exhausted");
            reply.header("x-auto-router-quota-effect", "no_eligible_candidate");
            return reply.code(503).send(
              openAiError("No eligible model currently available", "model_unavailable")
            );
          }
          const selectedProfileId = quotaDecision.selectedProfile;
          const profile = shadowProfiles.find((p) => p.id === selectedProfileId);
          if (profile) {
            selectedModel = profile.model;
            const quotaRanked = filterAndRankWithQuota({
              taskType: shadowResult.taskType,
              specialistIntent: shadowResult.specialistIntent,
              complexity: shadowResult.complexity,
              risk: shadowResult.risk,
              minimumQualityTier: shadowResult.minimumQualityTier,
              requiredCapabilities: shadowResult.requiredCapabilities,
              profiles: shadowProfiles,
              snapshot: quotaSnapshot,
              cooldownTracker: quotaTracker,
              policy: "auto",
              thresholds: quotaThresholds
            });
            const altModels = quotaRanked
              .filter((p) => p.id !== profile.id)
              .map((p) => p.model);
            selectionCandidates = uniqueModels([profile.model, ...altModels, config.routing.globalFallbackModel]);
          }
        } else {
          const profile = shadowProfiles.find((p) => p.id === shadowResult.selectedProfile);
          if (profile) {
            selectedModel = profile.model;
            const altModels = shadowResult.alternatives
              .map((altId) => shadowProfiles.find((p) => p.id === altId)?.model)
              .filter((m): m is string => Boolean(m));
            selectionCandidates = uniqueModels([profile.model, ...altModels, config.routing.globalFallbackModel]);
          }
        }
      }

      const candidates = selectionCandidates;

      if (candidates.length === 0) {

        return reply.code(400).send(
          openAiError(
            "No configured model supports the requested capabilities",
            "unsupported_capability"
          )
        );
      }

      const cancellation =
        requestCancellationSignal(
          request.raw,
          reply.raw
        );

      try {

        let response: Response | undefined;

        for (
          let index = 0;
          index < candidates.length;
          index += 1
        ) {

          const model = candidates[index]!;

          metrics.upstreamAttempts += 1;

          try {

            response = await upstream.responses(
              {
                ...forwardedBody,
                model
              },
              cancellation.signal
            );

          } catch (error) {

            if (
              index ===
              candidates.length - 1
            ) {
              throw error;
            }

            metrics.fallbackEvents += 1;
            continue;
          }

          if (response.status === 429 || response.status === 403) {
            const errClone = response.clone();
            const text = await errClone.text().catch(() => "");
            const headerObj: Record<string, string> = {};
            response.headers.forEach((v, k) => {
              headerObj[k.toLowerCase()] = v;
            });
            quotaTracker.recordResponse(model, response.status, text, headerObj);
          }

          if (
            !await shouldFallback(
              response,
              config.routing
            ) ||
            index ===
              candidates.length - 1
          ) {
            break;
          }

          metrics.fallbackEvents += 1;
        }

        if (!response) {
          throw new Error(
            "No upstream response"
          );
        }

        if (quotaDecision) {
          reply.header("x-auto-router-quota-policy", quotaDecision.policy);
          reply.header("x-auto-router-quota-status", quotaDecision.status);
          reply.header("x-auto-router-quota-remaining", quotaDecision.effectiveRemainingRatio.toFixed(4));
          reply.header("x-auto-router-quota-limiting-bucket", quotaDecision.limitingBuckets.join(","));
          reply.header("x-auto-router-quota-effect", quotaDecision.selectionEffect);
        } else {
          reply.header("x-auto-router-quota-policy", quotaPolicy);
        }

        if (config.routerMode === "v2" && shadowResult) {
          const effectiveProfile = (quotaPolicy === "auto" && quotaDecision?.selectedProfile)
            ? quotaDecision.selectedProfile
            : shadowResult.selectedProfile;
          reply.header(
            "x-auto-router-profile",
            effectiveProfile
          );
          reply.header(
            "x-auto-router-tier",
            shadowResult.minimumQualityTier
          );
          reply.header(
            "x-auto-router-switch-reason",
            quotaDecision?.wouldSwitch && quotaPolicy === "auto" ? quotaDecision.switchReason : shadowResult.switchReason
          );
        }

        if (!response.ok) {
          return reply
            .code(
              publicUpstreamStatus(
                response.status
              )
            )
            .send(
              sanitizedUpstreamError(
                response.status
              )
            );
        }

        reply.header(
          "x-auto-router-route",
          decision.route
        );

        reply.header(
          "x-auto-router-model",
          selectedModel
        );

        reply.header(
          "x-auto-router-reasoning-policy",
          resolvedReasoning.policy
        );
        reply.header(
          "x-auto-router-reasoning-desired",
          resolvedReasoning.desiredReasoningEffort
        );
        reply.header(
          "x-auto-router-reasoning-effective",
          resolvedReasoning.effectiveReasoningEffort
        );
        reply.header(
          "x-auto-router-reasoning-clamped",
          String(resolvedReasoning.clamped)
        );

        const contentType =
          response.headers.get("content-type") ??
          (
            body.stream
              ? "text/event-stream"
              : "application/json"
          );

        reply.type(contentType);

        if (
          body.stream &&
          response.body
        ) {

          reply.header(
            "cache-control",
            "no-cache"
          );

          reply.header(
            "connection",
            "keep-alive"
          );

          const lifecycle = new StreamLifecycleTracker((state) => {
            metrics.streamLifecycle[state] = (metrics.streamLifecycle[state] ?? 0) + 1;
          });
          const timedBody = withStreamTimeouts(
            response.body as unknown as ReadableStream<Uint8Array>,
            timeoutConfig,
            lifecycle
          );
          request.log.info(
            { lifecycle: lifecycle.snapshot().state, route: decision.route },
            "upstream responses stream started"
          );
          return reply.send(Readable.fromWeb(
            timedBody as unknown as import("node:stream/web").ReadableStream
          ));
        }

        const result =
          await response.arrayBuffer();

        return reply.send(
          Buffer.from(result)
        );

      } catch (error) {

        request.log.warn(
          {
            category:
                          classifyUpstreamError(error),
            route: decision.route
          },
          "Responses API upstream request failed"
        );

        return reply.code(502).send(
          openAiError(
            "Upstream service is unavailable",
            "upstream_unavailable"
          )
        );

      } finally {
        cancellation.cleanup();
      }
    }
  );
  app.setErrorHandler(
    (
      error: FastifyError,
      request,
      reply
    ) => {

      request.log.info(
        {
          statusCode: error.statusCode,
          validation:
            Boolean(error.validation)
        },
        "request rejected"
      );

      reply
        .code(
          error.statusCode &&
          error.statusCode < 500
            ? error.statusCode
            : 500
        )
        .send(
          openAiError(
            error.validation
              ? "Invalid request body"
              : "Internal server error",
            error.validation
              ? "invalid_request"
              : "internal_error"
          )
        );
    }
  );

  return app;
}


interface ResponsesRequest {
  model: string;
  input?: unknown;
  instructions?: string;
  stream?: boolean;
  tools?: unknown[];
  [key: string]: unknown;
}

function responsesToRoutingRequest(
  body: ResponsesRequest
): ChatCompletionRequest {

  const messages: ChatMessage[] = [];

  if (typeof body.input === "string") {

    messages.push({
      role: "user",
      content: body.input
    });

  } else if (Array.isArray(body.input)) {

    for (const item of body.input) {

      if (!item || typeof item !== "object") {
        continue;
      }

      const value = item as Record<string, unknown>;

      if (value.type === "message") {

        const role =
          typeof value.role === "string"
            ? value.role
            : "user";

        const content = value.content;

        if (typeof content === "string") {

          messages.push({
            role,
            content
          });

        } else if (Array.isArray(content)) {

          const converted = content.map((part) => {

            if (!part || typeof part !== "object") {
              return part;
            }

            const p = part as Record<string, unknown>;

            if (
              p.type === "input_text" &&
              typeof p.text === "string"
            ) {
              return {
                type: "text",
                text: p.text
              };
            }

            return p;
          });

          messages.push({
            role,
            content: converted
          });
        }

        continue;
      }

      if (
        value.type === "input_text" &&
        typeof value.text === "string"
      ) {

        messages.push({
          role: "user",
          content: value.text
        });

        continue;
      }

      if (value.type === "input_image") {

        messages.push({
          role: "user",
          content: [value]
        });
      }
    }
  }

  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: ""
    });
  }

  return {
    model: body.model,
    messages,
    stream: body.stream,
    tools: body.tools
  };
}
function uniqueModels(
  models: string[]
): string[] {
  return [...new Set(models)];
}

function requestCancellationSignal(
  request:
    import("node:http").IncomingMessage,
  reply:
    import("node:http").ServerResponse
) {

  const controller =
    new AbortController();

  const abort = () =>
    controller.abort();

  const close = () => {
    if (!reply.writableEnded) {
      abort();
    }
  };

  request.once("aborted", abort);
  reply.once("close", close);

  return {
    signal: controller.signal,
    cleanup: () => {
      request.off("aborted", abort);
      reply.off("close", close);
    }
  };
}

function publicUpstreamStatus(
  status: number
): number {

  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 422 ||
    status === 429
  ) {
    return status;
  }

  return 502;
}

async function shouldFallback(
  response: Response,
  routing: AppConfig["routing"]
): Promise<boolean> {

  if (response.status === 400) {
    return false;
  }

  const statuses = new Set(
    routing.fallbackPolicy?.statuses ??
      [429, 502, 503, 504]
  );

  if (statuses.has(response.status)) {
    return true;
  }

  if (response.ok) {
    return false;
  }

  try {

    const body =
      await response.clone().json() as {
        error?: {
          code?: unknown;
          type?: unknown;
        };
      };

    const values = [
      body.error?.code,
      body.error?.type
    ].filter(
      (value): value is string =>
        typeof value === "string"
    );

    const codes = new Set(
      routing
        .fallbackPolicy
        ?.availabilityErrorCodes ??
      []
    );

    return values.some(
      (value) =>
        codes.has(
          value.toLowerCase()
        )
    );

  } catch {
    return false;
  }
}

function openAiError(
  message: string,
  code: string
) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param: null,
      code
    }
  };
}

export function debugBody(
  text: string
): ChatCompletionRequest {

  return {
    model: "auto",
    messages: [
      {
        role: "user",
        content: text
      } as ChatMessage
    ]
  };
}



