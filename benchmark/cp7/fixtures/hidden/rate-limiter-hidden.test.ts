import test from "node:test";
import assert from "node:assert";
import { SlidingWindowRateLimiter } from "../src/rate-limiter.js";

test("Hidden: multi-key isolation", () => {
  const limiter = new SlidingWindowRateLimiter(1000, 2);
  const now = 10000;
  assert.strictEqual(limiter.isAllowed("userA", now), true);
  assert.strictEqual(limiter.isAllowed("userA", now + 10), true);
  assert.strictEqual(limiter.isAllowed("userA", now + 20), false);

  // userB has fresh limit
  assert.strictEqual(limiter.isAllowed("userB", now + 20), true);
  assert.strictEqual(limiter.isAllowed("userB", now + 30), true);
  assert.strictEqual(limiter.isAllowed("userB", now + 40), false);
});

test("Hidden: sliding window rolling burst recovery", () => {
  const limiter = new SlidingWindowRateLimiter(500, 3);
  let t = 20000;
  assert.strictEqual(limiter.isAllowed("u", t), true);
  assert.strictEqual(limiter.isAllowed("u", t + 100), true);
  assert.strictEqual(limiter.isAllowed("u", t + 200), true);
  assert.strictEqual(limiter.isAllowed("u", t + 300), false);

  // Advance past first timestamp (20000 + 500 = 20500)
  t = 20501;
  assert.strictEqual(limiter.isAllowed("u", t), true, "first slot must have expired");
  assert.strictEqual(limiter.isAllowed("u", t + 10), false, "still 3 requests in [20100, 20511]");
});
