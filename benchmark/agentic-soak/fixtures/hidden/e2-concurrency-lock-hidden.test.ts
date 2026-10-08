import test from "node:test";
import assert from "node:assert";
import { ReservationLockManager } from "../src/concurrency/reservation-lock.js";

test("Hidden: ReservationLock - idempotency replay with same key returns identical reservation without extra deduction", async () => {
  const manager = new ReservationLockManager();
  manager.setBalance("idemp-sku", 100);

  const first = await manager.reserve("idemp-sku", 20, "ik-unique-key");
  assert.strictEqual(first.success, true);
  assert.strictEqual(first.remaining, 80);

  // Replay request with exact same idempotency key
  const replay = await manager.reserve("idemp-sku", 20, "ik-unique-key");
  assert.strictEqual(replay.success, true);
  assert.strictEqual(replay.reservationId, first.reservationId, "Idempotent replay must return exact same reservationId");
  assert.strictEqual(manager.getBalance("idemp-sku"), 80, "Idempotent replay must NOT deduct balance a second time");
});

test("Hidden: ReservationLock - high concurrency stress (10 concurrent requests competing for 3 slots)", async () => {
  const manager = new ReservationLockManager();
  manager.setBalance("stress-sku", 3);

  const promises = Array.from({ length: 10 }, (_, i) =>
    manager.reserve("stress-sku", 1, `ik-stress-${i}`)
  );

  const results = await Promise.all(promises);
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);

  assert.strictEqual(successes.length, 3, "Exactly 3 requests should succeed");
  assert.strictEqual(failures.length, 7, "Remaining 7 requests should fail");
  assert.strictEqual(manager.getBalance("stress-sku"), 0);
});
