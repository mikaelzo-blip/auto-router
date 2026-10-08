import test from "node:test";
import assert from "node:assert";
import { allocateMoney } from "../src/money-allocator.js";

test("MoneyAllocator - basic even division", () => {
  const result = allocateMoney(100, [1, 1]);
  assert.deepStrictEqual(result, [50, 50]);
  assert.strictEqual(result.reduce((a, b) => a + b, 0), 100);
});

test("MoneyAllocator - basic proportional division", () => {
  const result = allocateMoney(100, [70, 30]);
  assert.deepStrictEqual(result, [70, 30]);
  assert.strictEqual(result.reduce((a, b) => a + b, 0), 100);
});

test("MoneyAllocator - zero total cents", () => {
  const result = allocateMoney(0, [1, 2, 3]);
  assert.deepStrictEqual(result, [0, 0, 0]);
});
