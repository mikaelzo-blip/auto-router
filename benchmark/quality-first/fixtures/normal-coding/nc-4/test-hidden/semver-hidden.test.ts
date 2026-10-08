import test from "node:test";
import assert from "node:assert";
import { compareSemver } from "../src/semver.js";

test("Hidden: Semver - numeric pre-release comparison is numerical not lexicographical", () => {
  // "2" vs "10": alphabetically "10" < "2", but semver numeric identifier 10 > 2!
  assert.strictEqual(compareSemver("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.strictEqual(compareSemver("1.0.0-beta.10", "1.0.0-beta.2"), 1);
});

test("Hidden: Semver - full semver spec 2.0.0 precedence chain", () => {
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0"
  ];

  for (let i = 0; i < chain.length - 1; i++) {
    const v1 = chain[i];
    const v2 = chain[i + 1];
    assert.strictEqual(
      compareSemver(v1, v2),
      -1,
      `Expected ${v1} < ${v2}`
    );
    assert.strictEqual(
      compareSemver(v2, v1),
      1,
      `Expected ${v2} > ${v1}`
    );
  }
});

test("Hidden: Semver - build metadata is ignored in precedence", () => {
  assert.strictEqual(compareSemver("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.strictEqual(compareSemver("1.0.0-alpha+001", "1.0.0-alpha+002"), 0);
});

test("Hidden: Semver - invalid semver string throws error", () => {
  assert.throws(() => compareSemver("invalid", "1.0.0"), /invalid/i);
  assert.throws(() => compareSemver("1.0", "1.0.0"), /invalid/i);
});
