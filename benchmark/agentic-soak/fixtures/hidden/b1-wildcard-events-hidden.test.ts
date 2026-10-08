import test from "node:test";
import assert from "node:assert";
import { EventBus } from "../src/events/event-bus.js";

test("Hidden: EventBus - wildcard unsubscribe only removes target listener", () => {
  const bus = new EventBus();
  const sub1Hits: string[] = [];
  const sub2Hits: string[] = [];

  const sub1 = bus.subscribe("metric.*", (e) => sub1Hits.push(e.topic));
  const sub2 = bus.subscribe("metric.*", (e) => sub2Hits.push(e.topic));

  bus.publish({ topic: "metric.cpu", payload: 1, timestamp: Date.now() });
  assert.strictEqual(sub1Hits.length, 1);
  assert.strictEqual(sub2Hits.length, 1);

  sub1.unsubscribe();

  bus.publish({ topic: "metric.memory", payload: 2, timestamp: Date.now() });
  assert.strictEqual(sub1Hits.length, 1, "Unsubscribed listener must receive no further events");
  assert.strictEqual(sub2Hits.length, 2, "Remaining listener must receive subsequent events");
});

test("Hidden: EventBus - single wildcard does not cross multiple segments", () => {
  const bus = new EventBus();
  const received: string[] = [];

  bus.subscribe("a.*.c", (e) => received.push(e.topic));

  bus.publish({ topic: "a.b.c", payload: 1, timestamp: Date.now() });
  bus.publish({ topic: "a.b.d.c", payload: 2, timestamp: Date.now() });

  assert.deepStrictEqual(received, ["a.b.c"], "* must not match multi-segment path");
});
