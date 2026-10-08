import test from "node:test";
import assert from "node:assert";
import { SlidingWindowRateLimiter } from "../src/rate-limiter.js";

test("Hidden: RateLimiter - exact window boundary condition", () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1000 });
  assert.strictEqual(limiter.isAllowed("key-a", 1000), true);
  assert.strictEqual(limiter.isAllowed("key-a", 1500), true);
  assert.strictEqual(limiter.isAllowed("key-a", 1999), false);
  // At exact t=2000, 1000ms window has passed since t=1000, so first request has expired!
  assert.strictEqual(limiter.isAllowed("key-a", 2000), true);
});

test("Hidden: RateLimiter - multi-key isolation", () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000 });
  assert.strictEqual(limiter.isAllowed("tenant-1", 100), true);
  assert.strictEqual(limiter.isAllowed("tenant-2", 100), true);
  assert.strictEqual(limiter.isAllowed("tenant-1", 200), false);
  assert.strictEqual(limiter.isAllowed("tenant-2", 200), false);
});

test("Hidden: RateLimiter - token count calculation accuracy", () => {
  const limiter = new SlidingWindowRateLimiter({ limit: 5, windowMs: 1000 });
  limiter.isAllowed("k1", 100);
  limiter.isAllowed("k1", 200);
  assert.strictEqual(limiter.getRemainingTokens("k1", 300), 3);
  assert.strictEqual(limiter.getRemainingTokens("k1", 1200), 5);
});
