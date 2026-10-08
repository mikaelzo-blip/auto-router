import test from "node:test";
import assert from "node:assert";
import { CacheManager } from "../src/cache-manager.js";

test("Hidden: continuous sequential LRU eviction with 5 keys", () => {
  const cache = new CacheManager<number>(3);
  const now = 1000;

  cache.set("a", 1, undefined, now);
  cache.set("b", 2, undefined, now + 1);
  cache.set("c", 3, undefined, now + 2);

  // Access a
  cache.get("a", now + 3);

  // Add d -> should evict b (a was accessed, c was newer)
  cache.set("d", 4, undefined, now + 4);
  assert.strictEqual(cache.has("b"), false);
  assert.strictEqual(cache.get("a"), 1);
  assert.strictEqual(cache.get("c"), 3);
  assert.strictEqual(cache.get("d"), 4);

  // Add e -> should evict c (a was accessed, d was just added)
  cache.set("e", 5, undefined, now + 5);
  assert.strictEqual(cache.has("c"), false);
  assert.strictEqual(cache.get("a"), 1);
  assert.strictEqual(cache.get("d"), 4);
  assert.strictEqual(cache.get("e"), 5);
});
