import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NineRouterQuotaSource, SyntheticQuotaSource } from "../src/quota/source.js";

describe("QuotaSource (9Router and Synthetic)", () => {
  const mockProvidersResponse = {
    connections: [
      {
        id: "conn-ag-1",
        provider: "antigravity",
        name: "test@example.com",
        isActive: true,
        testStatus: "active"
      },
      {
        id: "conn-cx-1",
        provider: "codex",
        name: "test@example.com",
        isActive: true,
        testStatus: "active"
      }
    ]
  };

  const mockAgUsageResponse = {
    plan: "Antigravity",
    quotas: {
      "gemini-3.8-flash-high": {
        used: 879,
        total: 1000,
        resetAt: "2026-09-18T07:36:38.000Z",
        remainingPercentage: 12.124255,
        unlimited: false,
        displayName: "Gemini 3.8 Flash (High)"
      },
      "gemini-3.8-flash-medium": {
        used: 879,
        total: 1000,
        resetAt: "2026-09-18T07:36:38.000Z",
        remainingPercentage: 12.124255,
        unlimited: false,
        displayName: "Gemini 3.8 Flash (Medium)"
      },
      "gemini-3.8-flash-low": {
        used: 879,
        total: 1000,
        resetAt: "2026-09-18T07:36:38.000Z",
        remainingPercentage: 12.124255,
        unlimited: false,
        displayName: "Gemini 3.8 Flash (Low)"
      },
      "gemini_weekly": {
        used: 879,
        total: 1000,
        resetAt: "2026-09-18T07:36:38.000Z",
        remainingPercentage: 12.124255,
        unlimited: false,
        displayName: "Gemini (Weekly)"
      }
    }
  };

  const mockCodexUsageResponse = {
    plan: "plus",
    limitReached: false,
    quotas: {
      session: {
        used: 0,
        total: 100,
        remaining: 100,
        resetAt: "2026-09-14T13:34:27.000Z",
        unlimited: false
      },
      weekly: {
        used: 78,
        total: 100,
        remaining: 22,
        resetAt: "2026-09-19T08:39:48.000Z",
        unlimited: false
      }
    }
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes 9Router responses into typed buckets and strips sensitive info", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/providers")) {
        return Promise.resolve(new Response(JSON.stringify(mockProvidersResponse), { status: 200 }));
      }
      if (url.endsWith("/api/usage/conn-ag-1")) {
        return Promise.resolve(new Response(JSON.stringify(mockAgUsageResponse), { status: 200 }));
      }
      if (url.endsWith("/api/usage/conn-cx-1")) {
        return Promise.resolve(new Response(JSON.stringify(mockCodexUsageResponse), { status: 200 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    const source = new NineRouterQuotaSource({
      baseUrl: "http://127.0.0.1:20128",
      refreshTtlMs: 20_000,
      staleFallbackMs: 60_000,
      timeoutMs: 1000,
      fetchImpl: fetchMock
    });

    const snapshot = await source.getSnapshot();
    expect(snapshot.stale).toBe(false);

    // Antigravity buckets
    const geminiWeekly = snapshot.buckets["gemini_weekly"];
    expect(geminiWeekly).toBeDefined();
    expect(geminiWeekly?.provider).toBe("antigravity");
    expect(geminiWeekly?.remainingRatio).toBeCloseTo(0.1212, 3);
    expect(geminiWeekly?.resetAt).toBe("2026-09-18T07:36:38.000Z");

    const geminiFlashPro = snapshot.buckets["gemini_flash_pro"];
    expect(geminiFlashPro).toBeDefined();
    expect(geminiFlashPro?.provider).toBe("antigravity");
    expect(geminiFlashPro?.remainingRatio).toBeCloseTo(0.1212, 3);
    expect(geminiFlashPro?.resetAt).toBe("2026-09-18T07:36:38.000Z");

    // Codex buckets
    const codexSession = snapshot.buckets["codex_session"];
    expect(codexSession).toBeDefined();
    expect(codexSession?.provider).toBe("codex");
    expect(codexSession?.remainingRatio).toBe(1.0);

    const codexWeekly = snapshot.buckets["codex_weekly"];
    expect(codexWeekly).toBeDefined();
    expect(codexWeekly?.provider).toBe("codex");
    expect(codexWeekly?.remainingRatio).toBe(0.22);
    expect(codexWeekly?.resetAt).toBe("2026-09-19T08:39:48.000Z");

    // Ensure no sensitive data
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("test@example.com");
    expect(serialized).not.toContain("conn-ag-1");

    source.close();
  });

  it("serves from cache on subsequent calls within TTL", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callCount += 1;
      if (url.endsWith("/api/providers")) {
        return Promise.resolve(new Response(JSON.stringify(mockProvidersResponse), { status: 200 }));
      }
      if (url.endsWith("/api/usage/conn-ag-1")) {
        return Promise.resolve(new Response(JSON.stringify(mockAgUsageResponse), { status: 200 }));
      }
      if (url.endsWith("/api/usage/conn-cx-1")) {
        return Promise.resolve(new Response(JSON.stringify(mockCodexUsageResponse), { status: 200 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    const source = new NineRouterQuotaSource({
      baseUrl: "http://127.0.0.1:20128",
      refreshTtlMs: 20_000,
      staleFallbackMs: 60_000,
      timeoutMs: 1000,
      fetchImpl: fetchMock
    });

    await source.getSnapshot();
    const callsAfterFirst = callCount;
    expect(callsAfterFirst).toBe(3); // providers + 2 usages

    // Second call within TTL
    const snapshot2 = await source.getSnapshot();
    expect(callCount).toBe(callsAfterFirst); // No new network calls
    expect(snapshot2.stale).toBe(false);

    source.close();
  });

  it("fails open to unknown without crashing if 9Router is unavailable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const source = new NineRouterQuotaSource({
      baseUrl: "http://127.0.0.1:20128",
      refreshTtlMs: 20_000,
      staleFallbackMs: 60_000,
      timeoutMs: 1000,
      fetchImpl: fetchMock
    });

    const snapshot = await source.getSnapshot();
    expect(snapshot.buckets).toEqual({});
    expect(snapshot.providerHealth["antigravity"]).toBe("unavailable");
    expect(snapshot.providerHealth["codex"]).toBe("unavailable");

    source.close();
  });

  it("synthetic source allows exact test control", async () => {
    const synthetic = new SyntheticQuotaSource();
    synthetic.setBucket({
      id: "gemini_weekly",
      provider: "antigravity",
      scope: "weekly",
      used: 1000,
      limit: 1000,
      remaining: 0,
      remainingRatio: 0,
      resetAt: "2026-09-18T00:00:00.000Z",
      observedAt: new Date().toISOString(),
      stale: false
    });

    const snapshot = await synthetic.getSnapshot();
    expect(snapshot.buckets["gemini_weekly"]?.remainingRatio).toBe(0);
  });

  it("marks provider health degraded when usage endpoint times out or fails", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/providers")) {
        return Promise.resolve(new Response(JSON.stringify(mockProvidersResponse), { status: 200 }));
      }
      if (url.endsWith("/api/usage/conn-ag-1")) {
        return Promise.reject(new Error("TimeoutError"));
      }
      if (url.endsWith("/api/usage/conn-cx-1")) {
        return Promise.resolve(new Response(JSON.stringify(mockCodexUsageResponse), { status: 200 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    const source = new NineRouterQuotaSource({
      baseUrl: "http://127.0.0.1:20128",
      refreshTtlMs: 30_000,
      staleFallbackMs: 60_000,
      timeoutMs: 5000,
      fetchImpl: fetchMock
    });

    const snapshot = await source.getSnapshot();
    expect(snapshot.providerHealth["antigravity"]).toBe("degraded");
    expect(snapshot.providerHealth["codex"]).toBe("healthy");
    expect(snapshot.buckets["gemini_flash_pro"]).toBeUndefined();
    expect(snapshot.buckets["codex_session"]).toBeDefined();

    source.close();
  });

  it("parses claude quota buckets from antigravity usage response", async () => {
    const mockAgWithClaude = {
      plan: "Antigravity",
      quotas: {
        ...mockAgUsageResponse.quotas,
        "claude-sonnet-4-6": {
          used: 379,
          total: 1000,
          remainingPercentage: 62.1,
          resetAt: "2026-09-18T07:36:38.000Z",
          unlimited: false
        },
        "claude_gpt_weekly": {
          used: 309,
          total: 1000,
          remainingPercentage: 69.1,
          resetAt: "2026-09-22T07:36:38.000Z",
          unlimited: false
        }
      }
    };

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/providers")) {
        return Promise.resolve(new Response(JSON.stringify(mockProvidersResponse), { status: 200 }));
      }
      if (url.endsWith("/api/usage/conn-ag-1")) {
        return Promise.resolve(new Response(JSON.stringify(mockAgWithClaude), { status: 200 }));
      }
      if (url.endsWith("/api/usage/conn-cx-1")) {
        return Promise.resolve(new Response(JSON.stringify(mockCodexUsageResponse), { status: 200 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    const source = new NineRouterQuotaSource({
      baseUrl: "http://127.0.0.1:20128",
      refreshTtlMs: 30_000,
      staleFallbackMs: 60_000,
      timeoutMs: 5000,
      fetchImpl: fetchMock
    });

    const snapshot = await source.getSnapshot();
    expect(snapshot.buckets["claude_short"]).toBeDefined();
    expect(snapshot.buckets["claude_short"]?.remainingRatio).toBeCloseTo(0.621, 2);
    expect(snapshot.buckets["claude_weekly"]).toBeDefined();
    expect(snapshot.buckets["claude_weekly"]?.remainingRatio).toBeCloseTo(0.691, 2);

    const account = snapshot.accounts?.["antigravity:account_1"];
    expect(account?.buckets["claude_short"]).toBeDefined();
    expect(account?.buckets["claude_weekly"]).toBeDefined();

    source.close();
  });
});
