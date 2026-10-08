import test from "node:test";
import assert from "node:assert";
import { compareSemver } from "../src/semver.js";

test("Semver - basic major, minor, patch comparisons", () => {
  assert.strictEqual(compareSemver("1.0.0", "2.0.0"), -1);
  assert.strictEqual(compareSemver("2.0.0", "1.0.0"), 1);
  assert.strictEqual(compareSemver("1.2.0", "1.3.0"), -1);
  assert.strictEqual(compareSemver("1.2.3", "1.2.3"), 0);
  assert.strictEqual(compareSemver("1.2.4", "1.2.3"), 1);
});

test("Semver - pre-release has lower precedence than normal version", () => {
  assert.strictEqual(compareSemver("1.0.0-alpha", "1.0.0"), -1);
  assert.strictEqual(compareSemver("1.0.0", "1.0.0-rc.1"), 1);
  assert.strictEqual(compareSemver("1.0.0-beta", "1.0.0-beta"), 0);
});
