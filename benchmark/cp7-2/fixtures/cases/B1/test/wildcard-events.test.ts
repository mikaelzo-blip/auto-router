import test from "node:test";
import assert from "node:assert";
import { EventBus } from "../src/events/event-bus.js";

test("EventBus - exact topic subscription", () => {
  const bus = new EventBus();
  const received: string[] = [];

  bus.subscribe("order.created", (e) => {
    received.push(e.payload);
  });

  bus.publish({ topic: "order.created", payload: "item-1", timestamp: Date.now() });
  bus.publish({ topic: "order.updated", payload: "item-2", timestamp: Date.now() });

  assert.deepStrictEqual(received, ["item-1"]);
});

test("EventBus - single-level wildcard subscription (*)", () => {
  const bus = new EventBus();
  const received: string[] = [];

  bus.subscribe("order.*", (e) => {
    received.push(e.payload);
  });

  bus.publish({ topic: "order.created", payload: "p1", timestamp: Date.now() });
  bus.publish({ topic: "order.cancelled", payload: "p2", timestamp: Date.now() });
  bus.publish({ topic: "user.created", payload: "p3", timestamp: Date.now() });

  assert.deepStrictEqual(received, ["p1", "p2"], "Wildcard order.* should match order.created and order.cancelled");
});

test("EventBus - multi-level wildcard subscription (#)", () => {
  const bus = new EventBus();
  const received: string[] = [];

  bus.subscribe("audit.#", (e) => {
    received.push(e.topic);
  });

  bus.publish({ topic: "audit.user.login", payload: 1, timestamp: Date.now() });
  bus.publish({ topic: "audit.billing.invoice.paid", payload: 2, timestamp: Date.now() });
  bus.publish({ topic: "metrics.cpu", payload: 3, timestamp: Date.now() });

  assert.deepStrictEqual(received, ["audit.user.login", "audit.billing.invoice.paid"]);
});
