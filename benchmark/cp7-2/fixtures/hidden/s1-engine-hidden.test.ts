import test from "node:test";
import assert from "node:assert";
import { TransactionEngine } from "../src/engine.js";

test("Hidden: TransactionEngine - insufficient funds does not create ledger entries", () => {
  const engine = new TransactionEngine();
  engine.createAccount("acc_x", 100);
  engine.createAccount("acc_y", 100);

  const res = engine.transfer("acc_x", "acc_y", 500);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, "INSUFFICIENT_FUNDS");
  assert.strictEqual(engine.getLedger().length, 0);
});

test("Hidden: TransactionEngine - consecutive transfers preserve conservation of money", () => {
  const engine = new TransactionEngine();
  engine.createAccount("a1", 1000);
  engine.createAccount("a2", 1000);

  engine.transfer("a1", "a2", 100);
  engine.transfer("a2", "a1", 50);

  const total = (engine.getAccount("a1")?.balanceCents ?? 0) + (engine.getAccount("a2")?.balanceCents ?? 0);
  assert.strictEqual(total, 2000, "Total system balance must remain conserved");
});
