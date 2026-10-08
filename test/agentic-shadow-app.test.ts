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

describe("Agentic Shadow Routing Endpoints (CP7.3)", () => {
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

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 20205,
    upstreamBaseUrl: "http://127.0.0.1:20128/v1",
    classifierTimeoutMs: 100,
    upstreamTimeoutMs: 100,
    logLevel: "silent",
    routerMode: "v2",
    reasoningPolicy: "auto",
    quotaPolicy: "auto",
    routing,
    quotaSource
  };

  const app = buildApp(config);

  afterAll(() => app.close());
  afterEach(() => vi.restoreAllMocks());

  it("reports structured shadowAgentic in /debug/route for agentic execution prompt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-debug-agentic-1"
      },
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
    expect(body.shadowAgentic).toBeDefined();
    expect(body.shadowAgentic.shadowAgenticEligible).toBe(true);
    expect(body.shadowAgentic.wouldUseSonnet).toBe(true);
    expect(body.shadowAgentic.shadowAgenticProfile).toBe("sonnet-agentic");
    expect(body.shadowAgentic.shadowAgenticModel).toBe("ag/claude-sonnet-4-6");
    expect(body.shadowAgentic.agenticIntent).toBe("execution");
    expect(body.shadowAgentic.agenticSignals).toContain("repo_wide_change");

    // Production forward model MUST NOT be Sonnet!
    expect(body.selectedProfile).not.toBe("sonnet-agentic");
    expect(body.selectedModel).not.toBe("ag/claude-sonnet-4-6");
  });

  it("reports shadowAgentic.wouldUseSonnet = false in /debug/route for non-agentic question", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Design a modular architecture for microservices."
          }
        ]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shadowAgentic).toBeDefined();
    expect(body.shadowAgentic.wouldUseSonnet).toBe(false);
    expect(body.shadowAgentic.shadowAgenticEligible).toBe(false);
    expect(body.shadowAgentic.agenticExclusions).toContain("architecture_design_only");
  });

  it("attaches shadow agentic observability headers on /v1/chat/completions without modifying forwarded model", async () => {
    let capturedUpstreamPayload: any = null;

    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      if (u.includes("/chat/completions")) {
        capturedUpstreamPayload = JSON.parse((init?.body as string) || "{}");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion",
              created: Date.now(),
              model: capturedUpstreamPayload.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Done" },
                  finish_reason: "stop"
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-live-agentic-1"
      },
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
    expect(res.headers["x-auto-router-shadow-agentic-eligible"]).toBe("true");
    expect(res.headers["x-auto-router-shadow-agentic-profile"]).toBe("sonnet-agentic");
    expect(res.headers["x-auto-router-shadow-agentic-model"]).toBe("ag/claude-sonnet-4-6");

    // CRITICAL: Forwarded model to upstream MUST NOT be Sonnet!
    expect(capturedUpstreamPayload.model).not.toBe("ag/claude-sonnet-4-6");
    expect(res.headers["x-auto-router-model"]).not.toBe("ag/claude-sonnet-4-6");
  });
});
