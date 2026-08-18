import { Readable } from "node:stream";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { routeRequest, supportsRequirements } from "./router.js";
import type { ChatCompletionRequest, ChatMessage } from "./types.js";
import { sanitizedUpstreamError, UpstreamClient } from "./upstream.js";

const chatSchema = {
  type: "object", required: ["model", "messages"], additionalProperties: true,
  properties: {
    model: { type: "string", minLength: 1, maxLength: 200 },
    messages: { type: "array", minItems: 1, maxItems: 1000, items: { type: "object", required: ["role"], additionalProperties: true, properties: { role: { type: "string", minLength: 1 }, content: {} } } },
    stream: { type: "boolean" }, tools: { type: "array", maxItems: 128 }, functions: { type: "array", maxItems: 128 }
  }
} as const;

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel, redact: ["req.headers.authorization", "headers.authorization", "body.messages", "body.tools", "body.functions"] }, bodyLimit: 10 * 1024 * 1024 });
  const upstream = new UpstreamClient(config.upstreamBaseUrl, config.upstreamApiKey, config.upstreamTimeoutMs, config.classifierModel, config.classifierTimeoutMs);

  app.get("/health", async () => ({ status: "ok", service: "auto-router" }));
  app.get("/v1/models", async () => ({ object: "list", data: Object.keys(config.routing.virtualModels).map((id) => ({ id, object: "model", created: 0, owned_by: "auto-router" })) }));

  app.post<{ Body: ChatCompletionRequest }>("/debug/route", { schema: { body: chatSchema } }, async (request, reply) => {
    if (!config.routing.virtualModels[request.body.model]) return reply.code(400).send(openAiError(`Unknown model '${request.body.model}'.`, "invalid_model"));
    try { return await routeRequest(request.body, config.routing, config.classifierModel ? upstream : undefined); }
    catch (error) { return reply.code(400).send(openAiError(error instanceof Error ? error.message : "Routing failed", "routing_error")); }
  });

  app.post<{ Body: ChatCompletionRequest }>("/v1/chat/completions", { schema: { body: chatSchema } }, async (request, reply) => {
    if (!config.routing.virtualModels[request.body.model]) return reply.code(400).send(openAiError(`Unknown model '${request.body.model}'.`, "invalid_model"));
    let decision;
    try { decision = await routeRequest(request.body, config.routing, config.classifierModel ? upstream : undefined); }
    catch (error) { return reply.code(400).send(openAiError(error instanceof Error ? error.message : "Routing failed", "routing_error")); }
    const forwarded = { ...request.body, model: decision.upstreamModel };
    const candidates = uniqueModels(config.routing.routes[decision.route]?.selectionPriority ?? [decision.upstreamModel, config.routing.globalFallbackModel])
      .filter((model) => supportsRequirements(config.routing.modelCapabilities[model]!, decision.requirements));
    if (candidates.length === 0) return reply.code(400).send(openAiError("No configured model supports the requested capabilities", "unsupported_capability"));
    const cancellation = requestCancellationSignal(request.raw, reply.raw);
    try {
      let response: Response | undefined;
      for (let index = 0; index < candidates.length; index += 1) {
        const model = candidates[index]!;
        try {
          response = await upstream.chat({ ...forwarded, model }, cancellation.signal);
        } catch (error) {
          if (index === candidates.length - 1) throw error;
          request.log.warn({ err: error instanceof Error ? error.name : "unknown", route: decision.route, fallbackModel: candidates[index + 1] }, "upstream unavailable; trying configured fallback");
          continue;
        }
        if (!await shouldFallback(response, config.routing) || index === candidates.length - 1) break;
        request.log.warn({ route: decision.route, statusCode: response.status, fallbackModel: candidates[index + 1] }, "trying configured fallback model");
      }
      if (!response) throw new Error("No upstream response");
      if (!response.ok) return reply.code(publicUpstreamStatus(response.status)).send(sanitizedUpstreamError(response.status));
      reply.header("x-auto-router-route", decision.route);
      const contentType = response.headers.get("content-type") ?? (request.body.stream ? "text/event-stream" : "application/json");
      reply.type(contentType);
      if (request.body.stream && response.body) {
        reply.header("cache-control", "no-cache");
        reply.header("connection", "keep-alive");
        return reply.send(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream));
      }
      const body = await response.arrayBuffer();
      return reply.send(Buffer.from(body));
    } catch (error) {
      request.log.warn({ category: upstreamErrorCategory(error), route: decision.route }, "upstream request failed");
      return reply.code(502).send(openAiError("Upstream service is unavailable", "upstream_unavailable"));
    } finally {
      cancellation.cleanup();
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.info({ statusCode: error.statusCode, validation: Boolean(error.validation) }, "request rejected");
    reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send(openAiError(error.validation ? "Invalid request body" : "Internal server error", error.validation ? "invalid_request" : "internal_error"));
  });
  return app;
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models)];
}

function requestCancellationSignal(request: import("node:http").IncomingMessage, reply: import("node:http").ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => { if (!reply.writableEnded) abort(); };
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

function publicUpstreamStatus(status: number): number {
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422 || status === 429) return status;
  return 502;
}

function upstreamErrorCategory(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "connection_failure";
}

async function shouldFallback(response: Response, routing: AppConfig["routing"]): Promise<boolean> {
  if (response.status === 400) return false;
  const statuses = new Set(routing.fallbackPolicy?.statuses ?? [429, 502, 503, 504]);
  if (statuses.has(response.status)) return true;
  if (response.ok) return false;
  try {
    const body = await response.clone().json() as { error?: { code?: unknown; type?: unknown } };
    const values = [body.error?.code, body.error?.type].filter((value): value is string => typeof value === "string");
    const codes = new Set(routing.fallbackPolicy?.availabilityErrorCodes ?? []);
    return values.some((value) => codes.has(value.toLowerCase()));
  } catch {
    return false;
  }
}

function openAiError(message: string, code: string) { return { error: { message, type: "invalid_request_error", param: null, code } }; }

export function debugBody(text: string): ChatCompletionRequest { return { model: "auto", messages: [{ role: "user", content: text } as ChatMessage] }; }
