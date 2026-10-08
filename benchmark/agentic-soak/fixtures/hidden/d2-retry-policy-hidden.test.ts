import test from "node:test";
import assert from "node:assert";
import { RetryPolicy, AppError } from "../src/resilience/retry-policy.js";

test("Hidden: RetryPolicy - fails fast on unretryable 4xx client errors without retry loop", async () => {
  const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 50 });
  let attempts = 0;

  await assert.rejects(
    async () => {
      await policy.execute(async () => {
        attempts++;
        throw new AppError("Invalid authentication credentials", 401, false);
      });
    },
    (err: any) => err.statusCode === 401
  );

  assert.strictEqual(attempts, 1, "Unretryable error must abort immediately on attempt 1");
});

test("Hidden: RetryPolicy - retries 429 quota errors", async () => {
  const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 50 });
  let attempts = 0;

  const res = await policy.execute(async () => {
    attempts++;
    if (attempts < 2) {
      throw new AppError("Rate limited", 429, true);
    }
    return "rate-limit-passed";
  });

  assert.strictEqual(res, "rate-limit-passed");
  assert.strictEqual(attempts, 2);
});
