import test from "node:test";
import assert from "node:assert";
import { TokenBucket } from "../src/token-bucket.js";

test("Hidden: TokenBucket - fractional accumulation precision", () => {
  const bucket = new TokenBucket(10, 0.5); // 0.5 tokens/sec
  assert.strictEqual(bucket.consume(10, 1000), true);
  assert.strictEqual(bucket.getTokens(1000), 0);

  // 1500ms elapsed -> 0.75 tokens
  assert.strictEqual(bucket.consume(1, 2500), false);
  // 2000ms elapsed -> 1.0 token
  assert.strictEqual(bucket.consume(1, 3000), true);
  assert.strictEqual(Math.round(bucket.getTokens(3000) * 100) / 100, 0);
});

test("Hidden: TokenBucket - capacity ceiling enforcement", () => {
  const bucket = new TokenBucket(5, 10); // 10 tokens/sec
  // 100 seconds later, tokens must be clamped to 5
  assert.strictEqual(bucket.getTokens(100000), 5);
});

test("Hidden: TokenBucket - clock skew / non-monotonic timestamps", () => {
  const bucket = new TokenBucket(10, 1);
  assert.strictEqual(bucket.consume(5, 5000), true);
  assert.strictEqual(bucket.getTokens(5000), 5);

  // Non-monotonic backward timestamp must not drain tokens or throw
  assert.strictEqual(bucket.consume(1, 4000), true);
  assert.strictEqual(bucket.getTokens(5000), 4);
});
