import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { RoutingConfig } from "../src/types.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";
import { SyntheticQuotaSource } from "../src/quota/source.js";

const routing = JSON.parse(
  await readFile(resolve("config/routes.json"), "utf8")
) as RoutingConfig;

function makeConfig(routerMode: "legacy" | "v2"): AppConfig {
  return {
    host: "127.0.0.1",
    port: 20207,
    upstreamBaseUrl: "http://127.0.0.1:20128/v1",
    classifierTimeoutMs: 100,
    upstreamTimeoutMs: 1000,
    logLevel: "silent",
    routerMode,
    reasoningPolicy: "auto",
    quotaPolicy: "off",
    sonnetAgenticEnabled: false,
    routing,
    quotaSource: new SyntheticQuotaSource()
  };
}

const agenticPrompt =
  "Implement this approved architecture across API, database and tests, then verify all tests pass.";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("V2 direct execution model contract", () => {
  it("reuses the configured upstream API key for the default quota source without exposing it", async () => {
    const upstreamApiKey = "configured-upstream-test-secret";
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== `Bearer ${upstreamApiKey}`) {
        return Promise.resolve(new Response("Unauthorized", { status: 401 }));
      }
      if (String(url).endsWith("/api/providers")) {
        return Promise.resolve(new Response(JSON.stringify({
          connections: [{ id: "conn-ag-1", provider: "antigravity", isActive: true }]
        }), { status: 200 }));
      }
      if (String(url).endsWith("/api/usage/conn-ag-1")) {
        return Promise.resolve(new Response(JSON.stringify({
          quotas: { "gemini-3.8-flash-low": { remainingPercentage: 80 } }
        }), { status: 200 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });
    const config = makeConfig("v2");
    config.upstreamApiKey = upstreamApiKey;
    delete config.quotaSource;
    const app = buildApp(config);

    const response = await app.inject({ method: "GET", url: "/debug/quota" });

    expect(response.statusCode).toBe(200);
    expect(response.json().providerHealth.antigravity).toBe("healthy");
    expect(response.body).not.toContain(upstreamApiKey);

    await app.close();
  });

  it("reports the concrete V2 model as upstreamModel while preserving legacy route metadata", async () => {
    const app = buildApp(makeConfig("v2"));

    const response = await app.inject({
      method: "POST",
      url: "/debug/route",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: agenticPrompt }]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.actual.upstreamModel).toBe("ar-code");
    expect(body.upstreamModel).toBe("ag/gemini-3.8-flash-high");
    expect(body.selectedModel).toBe(body.upstreamModel);
    expect(body.upstreamModel).not.toMatch(/^ar-/);

    await app.close();
  });

  it("forwards a concrete model on the V2 chat path", async () => {
    let forwardedModel: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (String(url).includes("/chat/completions")) {
        forwardedModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-v2-direct",
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const app = buildApp(makeConfig("v2"));
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: agenticPrompt }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(forwardedModel).toBe("ag/gemini-3.8-flash-high");
    expect(response.headers["x-auto-router-model"]).toBe(forwardedModel);
    expect(response.headers["x-auto-router-model"]).not.toMatch(/^ar-/);

    await app.close();
  });

  it("does not require legacy combos for V2 readiness", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "ag/gemini-3.8-flash-low" },
            { id: "ag/gemini-3.8-flash-medium" },
            { id: "ag/gemini-3.8-flash-high" },
            { id: "cx/gpt-5.6-terra" },
            { id: "cx/gpt-5.6-luna-review" },
            { id: "free-coding" }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const app = buildApp(makeConfig("v2"));
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.configuredModels).not.toContain("ar-code");
    expect(body.configuredModels).toContain("ag/gemini-3.8-flash-high");
    expect(body.missingModels).not.toContain("ar-code");

    await app.close();
  });

  it("does not append an ar-* fallback to V2 candidates", async () => {
    const attemptedModels: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (String(url).includes("/chat/completions")) {
        attemptedModels.push((JSON.parse(String(init?.body)) as { model: string }).model);
        return Promise.resolve(new Response(JSON.stringify({ error: { code: "model_unavailable" } }), { status: 503 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const config = makeConfig("v2");
    config.routing = { ...routing, globalFallbackModel: "ar-fast" };
    const app = buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: agenticPrompt }]
      }
    });

    expect(response.statusCode).toBe(502);
    expect(attemptedModels.length).toBeGreaterThan(0);
    expect(attemptedModels.every((model) => !model.startsWith("ar-"))).toBe(true);

    await app.close();
  });

  it("reports a concrete model for V2 grounded-search responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: "antigravity",
          answer: { text: "Grounded answer" },
          results: [{ title: "Example", url: "https://example.com" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const app = buildApp(makeConfig("v2"));
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        stream: false,
        messages: [{ role: "user", content: "Cari berita AI terbaru hari ini" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-auto-router-grounded"]).toBe("true");
    expect(response.headers["x-auto-router-model"]).toBe("ag/gemini-3.8-flash-high");
    expect(response.json().model).toBe("ag/gemini-3.8-flash-high");

    await app.close();
  });

  it("does not expose an enabled legacy research profile through V2 grounded search", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: "antigravity",
          answer: { text: "Grounded answer" },
          results: [{ title: "Example", url: "https://example.com" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const researchProfile = DEFAULT_SHADOW_PROFILES.find((profile) => profile.id === "gemini-flash-high")!;
    const config = makeConfig("v2");
    config.shadowProfiles = [
      { ...researchProfile, id: "legacy-research", model: "ar-research", costClass: "very_low", taskFit: ["general", "research"] },
      { ...researchProfile, costClass: "very_high" }
    ];
    const app = buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        stream: false,
        messages: [{ role: "user", content: "Cari berita AI terbaru hari ini" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-auto-router-model"]).toBe("ag/gemini-3.8-flash-high");
    expect(response.json().model).toBe("ag/gemini-3.8-flash-high");

    await app.close();
  });

  it("fails closed instead of dispatching a legacy combo when V2 shadow routing is unavailable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const config = makeConfig("v2");
    config.shadowProfiles = [];
    config.routing = { ...routing, globalFallbackModel: "ar-fast" };
    const app = buildApp(config);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: agenticPrompt }]
      }
    });

    expect(response.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("keeps legacy combo forwarding isolated from V2 behavior", async () => {
    let forwardedModel: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (String(url).includes("/chat/completions")) {
        forwardedModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return Promise.resolve(
          new Response(
            JSON.stringify({ id: "chatcmpl-legacy", object: "chat.completion", choices: [] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const app = buildApp(makeConfig("legacy"));
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Fix this TypeScript error" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(forwardedModel).toBe("ar-code");
    expect(response.headers["x-auto-router-model"]).toBe("ar-code");

    await app.close();
  });
});
