import test from "node:test";
import assert from "node:assert";
import { BillingCalculator } from "../src/billing/calculator.js";

test("Hidden: BillingCalculator - non-taxable item proportion in tax calculation", () => {
  const calc = new BillingCalculator();
  const res = calc.calculateInvoice({
    items: [
      { id: "1", name: "Taxable Item", quantity: 1, unitPriceCents: 10000, taxable: true },
      { id: "2", name: "Non-Taxable Gift Card", quantity: 1, unitPriceCents: 5000, taxable: false }
    ],
    discountCode: "FLAT50", // 5000 cents discount
    taxRateBasisPoints: 1000 // 10%
  });

  assert.strictEqual(res.subtotalCents, 15000);
  assert.strictEqual(res.discountCents, 5000);
  // Discounted subtotal: 10000. Taxable ratio: 10000/15000 = 2/3. Effective taxable: 6667. Tax: 667.
  assert.strictEqual(res.taxCents, 667);
  assert.strictEqual(res.totalCents, 10667);
});

test("Hidden: BillingCalculator - empty items array handling", () => {
  const calc = new BillingCalculator();
  const res = calc.calculateInvoice({
    items: [],
    taxRateBasisPoints: 500
  });

  assert.strictEqual(res.subtotalCents, 0);
  assert.strictEqual(res.totalCents, 0);
});
