import test from "node:test";
import assert from "node:assert";
import { allocateMoney } from "../src/money-allocator.js";

test("Hidden: MoneyAllocator - exact penny conservation with repeating fractions", () => {
  const result = allocateMoney(100, [1, 1, 1]);
  assert.strictEqual(result.reduce((a, b) => a + b, 0), 100);
  assert.deepStrictEqual(result, [34, 33, 33]);
});

test("Hidden: MoneyAllocator - single penny distributed to highest remainder", () => {
  const result = allocateMoney(1, [1, 1, 1]);
  assert.strictEqual(result.reduce((a, b) => a + b, 0), 1);
  assert.deepStrictEqual(result, [1, 0, 0]);
});

test("Hidden: MoneyAllocator - asymmetric remainder allocation", () => {
  // 5 cents split across ratios [3, 3, 4] -> sum 10.
  // unrounded: [1.5, 1.5, 2.0]
  // base: [1, 1, 2], rem: [0.5, 0.5, 0.0]
  // remainder cents = 5 - 4 = 1 cent.
  // First item gets the remainder cent: [2, 1, 2]
  const result = allocateMoney(5, [3, 3, 4]);
  assert.strictEqual(result.reduce((a, b) => a + b, 0), 5);
  assert.deepStrictEqual(result, [2, 1, 2]);
});

test("Hidden: MoneyAllocator - validates input constraints", () => {
  assert.throws(() => allocateMoney(-10, [1, 2]), /non-negative/i);
  assert.throws(() => allocateMoney(100, []), /empty/i);
  assert.throws(() => allocateMoney(100, [-1, 2]), /non-negative/i);
  assert.throws(() => allocateMoney(100, [0, 0]), /positive/i);
});
