import test from "node:test";
import assert from "node:assert";
import { SlidingWindowRateLimiter } from "../src/rate-limiter.js";

test("RateLimiter - allows requests within capacity", () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 1000 });
  assert.strictEqual(limiter.isAllowed("user-1", 100), true);
  assert.strictEqual(limiter.isAllowed("user-1", 200), true);
  assert.strictEqual(limiter.isAllowed("user-1", 300), true);
});

test("RateLimiter - blocks requests exceeding capacity within same window", () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1000 });
  assert.strictEqual(limiter.isAllowed("user-2", 100), true);
  assert.strictEqual(limiter.isAllowed("user-2", 200), true);
  assert.strictEqual(limiter.isAllowed("user-2", 300), false);
});

test("RateLimiter - allows new requests after window expires", () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1000 });
  assert.strictEqual(limiter.isAllowed("user-3", 100), true);
  assert.strictEqual(limiter.isAllowed("user-3", 200), true);
  // After window expires (1000ms after 200ms = 1200ms, test at 1500ms)
  assert.strictEqual(limiter.isAllowed("user-3", 1500), true, "Request after window expiration must be permitted");
});
