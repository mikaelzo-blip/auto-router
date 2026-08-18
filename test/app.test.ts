import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { RoutingConfig } from "../src/types.js";

const routing = JSON.parse(await readFile(resolve("config/routes.json"), "utf8")) as RoutingConfig;
const config: AppConfig = { host: "127.0.0.1", port: 20200, upstreamBaseUrl: "http://127.0.0.1:20128/v1", classifierTimeoutMs: 100, upstreamTimeoutMs: 100, logLevel: "silent", routing };
const app = buildApp(config);
afterAll(() => app.close());
afterEach(() => vi.restoreAllMocks());

describe("API", () => {
  it("serves health", async () => expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok" }));
  it("lists all client-facing virtual models", async () => {
    const models = (await app.inject({ method: "GET", url: "/v1/models" })).json().data.map((model: { id: string }) => model.id);
    expect(models).toEqual(["auto", "code", "analysis", "fast", "explore", "research"]);
  });
  it("debugs a route", async () => expect((await app.inject({ method: "POST", url: "/debug/route", payload: { model: "auto", messages: [{ role: "user", content: "fix this TypeScript error" }] } })).json().route).toBe("smart-code"));

  it.each([
    ["auto", "smart-code", "cx/gpt-5.6-sol", false],
    ["code", "smart-code", "cx/gpt-5.6-sol", true],
    ["analysis", "smart-analysis", "cx/gpt-5.6-sol", true],
    ["fast", "fast-chat", "cx/gpt-5.6-luna", true],
    ["explore", "explore", "ag/gemini-3.6-flash-high", true],
    ["research", "web-research", "ag/gemini-3.6-flash-high", true]
  ])("reports debug details for virtual model %s", async (model, route, upstreamModel, bypassed) => {
    const response = await app.inject({ method: "POST", url: "/debug/route", payload: { model, messages: [{ role: "user", content: "fix this TypeScript error" }] } });
    expect(response.json()).toMatchObject({ requestedVirtualModel: model, route, upstreamModel, semanticClassificationBypassed: bypassed });
  });

  it.each([
    ["code", "smart-code", "cx/gpt-5.6-sol"],
    ["analysis", "smart-analysis", "cx/gpt-5.6-sol"],
    ["fast", "fast-chat", "cx/gpt-5.6-luna"],
    ["explore", "explore", "ag/gemini-3.6-flash-high"],
    ["research", "web-research", "ag/gemini-3.6-flash-high"]
  ])("forwards alias %s through %s to %s", async (model, route, upstreamModel) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const messages = [{ role: "user", content: "hello" }];
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model, messages, stream: false } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-auto-router-route"]).toBe(route);
    const forwarded = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(forwarded).toMatchObject({ model: upstreamModel, messages, stream: false });
  });
  it("rejects malformed bodies without echoing prompts", async () => {
    const response = await app.inject({ method: "POST", url: "/debug/route", payload: { model: "auto" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("Invalid request body");
  });

  it.each([429, 502, 503, 504])("uses the configured fallback chain after upstream status %i", async (status) => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "unavailable" } }), { status, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "unavailable" } }), { status, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }));

    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "auto", messages: [{ role: "user", content: "fix this TypeScript error" }] } });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).model).toBe("cx/gpt-5.6-sol");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)).model).toBe("cx/gpt-5.5");
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body)).model).toBe("free-coding");
  });

  it("filters capability-incompatible models from fallback chains", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: {} }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "fast", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] } });
    expect(response.statusCode).toBe(200);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]!.body)).model)).toEqual(["gemini/gemini-3.7-flash", "ag/gemini-3.6-flash-high"]);
  });

  it("does not use fallback for other upstream errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, headers: { "content-type": "application/json" } }));
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "auto", messages: [{ role: "user", content: "hello" }] } });
    expect(response.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses fallback for a structured model availability error", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "model_unavailable" } }), { status: 404, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "auto", messages: [{ role: "user", content: "fix this TypeScript error" }] } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)).model).toBe("cx/gpt-5.5");
  });

  it("never retries an HTTP 400 even when its code says unavailable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "model_unavailable" } }), { status: 400, headers: { "content-type": "application/json" } }));
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "auto", messages: [{ role: "user", content: "hello" }] } });
    expect(response.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not expose provider errors, credentials, URLs, headers, or provider status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "401 from http://internal:9000 Authorization: Bearer sk-secret provider_status=down" } }), { status: 400, headers: { "x-provider": "secret" } }));
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "auto", messages: [{ role: "user", content: "hello" }] } });
    const serialized = response.body;
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual({ message: "The upstream service rejected the request", type: "upstream_error", code: "upstream_rejected" });
    expect(serialized).not.toMatch(/internal|secret|authorization|provider_status|upstream_400/i);
  });

  it("propagates client disconnect cancellation to upstream", async () => {
    const cancellation = new Promise<AbortSignal>((resolveCancellation) => {
      vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        resolveCancellation(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } });
    client.on("error", () => undefined);
    client.end(JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hello" }] }));
    const signal = await cancellation;
    client.destroy();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("rejects client validation errors without calling upstream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "auto" } });
    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
