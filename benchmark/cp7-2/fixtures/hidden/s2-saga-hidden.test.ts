import test from "node:test";
import assert from "node:assert";
import { FulfillmentSaga } from "../src/saga.js";

test("Hidden: FulfillmentSaga - delivery failure compensates both payment and inventory", async () => {
  const saga = new FulfillmentSaga();
  const res = await saga.execute({
    id: "ord_remote", // triggers delivery failure
    sku: "widget_pro",
    quantity: 4,
    amountCents: 8000,
    status: "PENDING"
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, "DELIVERY_UNAVAILABLE");
  // Both steps must be compensated!
  assert.strictEqual(saga.inventory.get("widget_pro"), 10, "Inventory must be restored on delivery failure");
  assert.strictEqual(saga.payments.has("ord_remote"), false, "Payment must be refunded/removed on delivery failure");
});

test("Hidden: FulfillmentSaga - out of stock fails fast without charging or dispatching", async () => {
  const saga = new FulfillmentSaga();
  const res = await saga.execute({
    id: "ord_too_many",
    sku: "widget_pro",
    quantity: 50,
    amountCents: 100000,
    status: "PENDING"
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, "OUT_OF_STOCK");
  assert.strictEqual(saga.inventory.get("widget_pro"), 10);
  assert.strictEqual(saga.payments.size, 0);
  assert.strictEqual(saga.deliveryDispatches.size, 0);
});
