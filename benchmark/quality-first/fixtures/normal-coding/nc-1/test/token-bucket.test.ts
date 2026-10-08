import test from "node:test";
import assert from "node:assert";
import { TokenBucket } from "../src/token-bucket.js";

test("TokenBucket - basic consumption within capacity", () => {
  const bucket = new TokenBucket(10, 1);
  assert.strictEqual(bucket.getTokens(1000), 10);
  assert.strictEqual(bucket.consume(4, 1000), true);
  assert.strictEqual(bucket.getTokens(1000), 6);
});

test("TokenBucket - rejects consumption when exceeding available tokens", () => {
  const bucket = new TokenBucket(5, 1);
  assert.strictEqual(bucket.consume(6, 1000), false);
  assert.strictEqual(bucket.getTokens(1000), 5); // Unchanged
});

test("TokenBucket - refills tokens based on elapsed time", () => {
  const bucket = new TokenBucket(10, 2); // 2 tokens/sec
  assert.strictEqual(bucket.consume(10, 1000), true);
  assert.strictEqual(bucket.getTokens(1000), 0);

  // After 2 seconds (2000ms), 4 tokens should be refilled
  assert.strictEqual(bucket.getTokens(3000), 4);
  assert.strictEqual(bucket.consume(3, 3000), true);
  assert.strictEqual(bucket.getTokens(3000), 1);
});
