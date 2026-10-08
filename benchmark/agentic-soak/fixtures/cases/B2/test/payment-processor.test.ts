import test from "node:test";
import assert from "node:assert";
import { PaymentProcessor } from "../src/payments/processor.js";

test("PaymentProcessor - valid request produces SUCCESS response", () => {
  const processor = new PaymentProcessor();
  const res = processor.processPayment({
    idempotencyKey: "ik_101",
    amountCents: 2500,
    currency: "USD",
    recipientId: "rec_99"
  });

  assert.strictEqual(res.status, "SUCCESS");
  assert.strictEqual(res.idempotencyKey, "ik_101");
  assert.ok(res.transactionId, "Must generate a transactionId");
});

test("PaymentProcessor - rejects non-positive amount", () => {
  const processor = new PaymentProcessor();
  const res = processor.processPayment({
    idempotencyKey: "ik_102",
    amountCents: -50,
    currency: "USD",
    recipientId: "rec_99"
  });

  assert.strictEqual(res.status, "FAILED");
  assert.strictEqual(res.error, "INVALID_AMOUNT");
});

test("PaymentProcessor - rejects invalid currency code", () => {
  const processor = new PaymentProcessor();
  const res = processor.processPayment({
    idempotencyKey: "ik_103",
    amountCents: 1000,
    currency: "dollars", // Invalid: must be 3-letter ISO code like USD, EUR, GBP
    recipientId: "rec_99"
  });

  assert.strictEqual(res.status, "FAILED");
  assert.strictEqual(res.error, "INVALID_CURRENCY");
});
