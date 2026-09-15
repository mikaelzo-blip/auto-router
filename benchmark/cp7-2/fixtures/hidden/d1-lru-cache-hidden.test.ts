import test from "node:test";
import assert from "node:assert";
import { LruCache } from "../src/cache/lru-cache.js";

test("Hidden: LruCache - continuous sequential eviction with 10 keys in cache of size 3", () => {
  const cache = new LruCache<number>(3);
  for (let i = 1; i <= 10; i++) {
    cache.set(`k${i}`, i);
  }

  assert.strictEqual(cache.size(), 3);
  assert.strictEqual(cache.get("k10"), 10);
  assert.strictEqual(cache.get("k9"), 9);
  assert.strictEqual(cache.get("k8"), 8);
  assert.strictEqual(cache.get("k7"), undefined);
  assert.strictEqual(cache.get("k1"), undefined);
});

test("Hidden: LruCache - update existing key refreshes recency without increasing size", () => {
  const cache = new LruCache<string>(2);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("a", "updated_1"); // update 'a'

  cache.set("c", "3"); // should evict 'b', not 'a'

  assert.strictEqual(cache.get("a"), "updated_1");
  assert.strictEqual(cache.get("c"), "3");
  assert.strictEqual(cache.get("b"), undefined);
});
