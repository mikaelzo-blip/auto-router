import test from "node:test";
import assert from "node:assert";
import { OrderService } from "../src/order-service.js";
import type { OrderItem, OrderDiscount } from "../src/types.js";

test("Hidden: fixed discount exceeding subtotal caps discount at subtotal", () => {
  const service = new OrderService();
  const items: OrderItem[] = [
    { id: "1", name: "Notebook", unitPriceCents: 500, quantity: 1, category: "general" }
  ];
  const discount: OrderDiscount = { code: "MEGA50", type: "fixed_cents", value: 5000 };

  const res = service.calculate(items, discount);
  assert.strictEqual(res.subtotalCents, 500);
  assert.strictEqual(res.discountCents, 500, "Discount cannot exceed subtotal");
  assert.strictEqual(res.taxCents, 0);
  assert.strictEqual(res.totalCents, 0);
});

test("Hidden: throws error on zero or negative quantity", () => {
  const service = new OrderService();
  const items: OrderItem[] = [
    { id: "1", name: "BadItem", unitPriceCents: 500, quantity: -1, category: "general" }
  ];
  assert.throws(() => {
    service.calculate(items);
  }, /Invalid item quantity/);
});
