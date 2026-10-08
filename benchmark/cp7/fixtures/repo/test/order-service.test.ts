import test from "node:test";
import assert from "node:assert";
import { OrderService } from "../src/order-service.js";
import type { OrderItem, OrderDiscount } from "../src/types.js";

test("OrderService - empty order returns zeros", () => {
  const service = new OrderService();
  const res = service.calculate([]);
  assert.deepStrictEqual(res, {
    subtotalCents: 0,
    discountCents: 0,
    taxCents: 0,
    totalCents: 0,
    itemCount: 0
  });
});

test("OrderService - calculates subtotal and category taxes without discount", () => {
  const service = new OrderService();
  const items: OrderItem[] = [
    { id: "1", name: "Apple", unitPriceCents: 200, quantity: 5, category: "food" }, // 1000, tax 0
    { id: "2", name: "Shirt", unitPriceCents: 2000, quantity: 1, category: "clothing" }, // 2000, tax 5% = 100
    { id: "3", name: "Headphones", unitPriceCents: 10000, quantity: 1, category: "electronics" } // 10000, tax 15% = 1500
  ];

  const res = service.calculate(items);
  assert.strictEqual(res.subtotalCents, 13000);
  assert.strictEqual(res.discountCents, 0);
  assert.strictEqual(res.taxCents, 1600); // 100 + 1500
  assert.strictEqual(res.totalCents, 14600);
  assert.strictEqual(res.itemCount, 7);
});

test("OrderService - calculates percentage discount correctly", () => {
  const service = new OrderService();
  const items: OrderItem[] = [
    { id: "1", name: "Book", unitPriceCents: 1000, quantity: 2, category: "general" } // 2000
  ];
  const discount: OrderDiscount = { code: "SAVE10", type: "percentage", value: 10 };

  const res = service.calculate(items, discount);
  assert.strictEqual(res.subtotalCents, 2000);
  assert.strictEqual(res.discountCents, 200); // 10% of 2000
  // discounted subtotal = 1800, tax = 10% of 1800 = 180
  assert.strictEqual(res.taxCents, 180);
  assert.strictEqual(res.totalCents, 1980);
});
