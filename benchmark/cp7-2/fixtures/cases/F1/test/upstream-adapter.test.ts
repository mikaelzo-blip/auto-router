import test from "node:test";
import assert from "node:assert";
import { UpstreamAdapter } from "../src/upstream/adapter.js";

test("UpstreamAdapter - successfully fetches resource using modern v2 client", async () => {
  const adapter = new UpstreamAdapter();
  const data = await adapter.getResource("123");

  assert.strictEqual(data.id, "res_123");
  assert.strictEqual(data.version, "v2", "Adapter must be updated to consume the v2 client data");
});

test("UpstreamAdapter - rejects with clean error when resource is not found (404)", async () => {
  const adapter = new UpstreamAdapter();
  await assert.rejects(
    async () => {
      await adapter.getResource("not-found");
    },
    /not found|404/i
  );
});
