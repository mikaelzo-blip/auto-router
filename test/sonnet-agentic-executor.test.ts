import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { RoutingConfig } from "../src/types.js";
import { SyntheticQuotaSource } from "../src/quota/source.js";

const routing = JSON.parse(
  await readFile(resolve("config/routes.json"), "utf8")
) as RoutingConfig;

describe("Sonnet 4.6 Authoritative Agentic Executor (Production Checkpoint)", () => {
  const quotaSource = new SyntheticQuotaSource();
  quotaSource.setBucket({
    id: "gemini_weekly",
    provider: "antigravity",
    scope: "weekly",
    used: 100,
    limit: 1000,
    remaining: 900,
    remainingRatio: 0.90,
    resetAt: "2026-09-22T00:00:00.000Z",
    observedAt: new Date().toISOString(),
    stale: false
  });
  quotaSource.setBucket({
    id: "claude_weekly",
    provider: "antigravity",
    scope: "weekly",
    used: 200,
    limit: 1000,
    remaining: 800,
    remainingRatio: 0.80,
    resetAt: "2026-09-22T00:00:00.000Z",
    observedAt: new Date().toISOString(),
    stale: false
  });

  const baseConfig: AppConfig = {
    host: "127.0.0.1",
    port: 20206,
    upstreamBaseUrl: "http://127.0.0.1:20128/v1",
    classifierTimeoutMs: 100,
    upstreamTimeoutMs: 100,
    logLevel: "silent",
    routerMode: "v2",
    reasoningPolicy: "auto",
    quotaPolicy: "auto",
    sonnetAgenticEnabled: true,
    routing,
    quotaSource
  };

  const app = buildApp(baseConfig);

  afterAll(() => app.close());
  afterEach(() => vi.restoreAllMocks());

  // --------------------------------------------------------------------------
  // Case 1: Routine -> Gemini Low
  // --------------------------------------------------------------------------
  it("Case 1: Routine request routes to Gemini Low (ag/gemini-3.8-flash-low)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world, how are you?" }]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("gemini-flash-low");
    expect(body.selectedModel).toBe("ag/gemini-3.8-flash-low");
    expect(body.shadowAgentic.wouldUseSonnet).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Case 2: Normal coding -> Gemini Medium
  // --------------------------------------------------------------------------
  it("Case 2: Normal coding request routes to Gemini Medium (ag/gemini-3.8-flash-medium)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Write a regex to validate an email address in TypeScript." }]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("gemini-flash-medium");
    expect(body.selectedModel).toBe("ag/gemini-3.8-flash-medium");
    expect(body.shadowAgentic.wouldUseSonnet).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Case 3: Architecture / PRD -> Gemini High
  // --------------------------------------------------------------------------
  it("Case 3: Architecture / PRD request routes to Gemini High (ag/gemini-3.8-flash-high)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Design the architecture for an event-driven distributed payment system." }]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("gemini-flash-high");
    expect(body.selectedModel).toBe("ag/gemini-3.8-flash-high");
    expect(body.shadowAgentic.wouldUseSonnet).toBe(false);
    expect(body.shadowAgentic.agenticExclusions).toContain("architecture_design_only");
  });

  // --------------------------------------------------------------------------
  // Case 4: Agentic multi-file implementation -> Sonnet 4.6
  // --------------------------------------------------------------------------
  it("Case 4: Agentic multi-file implementation routes to Sonnet 4.6 (ag/claude-sonnet-4-6)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Implement this approved architecture across API, database and tests, then verify all tests pass."
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("sonnet-agentic");
    expect(body.selectedModel).toBe("ag/claude-sonnet-4-6");
    expect(body.shadowAgentic.wouldUseSonnet).toBe(true);
    expect(body.shadowAgentic.agenticIntent).toBe("execution");
  });

  it("Case 4 (live dispatch): Forwards to Sonnet 4.6 on /v1/chat/completions when enabled", async () => {
    let capturedUpstreamPayload: any = null;

    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.includes("/chat/completions")) {
        capturedUpstreamPayload = JSON.parse((init?.body as string) || "{}");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-sonnet-agentic",
              object: "chat.completion",
              created: Date.now(),
              model: capturedUpstreamPayload.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Implementation verified green." },
                  finish_reason: "stop"
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Implement wildcard event bus across several files in src/events/, update types, and run tests until passing."
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    expect(capturedUpstreamPayload.model).toBe("ag/claude-sonnet-4-6");
    expect(res.headers["x-auto-router-model"]).toBe("ag/claude-sonnet-4-6");
    expect(res.headers["x-auto-router-profile"]).toBe("sonnet-agentic");
    expect(res.headers["x-auto-router-shadow-agentic-eligible"]).toBe("true");
  });

  // --------------------------------------------------------------------------
  // Case 5: Claude unavailable -> Gemini High fallback
  // --------------------------------------------------------------------------
  it("Case 5A: Claude quota exhausted upfront -> routes to Gemini High fallback", async () => {
    const exhaustedQuotaSource = new SyntheticQuotaSource();
    exhaustedQuotaSource.setBucket({
      id: "claude_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-22T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });
    exhaustedQuotaSource.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 100,
      limit: 1000,
      remaining: 900,
      remainingRatio: 0.90,
      resetAt: "2026-09-22T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const exhaustedApp = buildApp({
      ...baseConfig,
      quotaSource: exhaustedQuotaSource
    });

    const res = await exhaustedApp.inject({
      method: "POST",
      url: "/debug/route",
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Implement this approved architecture across API, database and tests, then verify all tests pass."
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("gemini-flash-high");
    expect(body.selectedModel).toBe("ag/gemini-3.8-flash-high");
    expect(body.shadowAgentic.wouldUseSonnet).toBe(false);
    expect(body.shadowAgentic.shadowAgenticReason).toContain("claude_quota_exhausted");

    await exhaustedApp.close();
  });

  it("Case 5B: Upstream Sonnet 503 before response -> fallbacks to Gemini High", async () => {
    const attemptedModels: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.includes("/chat/completions")) {
        const payload = JSON.parse((init?.body as string) || "{}");
        attemptedModels.push(payload.model);
        if (payload.model === "ag/claude-sonnet-4-6") {
          return Promise.resolve(new Response(JSON.stringify({ error: { message: "Claude service overloaded" } }), { status: 503 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-fallback-success",
              object: "chat.completion",
              created: Date.now(),
              model: payload.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Completed by Gemini High fallback." },
                  finish_reason: "stop"
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Implement wildcard event bus across several files in src/events/, update types, and run tests until passing."
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    expect(attemptedModels).toEqual(["ag/claude-sonnet-4-6", "ag/gemini-3.8-flash-high"]);
    expect(res.headers["x-auto-router-model"]).toBe("ag/gemini-3.8-flash-high");
    expect(res.headers["x-auto-router-profile"]).toBe("gemini-flash-high");
  });

  // --------------------------------------------------------------------------
  // Case 6: Agentic task followed by simple summary -> de-escalates back to Gemini
  // --------------------------------------------------------------------------
  it("Case 6: Agentic task followed by summary/passing tests de-escalates to Gemini", async () => {
    const sessionId = "sess-de-escalate-test";

    // Turn 1: Agentic task -> Sonnet 4.6
    const res1 = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "x-session-id": sessionId },
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Implement this approved architecture across API, database and tests, then verify all tests pass."
          }
        ]
      }
    });

    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.selectedProfile).toBe("sonnet-agentic");
    expect(body1.selectedModel).toBe("ag/claude-sonnet-4-6");

    // Turn 2: Follow-up summary request -> de-escalate back to Gemini
    const res2 = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "x-session-id": sessionId },
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Implement this approved architecture across API, database and tests, then verify all tests pass."
          },
          {
            role: "assistant",
            content: "All tests green and implementation finished."
          },
          {
            role: "user",
            content: "Please summarize what changed across the files."
          }
        ]
      }
    });

    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.selectedProfile).not.toBe("sonnet-agentic");
    expect(body2.selectedModel).not.toBe("ag/claude-sonnet-4-6");
    expect(body2.shadowAgentic.wouldUseSonnet).toBe(false);
    expect(body2.shadowAgentic.shadowAgenticReason).toBe("de_escalation_after_verification");
  });

  // --------------------------------------------------------------------------
  // Kill Switch: SONNET_AGENTIC_ENABLED=false
  // --------------------------------------------------------------------------
  it("Kill Switch: When SONNET_AGENTIC_ENABLED=false, routes to Gemini while computing shadow", async () => {
    const disabledApp = buildApp({
      ...baseConfig,
      sonnetAgenticEnabled: false
    });

    const res = await disabledApp.inject({
      method: "POST",
      url: "/debug/route",
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Implement this approved architecture across API, database and tests, then verify all tests pass."
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sonnetAgenticEnabled).toBe(false);
    // Forward selection is Gemini High, NOT Sonnet!
    expect(body.selectedProfile).toBe("gemini-flash-high");
    expect(body.selectedModel).toBe("ag/gemini-3.8-flash-high");
    // Shadow agentic correctly identified it would use Sonnet if enabled
    expect(body.shadowAgentic.wouldUseSonnet).toBe(true);

    await disabledApp.close();
  });
});
