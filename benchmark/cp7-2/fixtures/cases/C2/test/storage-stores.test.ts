import test from "node:test";
import assert from "node:assert";
import { MemoryStore } from "../src/storage/memory-store.js";
import { FileStore } from "../src/storage/file-store.js";

test("MemoryStore - basic set, get, delete operations", () => {
  const store = new MemoryStore<number>("test-mem");
  store.set("counter", 42);
  assert.strictEqual(store.get("counter"), 42);
  assert.strictEqual(store.has("counter"), true);
  assert.strictEqual(store.delete("counter"), true);
  assert.strictEqual(store.has("counter"), false);
});

test("FileStore - basic set, get, delete operations", () => {
  const store = new FileStore<string>("test-file");
  store.set("greeting", "hello world");
  assert.strictEqual(store.get("greeting"), "hello world");
  assert.strictEqual(store.has("greeting"), true);
  assert.strictEqual(store.delete("greeting"), true);
  assert.strictEqual(store.has("greeting"), false);
});

test("Store key validation - rejects keys with invalid characters", () => {
  const memStore = new MemoryStore("val-test");
  assert.throws(() => memStore.set("invalid key with spaces", 1), /Invalid key format/);

  const fileStore = new FileStore("val-test");
  assert.throws(() => fileStore.set("invalid/key/slash", 1), /Invalid key format/);
});
