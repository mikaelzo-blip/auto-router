import test from "node:test";
import assert from "node:assert";
import { EventBus } from "../src/event-bus.js";

test("Hidden: wildcard prefix pattern matching (order.*)", async () => {
  const bus = new EventBus();
  const events: string[] = [];

  bus.subscribe("order.*", (payload, topic) => {
    events.push(topic);
  });

  await bus.publish("order.created", { id: 1 });
  await bus.publish("order.updated", { id: 1 });
  await bus.publish("user.created", { id: 2 }); // Should NOT match

  assert.deepStrictEqual(events, ["order.created", "order.updated"]);
});

test("Hidden: wildcard suffix pattern matching (*.created)", async () => {
  const bus = new EventBus();
  const events: string[] = [];

  bus.subscribe("*.created", (payload, topic) => {
    events.push(topic);
  });

  await bus.publish("order.created", {});
  await bus.publish("user.created", {});
  await bus.publish("order.deleted", {}); // Should NOT match

  assert.deepStrictEqual(events, ["order.created", "user.created"]);
});

test("Hidden: wildcard unsubscribe", async () => {
  const bus = new EventBus();
  let calls = 0;

  const sub = bus.subscribe("payment.*", () => {
    calls++;
  });

  await bus.publish("payment.completed", {});
  assert.strictEqual(calls, 1);

  sub.unsubscribe();
  await bus.publish("payment.refunded", {});
  assert.strictEqual(calls, 1, "Unsubscribed wildcard must stop receiving");
});
