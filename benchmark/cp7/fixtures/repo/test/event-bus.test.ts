import test from "node:test";
import assert from "node:assert";
import { EventBus } from "../src/event-bus.js";

test("EventBus - exact topic subscription and delivery", async () => {
  const bus = new EventBus();
  const received: any[] = [];
  bus.subscribe("order.created", (payload) => {
    received.push(payload);
  });

  const count = await bus.publish("order.created", { id: "ord-123" });
  assert.strictEqual(count, 1);
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].id, "ord-123");
});

test("EventBus - exact topic unsubscribe", async () => {
  const bus = new EventBus();
  let count = 0;
  const sub = bus.subscribe("user.login", () => {
    count++;
  });

  await bus.publish("user.login", {});
  assert.strictEqual(count, 1);

  sub.unsubscribe();
  await bus.publish("user.login", {});
  assert.strictEqual(count, 1, "Should not receive events after unsubscribe");
});
