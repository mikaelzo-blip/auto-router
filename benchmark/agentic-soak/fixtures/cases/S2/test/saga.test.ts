import test from "node:test";
import assert from "node:assert";
import { FulfillmentSaga } from "../src/saga.js";

test("FulfillmentSaga - successful order confirms all steps", async () => {
  const saga = new FulfillmentSaga();
  const res = await saga.execute({
    id: "ord_1",
    sku: "widget_pro",
    quantity: 2,
    amountCents: 5000,
    status: "PENDING"
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(saga.inventory.get("widget_pro"), 8);
  assert.strictEqual(saga.payments.get("ord_1"), 5000);
  assert.strictEqual(saga.deliveryDispatches.has("ord_1"), true);
});

test("FulfillmentSaga - payment failure triggers compensating inventory rollback", async () => {
  const saga = new FulfillmentSaga();
  const res = await saga.execute({
    id: "ord_fail_pay",
    sku: "widget_pro",
    quantity: 3,
    amountCents: 9999, // triggers payment failure
    status: "PENDING"
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, "PAYMENT_DECLINED");
  // CRITICAL COMPENSATING TRANSACTION: Inventory must be rolled back to 10!
  assert.strictEqual(saga.inventory.get("widget_pro"), 10, "Inventory must be restored when payment fails");
  assert.strictEqual(saga.payments.has("ord_fail_pay"), false);
});
