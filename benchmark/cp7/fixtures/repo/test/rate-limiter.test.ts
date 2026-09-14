import test from "node:test";
import assert from "node:assert";
import { SlidingWindowRateLimiter } from "../src/rate-limiter.js";

test("SlidingWindowRateLimiter - allows requests up to limit", () => {
  const limiter = new SlidingWindowRateLimiter(1000, 3);
  const now = 10000;
  assert.strictEqual(limiter.isAllowed("user1", now), true);
  assert.strictEqual(limiter.isAllowed("user1", now + 100), true);
  assert.strictEqual(limiter.isAllowed("user1", now + 200), true);
  assert.strictEqual(limiter.isAllowed("user1", now + 300), false);
});

test("SlidingWindowRateLimiter - boundary expiration allows new requests", () => {
  const limiter = new SlidingWindowRateLimiter(1000, 2);
  const t0 = 10000;
  assert.strictEqual(limiter.isAllowed("user1", t0), true);
  assert.strictEqual(limiter.isAllowed("user1", t0 + 200), true);
  assert.strictEqual(limiter.isAllowed("user1", t0 + 400), false);

  // Exact window boundary: t0 + 1000. The first request was at t0.
  // At t0 + 1000, the duration is exactly 1000ms. A 1000ms window covers (now - 1000, now].
  // Therefore the request at t0 is expired and a new request at t0 + 1000 must be allowed!
  assert.strictEqual(limiter.isAllowed("user1", t0 + 1000), true, "Request at exact boundary should be allowed");
});

test("SlidingWindowRateLimiter - remaining requests calculation", () => {
  const limiter = new SlidingWindowRateLimiter(1000, 5);
  const now = 50000;
  assert.strictEqual(limiter.getRemainingRequests("user1", now), 5);
  limiter.isAllowed("user1", now);
  limiter.isAllowed("user1", now + 10);
  assert.strictEqual(limiter.getRemainingRequests("user1", now + 20), 3);
});
