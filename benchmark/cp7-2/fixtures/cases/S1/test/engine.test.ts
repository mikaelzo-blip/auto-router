import test from "node:test";
import assert from "node:assert";
import { TransactionEngine } from "../src/engine.js";

test("TransactionEngine - successful transfer updates balances and writes ledger", () => {
  const engine = new TransactionEngine();
  engine.createAccount("acc_1", 10000);
  engine.createAccount("acc_2", 2000);

  const res = engine.transfer("acc_1", "acc_2", 2500);
  assert.strictEqual(res.success, true);
  assert.strictEqual(engine.getAccount("acc_1")?.balanceCents, 7500);
  assert.strictEqual(engine.getAccount("acc_2")?.balanceCents, 4500);
  assert.strictEqual(engine.getLedger().length, 1);
});

test("TransactionEngine - atomic rollback when ledger write fails", () => {
  const engine = new TransactionEngine();
  engine.createAccount("acc_a", 10000);
  engine.createAccount("acc_b", 2000);

  // Amount 199 triggers ledger write failure
  assert.throws(
    () => engine.transfer("acc_a", "acc_b", 199),
    /Ledger storage write rejected/
  );

  // Balances MUST be untouched (rollback)
  assert.strictEqual(engine.getAccount("acc_a")?.balanceCents, 10000, "Sender balance must not mutate on failure");
  assert.strictEqual(engine.getAccount("acc_b")?.balanceCents, 2000, "Receiver balance must not mutate on failure");
  assert.strictEqual(engine.getLedger().length, 0);
});
