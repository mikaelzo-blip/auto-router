import test from "node:test";
import assert from "node:assert";
import { LRUCacheWithTTL } from "../src/lru-ttl.js";

test("Hidden: LRUCacheWithTTL - expired entry returns undefined and purges", () => {
  const cache = new LRUCacheWithTTL<string, number>(3, 500);
  cache.put("a", 10, 1000);

  // Still valid at t=1400 (age 400 < 500)
  assert.strictEqual(cache.get("a", 1400), 10);

  // Expired at t=1600 (age 600 > 500)
  assert.strictEqual(cache.get("a", 1600), undefined);
  assert.strictEqual(cache.size(1600), 0);
});

test("Hidden: LRUCacheWithTTL - evicts expired item before evicting valid LRU item", () => {
  const cache = new LRUCacheWithTTL<string, number>(2, 500);
  cache.put("valid", 1, 1000);   // Age at 1600: 600ms -> expired
  cache.put("fresh", 2, 1400);   // Age at 1600: 200ms -> valid

  // At t=1600, "valid" is expired, "fresh" is valid.
  // We insert a new key "newKey" at t=1600.
  // The cache must evict "valid" (expired) instead of "fresh" (valid).
  cache.put("newKey", 3, 1600);

  assert.strictEqual(cache.get("valid", 1600), undefined);
  assert.strictEqual(cache.get("fresh", 1600), 2);
  assert.strictEqual(cache.get("newKey", 1600), 3);
});

test("Hidden: LRUCacheWithTTL - updating existing key resets TTL and updates value", () => {
  const cache = new LRUCacheWithTTL<string, number>(2, 500);
  cache.put("k1", 100, 1000);
  // Update at t=1300
  cache.put("k1", 200, 1300);

  // At t=1600, age from update is 300ms <= 500ms, so still valid!
  assert.strictEqual(cache.get("k1", 1600), 200);
  // At t=1900, age is 600ms > 500ms, so expired
  assert.strictEqual(cache.get("k1", 1900), undefined);
});
