import test from "node:test";
import assert from "node:assert";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { createInitialContext } from "../src/pipeline/context.js";

test("Pipeline - executes sequential steps modifying context", async () => {
  const pipeline = new Pipeline();
  pipeline
    .addStep({
      name: "step-1",
      execute: (ctx) => ({ ...ctx, data: { ...ctx.data, a: 1 } })
    })
    .addStep({
      name: "step-2",
      execute: (ctx) => ({ ...ctx, data: { ...ctx.data, b: ctx.data.a + 10 } })
    });

  const res = await pipeline.run(createInitialContext());
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.finalContext.data.a, 1);
  assert.strictEqual(res.finalContext.data.b, 11);
  assert.strictEqual(res.errors.length, 0);
});

test("Pipeline - stopOnError: true halts pipeline immediately when step fails", async () => {
  const pipeline = new Pipeline({ stopOnError: true });
  let step3Executed = false;

  pipeline
    .addStep({
      name: "step-1",
      execute: (ctx) => ({ ...ctx, data: { step1: "done" } })
    })
    .addStep({
      name: "step-2-failing",
      execute: () => { throw new Error("Step 2 failed deliberately"); }
    })
    .addStep({
      name: "step-3",
      execute: (ctx) => {
        step3Executed = true;
        return ctx;
      }
    });

  const res = await pipeline.run(createInitialContext());
  assert.strictEqual(res.success, false);
  assert.strictEqual(step3Executed, false, "Subsequent steps must not run when stopOnError is true");
  assert.strictEqual(res.errors.length, 1);
  assert.match(res.errors[0]!, /Step 2 failed/);
});
