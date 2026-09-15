import test from "node:test";
import assert from "node:assert";
import { ReservationLockManager } from "../src/concurrency/reservation-lock.js";

test("ReservationLock - basic sequential reservation", async () => {
  const manager = new ReservationLockManager();
  manager.setBalance("item-100", 10);

  const res1 = await manager.reserve("item-100", 4, "ik-seq-1");
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.remaining, 6);

  const res2 = await manager.reserve("item-100", 8, "ik-seq-2");
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.error, "INSUFFICIENT_BALANCE");
  assert.strictEqual(manager.getBalance("item-100"), 6);
});

test("ReservationLock - concurrent requests must not double-spend or over-allocate", async () => {
  const manager = new ReservationLockManager();
  // Available stock: exactly 10 units
  manager.setBalance("hot-sku", 10);

  // Fire two concurrent requests for 8 units each
  const p1 = manager.reserve("hot-sku", 8, "ik-conc-1");
  const p2 = manager.reserve("hot-sku", 8, "ik-conc-2");

  const [res1, res2] = await Promise.all([p1, p2]);

  // Exactly one request must succeed and the other must be rejected for insufficient balance
  const successCount = (res1.success ? 1 : 0) + (res2.success ? 1 : 0);
  assert.strictEqual(successCount, 1, "Only one concurrent request can win; no double allocation allowed");
  assert.strictEqual(manager.getBalance("hot-sku"), 2, "Remaining balance must be accurately deducted");
});
