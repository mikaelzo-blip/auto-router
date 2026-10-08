import test from "node:test";
import assert from "node:assert";
import { LRUCacheWithTTL } from "../src/lru-ttl.js";

test("LRUCacheWithTTL - basic get and put", () => {
  const cache = new LRUCacheWithTTL<string, number>(2, 1000);
  cache.put("a", 1, 100);
  cache.put("b", 2, 200);

  assert.strictEqual(cache.get("a", 300), 1);
  assert.strictEqual(cache.get("b", 300), 2);
  assert.strictEqual(cache.get("c", 300), undefined);
});

test("LRUCacheWithTTL - evicts least recently used on capacity overflow", () => {
  const cache = new LRUCacheWithTTL<string, number>(2, 10000);
  cache.put("a", 1, 100);
  cache.put("b", 2, 200);
  cache.get("a", 300); // "a" accessed, so "b" is now LRU
  cache.put("c", 3, 400); // Should evict "b"

  assert.strictEqual(cache.get("a", 500), 1);
  assert.strictEqual(cache.get("b", 500), undefined);
  assert.strictEqual(cache.get("c", 500), 3);
});
