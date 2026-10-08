import test from "node:test";
import assert from "node:assert";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { createInitialContext } from "../src/pipeline/context.js";

test("Hidden: Pipeline - stopOnError: false continues executing remaining steps and aggregates errors", async () => {
  const pipeline = new Pipeline({ stopOnError: false });
  let step3Executed = false;

  pipeline
    .addStep({
      name: "step-1",
      execute: (ctx) => ({ ...ctx, data: { ...ctx.data, s1: "ok" } })
    })
    .addStep({
      name: "step-2-failing",
      execute: () => { throw new Error("Step 2 non-fatal error"); }
    })
    .addStep({
      name: "step-3",
      execute: (ctx) => {
        step3Executed = true;
        return { ...ctx, data: { ...ctx.data, s3: "ok" } };
      }
    });

  const res = await pipeline.run(createInitialContext());
  assert.strictEqual(res.success, false, "Pipeline overall should report false if any step errored");
  assert.strictEqual(step3Executed, true, "Step 3 must execute when stopOnError is false");
  assert.strictEqual(res.finalContext.data.s1, "ok");
  assert.strictEqual(res.finalContext.data.s3, "ok");
  assert.strictEqual(res.errors.length, 1);
});

test("Hidden: Pipeline - empty pipeline returns success with unchanged context", async () => {
  const pipeline = new Pipeline();
  const initial = createInitialContext({ testVal: 99 });
  const res = await pipeline.run(initial);

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.finalContext.data.testVal, 99);
  assert.strictEqual(res.errors.length, 0);
});
