import test from "node:test";
import assert from "node:assert";
import { CacheManager } from "../src/cache-manager.js";

test("CacheManager - basic set and get", () => {
  const cache = new CacheManager<number>(3);
  cache.set("x", 100);
  assert.strictEqual(cache.get("x"), 100);
  assert.strictEqual(cache.has("x"), true);
});

test("CacheManager - TTL expiration", () => {
  const cache = new CacheManager<string>(5, 1000);
  const now = 5000;
  cache.set("temp", "hello", 500, now);
  assert.strictEqual(cache.get("temp", now + 200), "hello");
  assert.strictEqual(cache.get("temp", now + 600), undefined);
});

test("CacheManager - LRU eviction respects access order", () => {
  const cache = new CacheManager<string>(2);
  const now = 10000;

  cache.set("item1", "first", undefined, now);
  cache.set("item2", "second", undefined, now + 10);

  // Access item1 to make item1 more recently used than item2
  assert.strictEqual(cache.get("item1", now + 20), "first");

  // Insert item3. item2 is the least recently used and MUST be evicted!
  cache.set("item3", "third", undefined, now + 30);

  assert.strictEqual(cache.get("item1", now + 40), "first", "item1 was accessed recently and must NOT be evicted");
  assert.strictEqual(cache.get("item3", now + 40), "third", "item3 was just inserted and must exist");
  assert.strictEqual(cache.get("item2", now + 40), undefined, "item2 was LRU and must be evicted");
  assert.strictEqual(cache.size(), 2);
});
