import { describe, it, expect, beforeEach } from "vitest";
import { QuotaCooldownTracker, classify429 } from "../src/quota/cooldown.js";

describe("QuotaCooldownTracker and 429 Classification", () => {
  let tracker: QuotaCooldownTracker;

  beforeEach(() => {
    tracker = new QuotaCooldownTracker({
      defaultQuotaCooldownMs: 300_000,
      defaultRateLimitCooldownMs: 15_000
    });
  });

  it("classifies confirmed quota exhaustion from error body", () => {
    const res1 = classify429(429, JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } }));
    expect(res1.isQuotaExhaustion).toBe(true);
    expect(res1.isTemporaryRateLimit).toBe(false);

    const res2 = classify429(429, "rate_limit_exceeded: quota reached");
    expect(res2.isQuotaExhaustion).toBe(true);
  });

  it("classifies temporary rate limit without quota exhaustion", () => {
    const res = classify429(429, JSON.stringify({ error: { message: "Rate limit exceeded. Please try again in 10s.", type: "rate_limit_error" } }));
    expect(res.isQuotaExhaustion).toBe(false);
    expect(res.isTemporaryRateLimit).toBe(true);
  });

  it("extracts Retry-After header in seconds or HTTP date", () => {
    const res = classify429(429, "rate limit", { "retry-after": "45" });
    expect(res.retryAfterMs).toBe(45_000);
  });

  it("applies cooldown for confirmed quota exhaustion", () => {
    tracker.recordResponse("ag/gemini-3.8-flash-high", 429, { error: { message: "quota exceeded" } });
    const check = tracker.isCooldownActive("ag/gemini-3.8-flash-high");
    expect(check.active).toBe(true);
    expect(check.type).toBe("quota_exhaustion");
  });

  it("honors Retry-After header duration if present", () => {
    tracker.recordResponse("cx/gpt-5.6-terra", 429, { error: { message: "Rate limit" } }, { "retry-after": "2" });
    const check = tracker.isCooldownActive("cx/gpt-5.6-terra");
    expect(check.active).toBe(true);
    expect(check.remainingMs).toBeLessThanOrEqual(2000);
    expect(check.remainingMs).toBeGreaterThan(0);
  });

  it("does not treat 5xx or 401 as quota exhaustion", () => {
    tracker.recordResponse("ag/gemini-3.8-flash-high", 500, { error: "internal server error" });
    tracker.recordResponse("ag/gemini-3.8-flash-medium", 401, { error: "invalid_api_key" });
    expect(tracker.isCooldownActive("ag/gemini-3.8-flash-high").active).toBe(false);
    expect(tracker.isCooldownActive("ag/gemini-3.8-flash-medium").active).toBe(false);
  });
});
