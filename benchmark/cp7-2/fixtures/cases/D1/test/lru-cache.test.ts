import test from "node:test";
import assert from "node:assert";
import { LruCache } from "../src/cache/lru-cache.js";

test("LruCache - basic set and get", () => {
  const cache = new LruCache<string>(3);
  cache.set("a", "alpha");
  assert.strictEqual(cache.get("a"), "alpha");
});

test("LruCache - eviction removes ONLY the least recently used item", () => {
  const cache = new LruCache<string>(2);
  cache.set("item1", "first");
  cache.set("item2", "second");

  // Access item1 to make it more recently used than item2
  cache.get("item1");

  // Insert item3. item2 MUST be evicted because it was least recently used!
  cache.set("item3", "third");

  assert.strictEqual(cache.get("item1"), "first", "item1 was recently accessed and must not be evicted");
  assert.strictEqual(cache.get("item3"), "third", "item3 was just added and must exist");
  assert.strictEqual(cache.get("item2"), undefined, "item2 was LRU and must be evicted");
  assert.strictEqual(cache.size(), 2);
});
