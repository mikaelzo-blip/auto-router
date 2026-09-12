import { Readable } from "node:stream";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { routeRequest, supportsRequirements } from "./router.js";
import { createSessionStore, routeShadow, type ShadowRequest } from "./shadow-router.js";
import { DEFAULT_SHADOW_PROFILES } from "./shadow-profiles.js";
import type { ChatCompletionRequest, ChatMessage } from "./types.js";
import { sanitizedUpstreamError, UpstreamClient } from "./upstream.js";
import { StreamLifecycleTracker, classifyUpstreamError, withStreamTimeouts } from "./reliability.js";

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
        return {
          ...actual,
          actual: { route: actual.route, upstreamModel: actual.upstreamModel },
          shadowV2
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
      try {
        computeShadow(request.body, request.headers["x-session-id"]?.toString());
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

      const forwarded = {
        ...request.body,
        model: decision.upstreamModel
      };

      const candidates = uniqueModels(
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
      try {
        computeShadow(routingRequest, request.headers["x-session-id"]?.toString());
      } catch (error) {
        request.log.warn({ category: "shadow_router_failure", error: error instanceof Error ? error.name : "unknown" }, "shadow routing failed; production route unchanged");
      }

      const candidates = uniqueModels(
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
                ...body,
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
          decision.upstreamModel
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



