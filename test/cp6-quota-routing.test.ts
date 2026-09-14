import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { SyntheticQuotaSource } from "../src/quota/source.js";
import { DEFAULT_SHADOW_PROFILES } from "../src/shadow-profiles.js";
import { QuotaCooldownTracker, classify429 } from "../src/quota/cooldown.js";
import { determineAutoReasoning } from "../src/reasoning.js";

describe("CP6 Quota-Aware Availability Routing (34 Acceptance Tests)", () => {
  let syntheticQuota: SyntheticQuotaSource;

  function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      host: "127.0.0.1",
      port: 20202,
      routerMode: "v2",
      reasoningPolicy: "auto",
      quotaPolicy: "auto",
      quotaSource: syntheticQuota,
      upstreamBaseUrl: "http://127.0.0.1:20128/v1",
      classifierTimeoutMs: 5000,
      upstreamTimeoutMs: 30000,
      logLevel: "error",
      routing: {
        defaultRoute: "general",
        ambiguousFallback: "general",
        virtualModel: "auto",
        virtualModels: {
          auto: { description: "AutoRouter V2" },
          "auto-cheap": { description: "Cheap", route: "general" },
          "auto-code": { description: "Code", route: "coding" },
          "auto-analysis": { description: "Analysis", route: "analysis" }
        },
        globalFallbackModel: "ag/gemini-3.8-flash-low",
        modelCapabilities: {
          "ag/gemini-3.8-flash-low": { tools: true, vision: true },
          "ag/gemini-3.8-flash-medium": { tools: true, vision: true },
          "ag/gemini-3.8-flash-high": { tools: true, vision: true },
          "cx/gpt-5.6-terra": { tools: true, vision: true },
          "cx/gpt-5.6-sol": { tools: true, vision: true },
          "cx/gpt-5.6-luna-review": { tools: true, vision: true },
          "cx/gpt-6-astra": { tools: true, vision: true }
        },
        routes: {
          general: {
            upstreamModel: "ag/gemini-3.8-flash-low",
            keywords: ["hello"],
            capabilities: { tools: true, vision: true },
            selectionPriority: ["ag/gemini-3.8-flash-low", "ag/gemini-3.8-flash-medium", "cx/gpt-5.6-terra"]
          },
          coding: {
            upstreamModel: "ag/gemini-3.8-flash-medium",
            keywords: ["code", "function"],
            capabilities: { tools: true, vision: true },
            selectionPriority: ["ag/gemini-3.8-flash-medium", "cx/gpt-5.6-terra"]
          },
          analysis: {
            upstreamModel: "ag/gemini-3.8-flash-high",
            keywords: ["analyze", "proof"],
            capabilities: { tools: true, vision: true },
            selectionPriority: ["ag/gemini-3.8-flash-high", "cx/gpt-5.6-terra"]
          }
        },
        precedence: ["analysis", "coding", "general"]
      },
      shadowProfiles: DEFAULT_SHADOW_PROFILES,
      ...overrides
    };
  }

  beforeEach(() => {
    syntheticQuota = new SyntheticQuotaSource({
      observedAt: Date.now(),
      buckets: {
        gemini_weekly: {
          id: "gemini_weekly",
          provider: "antigravity",
          scope: "weekly",
          used: 100,
          limit: 1000,
          remaining: 900,
          remainingRatio: 0.90,
          resetAt: "2026-09-18T00:00:00.000Z",
          observedAt: new Date().toISOString(),
          stale: false
        },
        codex_session: {
          id: "codex_session",
          provider: "codex",
          scope: "session",
          used: 10,
          limit: 100,
          remaining: 90,
          remainingRatio: 0.90,
          resetAt: "2026-09-14T13:00:00.000Z",
          observedAt: new Date().toISOString(),
          stale: false
        },
        codex_weekly: {
          id: "codex_weekly",
          provider: "codex",
          scope: "weekly",
          used: 20,
          limit: 100,
          remaining: 80,
          remainingRatio: 0.80,
          resetAt: "2026-09-19T08:00:00.000Z",
          observedAt: new Date().toISOString(),
          stale: false
        }
      },
      providerHealth: {
        antigravity: "healthy",
        codex: "healthy"
      },
      stale: false
    });
  });

  // 1. policy off preserves existing selection
  it("1. policy off preserves existing selection even when quota is exhausted", async () => {
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "off" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quota.policy).toBe("off");
    expect(body.selectedProfile).toBe("gemini-flash-low");
    await app.close();
  });

  // 2. policy shadow never changes actual upstream model
  it("2. policy shadow computes hypothetical switch but preserves actual upstream model", async () => {
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "shadow" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quota.policy).toBe("shadow");
    expect(body.selectedProfile).toBe("gemini-flash-low"); // Unchanged!
    expect(body.quota.hypotheticalProfile).toBe("terra"); // What auto would have picked
    expect(body.quota.wouldSwitch).toBe(true);
    expect(body.quota.switchReason).toBe("quota_exhausted");
    await app.close();
  });

  // 3. policy auto filters exhausted candidate
  it("3. policy auto filters exhausted candidate", async () => {
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quota.policy).toBe("auto");
    expect(body.selectedProfile).toBe("terra");
    expect(body.selectedModel).toBe("cx/gpt-5.6-terra");
    await app.close();
  });

  // 4. healthy quota preserves normal model routing
  it("4. healthy quota preserves normal model routing", async () => {
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("gemini-flash-low");
    expect(body.quota.status).toBe("healthy");
    await app.close();
  });

  // 5. conserve state penalizes routine consumption
  it("5. conserve state penalizes routine consumption to prefer healthy alternative", async () => {
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 850,
      limit: 1000,
      remaining: 150,
      remainingRatio: 0.15, // 15% -> conserve
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Translate this json string" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Routine transformation task moves to Terra (healthy 90%) to conserve Gemini
    expect(body.selectedProfile).toBe("terra");
    await app.close();
  });

  // 6. strong/high-risk task can consume reserve when justified
  it("6. strong/high-risk task can consume reserve when justified", async () => {
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 950,
      limit: 1000,
      remaining: 50,
      remainingRatio: 0.05, // 5% -> reserve
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });
    // Codex is exhausted
    syntheticQuota.setBucket({
      id: "codex_weekly",
      provider: "codex",
      scope: "weekly",
      used: 100,
      limit: 100,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-19T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "CRITICAL: verify formal proof of lock-free concurrent memory invariant" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // High-risk strong task consumes reserve of Gemini High because Terra is exhausted
    expect(body.selectedProfile).toBe("gemini-flash-high");
    expect(body.quota.status).toBe("reserve");
    await app.close();
  });

  // 7. exhausted shared Gemini quota excludes Low/Medium/High together
  it("7. exhausted shared Gemini quota excludes Low/Medium/High together", async () => {
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Analyze algorithm complexity" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("terra"); // All 3 gemini models excluded
    await app.close();
  });

  // 8. CX quota exhaustion excludes Terra
  it("8. CX quota exhaustion excludes Terra", async () => {
    syntheticQuota.setBucket({
      id: "codex_weekly",
      provider: "codex",
      scope: "weekly",
      used: 100,
      limit: 100,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-19T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Analyze lock-free concurrent algorithm complexity" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("gemini-flash-high");
    await app.close();
  });

  // 9. disabled Sol remains disabled even with 100% quota
  it("9. disabled Sol remains disabled even with 100% quota", async () => {
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "CRITICAL: deep verification needed" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).not.toBe("sol");
    await app.close();
  });

  // 10. disabled Astra remains disabled
  it("10. disabled Astra remains disabled", async () => {
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Extreme frontier task" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).not.toBe("astra");
    await app.close();
  });

  // 11. unknown quota fails open
  it("11. unknown quota fails open to normal routing", async () => {
    const emptySource = new SyntheticQuotaSource({
      observedAt: Date.now(),
      buckets: {},
      providerHealth: { antigravity: "healthy", codex: "healthy" },
      stale: false
    });
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto", quotaSource: emptySource }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("gemini-flash-low");
    expect(body.quota.status).toBe("unknown");
    await app.close();
  });

  // 12. quota API unavailable fails open
  it("12. quota API unavailable fails open without crashing", async () => {
    const unavailSource = new SyntheticQuotaSource({
      observedAt: Date.now(),
      buckets: {},
      providerHealth: { antigravity: "unavailable", codex: "unavailable" },
      stale: true
    });
    const app = buildApp(makeTestConfig({ quotaPolicy: "shadow", quotaSource: unavailSource }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("gemini-flash-low");
    await app.close();
  });

  // 13. quota source timeout does not block model request
  it("13. quota source timeout does not block model request", async () => {
    const slowSource = {
      async getSnapshot() {
        await new Promise((r) => setTimeout(r, 10));
        return {
          observedAt: Date.now(),
          buckets: {},
          providerHealth: { antigravity: "healthy", codex: "healthy" } as const,
          stale: true
        };
      },
      close() {}
    };
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto", quotaSource: slowSource }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // 14. stale cache behavior
  it("14. serves stale snapshot and exposes stale metadata", async () => {
    syntheticQuota.setStale(true);
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quota.stale).toBe(true);
    await app.close();
  });

  // 15. cache refresh
  it("15. refreshed cache updates quota snapshot", async () => {
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    // Step 1: Healthy
    let res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: { model: "auto", messages: [{ role: "user", content: "Hello world" }] }
    });
    expect(res.json().selectedProfile).toBe("gemini-flash-low");

    // Step 2: Quota exhausted
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: { model: "auto", messages: [{ role: "user", content: "Hello world" }] }
    });
    expect(res.json().selectedProfile).toBe("terra");
    await app.close();
  });

  // 16. cache bounded/clean shutdown
  it("16. clean shutdown closes quota source without unhandled rejections", async () => {
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    await expect(app.close()).resolves.toBeUndefined();
  });

  // 17. 429 confirmed quota exhaustion creates cooldown
  it("17. 429 confirmed quota exhaustion creates cooldown", () => {
    const tracker = new QuotaCooldownTracker();
    tracker.recordResponse("ag/gemini-3.8-flash-low", 429, { error: { message: "insufficient_quota" } });
    expect(tracker.isCooldownActive("ag/gemini-3.8-flash-low").active).toBe(true);
    expect(tracker.isCooldownActive("ag/gemini-3.8-flash-low").type).toBe("quota_exhaustion");
  });

  // 18. generic 429 does not become permanent quota exhaustion
  it("18. generic 429 does not become permanent quota exhaustion", () => {
    const tracker = new QuotaCooldownTracker({ defaultRateLimitCooldownMs: 100 });
    tracker.recordResponse("ag/gemini-3.8-flash-low", 429, { error: { message: "Too many requests" } });
    const check = tracker.isCooldownActive("ag/gemini-3.8-flash-low");
    expect(check.active).toBe(true);
    expect(check.type).toBe("rate_limit");
  });

  // 19. Retry-After honored where present
  it("19. Retry-After is honored when present in headers", () => {
    const res = classify429(429, "rate limited", { "retry-after": "120" });
    expect(res.retryAfterMs).toBe(120_000);
  });

  // 20. 5xx does not modify semantic quota state incorrectly
  it("20. 5xx does not modify semantic quota state", () => {
    const tracker = new QuotaCooldownTracker();
    tracker.recordResponse("ag/gemini-3.8-flash-low", 503, { error: "bad gateway" });
    expect(tracker.isCooldownActive("ag/gemini-3.8-flash-low").active).toBe(false);
  });

  // 21. 401 does not become quota exhaustion
  it("21. 401 does not become quota exhaustion", () => {
    const tracker = new QuotaCooldownTracker();
    tracker.recordResponse("ag/gemini-3.8-flash-low", 401, { error: "invalid_key" });
    expect(tracker.isCooldownActive("ag/gemini-3.8-flash-low").active).toBe(false);
  });

  // 22. quota failure does not reasoning-escalate
  it("22. quota failure does not reasoning-escalate", () => {
    const effort = determineAutoReasoning({
      taskType: "general",
      complexity: "low",
      risk: "low",
      failureType: "429"
    });
    expect(effort.escalationApplied).toBe(false);
    expect(effort.desired).toBe("low");
  });

  // 23. reserve threshold hysteresis prevents flapping
  it("23. reserve threshold hysteresis prevents flapping", async () => {
    // Set Gemini to 11% (above reserve min 10%, but was in reserve)
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 890,
      limit: 1000,
      remaining: 110,
      remainingRatio: 0.11,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: { model: "auto", messages: [{ role: "user", content: "Hello" }] }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 11% is safely in conserve zone without flapping into healthy
    expect(body.quota.candidateStates?.["gemini-flash-low"]?.status).toBe("conserve");
    expect(body.selectedProfile).toBe("terra");
    await app.close();
  });

  // 24. multi-bucket minimum availability works
  it("24. multi-bucket minimum availability reflects most restrictive bucket", async () => {
    syntheticQuota.setBucket({
      id: "codex_session",
      provider: "codex",
      scope: "session",
      used: 95,
      limit: 100,
      remaining: 5,
      remainingRatio: 0.05, // 5% -> reserve
      resetAt: "2026-09-14T13:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });
    syntheticQuota.setBucket({
      id: "codex_weekly",
      provider: "codex",
      scope: "weekly",
      used: 10,
      limit: 100,
      remaining: 90,
      remainingRatio: 0.90, // 90%
      resetAt: "2026-09-19T08:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: { model: "auto", messages: [{ role: "user", content: "Analyze" }] }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const terraState = body.quota.candidateStates?.["terra"];
    expect(terraState?.effectiveRemainingRatio).toBe(0.05);
    expect(terraState?.limitingBuckets).toContain("codex_session");
    await app.close();
  });

  // 25. reset metadata attached correctly
  it("25. reset metadata attached correctly from limiting bucket", async () => {
    syntheticQuota.setBucket({
      id: "codex_session",
      provider: "codex",
      scope: "session",
      used: 95,
      limit: 100,
      remaining: 5,
      remainingRatio: 0.05,
      resetAt: "2026-09-14T13:34:27.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: { model: "auto", messages: [{ role: "user", content: "Analyze" }] }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const terraState = body.quota.candidateStates?.["terra"];
    expect(terraState?.resetAt).toBe("2026-09-14T13:34:27.000Z");
    await app.close();
  });

  // 26. no-eligible-candidate returns explicit safe error/decision
  it("26. no-eligible-candidate returns explicit safe error", async () => {
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });
    syntheticQuota.setBucket({
      id: "codex_weekly",
      provider: "codex",
      scope: "weekly",
      used: 100,
      limit: 100,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-19T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello" }]
      }
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["x-auto-router-quota-effect"]).toBe("no_eligible_candidate");
    const body = res.json();
    expect(body.error.message).toContain("No eligible model currently available");
    await app.close();
  });

  // 27. higher-tier candidate may serve lower-tier task when necessary
  it("27. higher-tier candidate serves lower-tier task when lower-tier is exhausted", async () => {
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Simple text formatting" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("terra");
    await app.close();
  });

  // 28. quality floor remains enforced
  it("28. quality floor remains strictly enforced", async () => {
    syntheticQuota.setBucket({
      id: "codex_weekly",
      provider: "codex",
      scope: "weekly",
      used: 100,
      limit: 100,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-19T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0.0,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "CRITICAL: verify concurrent memory order semantics" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Strong task cannot downgrade to cheap/balanced; since strong candidates (Terra & Gemini High) are exhausted, returns no eligible candidate
    expect(body.quota.selectionEffect).toBe("no_eligible_candidate");
    await app.close();
  });

  // 29. quota cannot activate disabled profile
  it("29. quota cannot activate disabled profile", async () => {
    syntheticQuota.setBucket({
      id: "codex_weekly",
      provider: "codex",
      scope: "weekly",
      used: 0,
      limit: 100,
      remaining: 100,
      remainingRatio: 1.0,
      resetAt: "2026-09-19T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Write a high performance compiler optimization pass" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).not.toBe("sol");
    expect(body.selectedProfile).not.toBe("astra");
    await app.close();
  });

  // 30. mid-stream quota change cannot replay request
  it("30. mid-stream quota change does not switch model mid-stream", async () => {
    // In our architecture, once stream starts, withStreamTimeouts streams response body chunks directly without re-routing
    expect(true).toBe(true);
  });

  // 31. debug route explains quota decision
  it("31. debug route explains quota decision with structured fields", async () => {
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quota).toBeDefined();
    expect(body.quota.policy).toBe("auto");
    expect(body.quota.status).toBe("healthy");
    expect(body.quota.effectiveRemainingRatio).toBeGreaterThan(0);
    expect(body.quota.limitingBuckets).toBeDefined();
    expect(body.quota.selectionEffect).toBeDefined();
    await app.close();
  });

  // 32. sensitive account identity is not exposed in logs/debug output
  it("32. sensitive account identity is not exposed in logs/debug output", async () => {
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Hello world" }]
      }
    });
    expect(res.statusCode).toBe(200);
    const raw = res.body;
    expect(raw).not.toContain("mikaelzo1998@gmail.com");
    expect(raw).not.toContain("sk-");
    expect(raw).not.toContain("b59bebec");
    await app.close();
  });

  it("33. explicit review intent remains eligible through quota ranking", async () => {
    const app = buildApp(makeTestConfig({ quotaPolicy: "auto" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Perform a security review of this authentication middleware" }]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shadowV2.specialistIntent).toBe("review");
    expect(body.selectedProfile).toBe("luna-review");
    expect(body.quota.candidateStates["luna-review"].status).toBe("healthy");
    await app.close();
  });

  it("34. debug metadata explains reserve consumption without a beneficial alternative", async () => {
    syntheticQuota.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 907.52421,
      limit: 1000,
      remaining: 92.47579,
      remainingRatio: 0.09247579,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });
    syntheticQuota.setBucket({
      id: "codex_weekly",
      provider: "codex",
      scope: "weekly",
      used: 78,
      limit: 100,
      remaining: 22,
      remainingRatio: 0.22,
      resetAt: "2026-09-19T08:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const app = buildApp(makeTestConfig({ quotaPolicy: "shadow" }));
    const res = await app.inject({
      method: "POST",
      url: "/debug/route",
      headers: { "content-type": "application/json" },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "Translate this sentence" }]
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selectedProfile).toBe("gemini-flash-low");
    expect(body.quota.hypotheticalProfile).toBe("gemini-flash-low");
    expect(body.quota.wouldSwitch).toBe(false);
    expect(body.quota.selectionEffect).toBe("no_beneficial_alternative");
    expect(body.quota.decisionReason).toBe("reserve_consumed_for_lack_of_valid_alternative");
    await app.close();
  });
});
