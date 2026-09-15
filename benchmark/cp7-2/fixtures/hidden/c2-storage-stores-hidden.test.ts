import test from "node:test";
import assert from "node:assert";
import { MemoryStore } from "../src/storage/memory-store.js";
import { FileStore } from "../src/storage/file-store.js";

test("Hidden: Store TTL expiration across both stores", () => {
  const memStore = new MemoryStore<string>("ttl-test");
  const fileStore = new FileStore<string>("ttl-test");

  memStore.set("k1", "v1", 50); // 50ms TTL
  fileStore.set("k2", "v2", 50);

  assert.strictEqual(memStore.get("k1"), "v1");
  assert.strictEqual(fileStore.get("k2"), "v2");

  // Wait 70ms for expiration
  const start = Date.now();
  while (Date.now() - start < 70) {
    // spin
  }

  assert.strictEqual(memStore.get("k1"), undefined, "Expired memory item must return undefined");
  assert.strictEqual(fileStore.get("k2"), undefined, "Expired file item must return undefined");
});

test("Hidden: Store namespace isolation", () => {
  const s1 = new MemoryStore("ns1");
  const s2 = new MemoryStore("ns2");

  s1.set("shared-key", "value1");
  s2.set("shared-key", "value2");

  assert.strictEqual(s1.get("shared-key"), "value1");
  assert.strictEqual(s2.get("shared-key"), "value2");
});
