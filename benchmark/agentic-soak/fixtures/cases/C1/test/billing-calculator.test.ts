import test from "node:test";
import assert from "node:assert";
import { BillingCalculator } from "../src/billing/calculator.js";

test("BillingCalculator - standard invoice without discount", () => {
  const calc = new BillingCalculator();
  const res = calc.calculateInvoice({
    items: [
      { id: "1", name: "Widget A", quantity: 2, unitPriceCents: 1000 },
      { id: "2", name: "Widget B", quantity: 1, unitPriceCents: 5000 }
    ],
    taxRateBasisPoints: 800 // 8%
  });

  assert.strictEqual(res.subtotalCents, 7000);
  assert.strictEqual(res.discountCents, 0);
  assert.strictEqual(res.taxCents, 560);
  assert.strictEqual(res.totalCents, 7560);
});

test("BillingCalculator - invoice with percentage discount", () => {
  const calc = new BillingCalculator();
  const res = calc.calculateInvoice({
    items: [
      { id: "1", name: "Service", quantity: 1, unitPriceCents: 10000 }
    ],
    discountCode: "SAVE25",
    taxRateBasisPoints: 1000 // 10%
  });

  assert.strictEqual(res.subtotalCents, 10000);
  assert.strictEqual(res.discountCents, 2500);
  assert.strictEqual(res.taxCents, 750);
  assert.strictEqual(res.totalCents, 8250);
});
