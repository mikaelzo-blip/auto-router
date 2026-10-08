import { describe, it, expect, vi } from "vitest";
import { createSessionStore, validateProfileRegistry, routeShadow, type ExecutionProfile } from "../src/shadow-router.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { RoutingConfig } from "../src/types.js";

const mockRouting: RoutingConfig = {
  virtualModel: "auto",
  defaultRoute: "fast-chat",
  ambiguousFallback: "fast-chat",
  globalFallbackModel: "ar-fast",
  virtualModels: {
    auto: { description: "Dynamic routing" },
    "fast-chat": { route: "fast-chat" }
  },
  routes: {
    "fast-chat": {
      upstreamModel: "ar-fast",
      keywords: ["fast"],
      capabilities: { tools: true, vision: true },
      selectionPriority: ["ar-fast", "ar-code"]
    }
  },
  modelCapabilities: {
    "ar-fast": { tools: true, vision: true },
    "ar-code": { tools: true, vision: true },
    "ag/gemini-3.8-flash-low": { tools: true, vision: true },
    "ag/gemini-3.8-flash-medium": { tools: true, vision: true },
    "ag/gemini-3.8-flash-high": { tools: true, vision: true }
  },
  precedence: ["fast-chat"]
};

const mockProfiles: ExecutionProfile[] = [
  {
    id: "gemini-flash-low",
    model: "ag/gemini-3.8-flash-low",
    enabled: true,
    profileClass: "general",
    hardCapabilities: { tools: true, vision: true },
    taskFit: ["general", "transformation"],
    qualityTier: "cheap",
    costClass: "very_low",
    latencyClass: "fast",
    reasoningEffort: "low"
  },
  {
    id: "gemini-flash-medium",
    model: "ag/gemini-3.8-flash-medium",
    enabled: true,
    profileClass: "general",
    hardCapabilities: { tools: true, vision: true },
    taskFit: ["general", "transformation", "code", "analysis", "research", "multimodal"],
    qualityTier: "balanced",
    costClass: "low",
    latencyClass: "fast",
    reasoningEffort: "medium"
  },
  {
    id: "gemini-flash-high",
    model: "ag/gemini-3.8-flash-high",
    enabled: true,
    profileClass: "general",
    hardCapabilities: { tools: true, vision: true },
    taskFit: ["general", "transformation", "code", "analysis", "research", "multimodal"],
    qualityTier: "strong",
    costClass: "medium",
    latencyClass: "medium",
    reasoningEffort: "high"
  }
];

const createConfig = (mode: "legacy" | "shadow" | "v2"): AppConfig => ({
  host: "127.0.0.1",
  port: 20201,
  routerMode: mode,
  upstreamBaseUrl: "http://127.0.0.1:20128/v1",
  classifierTimeoutMs: 1000,
  upstreamTimeoutMs: 5000,
  connectTimeoutMs: 1000,
  headerTimeoutMs: 2000,
  firstByteTimeoutMs: 3000,
  streamIdleTimeoutMs: 2000,
  logLevel: "silent",
  routing: mockRouting,
  shadowProfiles: mockProfiles
});

