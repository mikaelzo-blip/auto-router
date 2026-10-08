import test from "node:test";
import assert from "node:assert";
import { RetryPolicy } from "../src/resilience/retry-policy.js";

test("RetryPolicy - succeeds on first attempt without retrying", async () => {
  const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });
  let attempts = 0;

  const result = await policy.execute(async (att) => {
    attempts++;
    return "ok";
  });

  assert.strictEqual(result, "ok");
  assert.strictEqual(attempts, 1);
});

test("RetryPolicy - retries on transient failure and recovers", async () => {
  const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 50 });
  let attempts = 0;

  const result = await policy.execute(async (att) => {
    attempts++;
    if (attempts < 2) {
      throw new Error("Temporary network timeout");
    }
    return "recovered";
  });

  assert.strictEqual(result, "recovered");
  assert.strictEqual(attempts, 2);
});
