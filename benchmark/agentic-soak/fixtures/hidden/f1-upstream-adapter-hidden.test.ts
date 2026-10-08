import test from "node:test";
import assert from "node:assert";
import { UpstreamAdapter } from "../src/upstream/adapter.js";

test("Hidden: UpstreamAdapter - network failure propagates descriptive error", async () => {
  const adapter = new UpstreamAdapter();
  await assert.rejects(
    async () => {
      await adapter.getResource("error");
    },
    /network|connection/i
  );
});

test("Hidden: UpstreamAdapter - preserves returned resource object identity and payload structure", async () => {
  const adapter = new UpstreamAdapter();
  const res = await adapter.getResource("123");
  assert.strictEqual(typeof res, "object");
  assert.strictEqual(res.name, "Resource A");
});