describe("CP3 Failure & Safe Execution Invariants", () => {
  it("registry invalid -> startup failure", () => {
    expect(() => validateProfileRegistry([])).toThrow("Profile registry must not be empty");
    expect(() =>
      validateProfileRegistry([
        {
          id: "",
          model: "test",
          enabled: true,
          hardCapabilities: { tools: true, vision: true },
          taskFit: ["general"],
          qualityTier: "cheap",
          costClass: "very_low",
          latencyClass: "fast"
        }
      ])
    ).toThrow("Malformed execution profile");
  });

  it("session count bound exceeded -> bounded eviction behavior", () => {
    const store = createSessionStore(100_000, 2);
    store.set("sess-1", {
      currentExecutionProfile: "gemini-flash-low",
      currentTaskType: "general",
      currentQualityTier: "cheap",
      lastSwitchReason: "none",
      recentFailureCount: 0,
      lastSeenAt: Date.now()
    });
    store.set("sess-2", {
      currentExecutionProfile: "gemini-flash-medium",
      currentTaskType: "code",
      currentQualityTier: "balanced",
      lastSwitchReason: "none",
      recentFailureCount: 0,
      lastSeenAt: Date.now()
    });
    expect(store.get("sess-1")).toBeDefined();
    expect(store.get("sess-2")).toBeDefined();

    store.set("sess-3", {
      currentExecutionProfile: "gemini-flash-high",
      currentTaskType: "code",
      currentQualityTier: "strong",
      lastSwitchReason: "none",
      recentFailureCount: 0,
      lastSeenAt: Date.now()
    });
    expect(store.get("sess-1")).toBeUndefined();
    expect(store.get("sess-2")).toBeDefined();
    expect(store.get("sess-3")).toBeDefined();
  });

  it("session state expired -> clean routing after TTL", () => {
    const store = createSessionStore(20);
    store.set("sess-expire", {
      currentExecutionProfile: "gemini-flash-high",
      currentTaskType: "code",
      currentQualityTier: "strong",
      lastSwitchReason: "none",
      recentFailureCount: 0,
      lastSeenAt: Date.now() - 50
    });
    expect(store.get("sess-expire")).toBeUndefined();
  });

  it("selected model unavailable pre-stream -> ranked eligible alternative allowed", async () => {
    const app = await buildApp(createConfig("v2"));
    let attempt = 0;
    const requestedModels: string[] = [];

    const mockFetch = vi.fn().mockImplementation((_url, init) => {
      attempt++;
      const body = JSON.parse(init.body as string);
      requestedModels.push(body.model);
      if (attempt === 1) {
        return Promise.resolve(new Response("Upstream Error", { status: 502 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "success from alternative" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    });
    global.fetch = mockFetch;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", messages: [{ role: "user", content: "hello world" }] }
    });

    expect(res.statusCode).toBe(200);
    expect(requestedModels.length).toBeGreaterThan(1);
    expect(requestedModels[0]).not.toBe(requestedModels[1]);
    await app.close();
  });

  it("HTTP 429 pre-stream -> infrastructure fallback behavior correct", async () => {
    const app = await buildApp(createConfig("v2"));
    let attempt = 0;
    const requestedModels: string[] = [];

    const mockFetch = vi.fn().mockImplementation((_url, init) => {
      attempt++;
      const body = JSON.parse(init.body as string);
      requestedModels.push(body.model);
      if (attempt === 1) {
        return Promise.resolve(new Response("Rate Limited", { status: 429 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "recovered from 429" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    });
    global.fetch = mockFetch;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", messages: [{ role: "user", content: "perform coding work" }] }
    });

    expect(res.statusCode).toBe(200);
    expect(requestedModels.length).toBe(2);
    await app.close();
  });

  it("mid-stream disconnect -> NO cross-model replay (CP1 safety preserved)", async () => {
    const app = await buildApp(createConfig("v2"));
    let calls = 0;

    const mockFetch = vi.fn().mockImplementation(() => {
      calls++;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"part1\"}}]}\n\n"));
          controller.error(new Error("Mid-stream connection reset"));
        }
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      );
    });
    global.fetch = mockFetch;

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", stream: true, messages: [{ role: "user", content: "stream please" }] }
    });

    expect(calls).toBe(1);
    await app.close();
  });

  it("emits diagnostic x-auto-router-mode header in v2 mode", async () => {
    const app = await buildApp(createConfig("v2"));
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "v2 response" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    global.fetch = mockFetch;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", messages: [{ role: "user", content: "simple text rewrite" }] }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-auto-router-mode"]).toBe("v2");
    expect(res.headers["x-auto-router-profile"]).toBeDefined();
    await app.close();
  });

  it("emits legacy mode header when ROUTER_MODE=legacy", async () => {
    const app = await buildApp(createConfig("legacy"));
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "legacy response" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    global.fetch = mockFetch;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", messages: [{ role: "user", content: "hello" }] }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-auto-router-mode"]).toBe("legacy");
    expect(res.headers["x-auto-router-model"]).toBe("ar-fast");
    await app.close();
  });
});
