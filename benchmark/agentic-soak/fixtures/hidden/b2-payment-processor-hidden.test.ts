import test from "node:test";
import assert from "node:assert";
import { PaymentProcessor } from "../src/payments/processor.js";

test("Hidden: PaymentProcessor - duplicate idempotencyKey returns cached response without duplicate execution", () => {
  const processor = new PaymentProcessor();
  const req = {
    idempotencyKey: "ik_replay_1",
    amountCents: 5000,
    currency: "USD",
    recipientId: "rec_replay"
  };

  const first = processor.processPayment(req);
  assert.strictEqual(first.status, "SUCCESS");

  const second = processor.processPayment(req);
  assert.strictEqual(second.status, "SUCCESS");
  assert.strictEqual(second.transactionId, first.transactionId, "Replay must return original transactionId");
});

test("Hidden: PaymentProcessor - missing recipientId returns MISSING_RECIPIENT", () => {
  const processor = new PaymentProcessor();
  const res = processor.processPayment({
    idempotencyKey: "ik_no_rec",
    amountCents: 1000,
    currency: "EUR",
    recipientId: "   " // blank/empty
  });

  assert.strictEqual(res.status, "FAILED");
  assert.strictEqual(res.error, "MISSING_RECIPIENT");
});
