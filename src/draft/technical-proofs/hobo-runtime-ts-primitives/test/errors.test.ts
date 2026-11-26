import assert from "node:assert/strict";
import { test } from "vitest";

import { FatalError, RetryableError, step, testRuntime, workflow } from "../src/index.js";

test("FatalError short-circuits retries", async () => {
  const rt = testRuntime();
  let attempts = 0;

  const charge = step(async () => {
    attempts += 1;
    throw new FatalError("card declined");
  });

  const checkout = workflow("checkout-fatal", async () => {
    await charge();
    return { ok: true };
  });

  await assert.rejects(() => rt.start(checkout, []), FatalError);
  const log = await rt.eventLog({ runId: "run-1" });
  assert.equal(attempts, 1);
  assert.ok(log.some((event) => event.type === "run.StepFailed"));
});

test("RetryableError overrides retry budget", async () => {
  const rt = testRuntime();
  let attempts = 0;

  const flaky = step(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new RetryableError("transient", { retries: 5 });
    }
    return "ok";
  });

  const wf = workflow("retryable", async () => flaky());
  const run = await rt.start(wf, []);
  assert.equal(attempts, 3);
  assert.equal(await rt.state(run), "ok");
});

test("exhausted retries append run.StepFailed and rethrow", async () => {
  const rt = testRuntime();
  const fail = step(async () => {
    throw new Error("always fails");
  });
  const wf = workflow("exhaust", async () => fail());

  await assert.rejects(() => rt.start(wf, []), /always fails/);
  const log = await rt.eventLog({ runId: "run-1" });
  assert.ok(log.some((event) => event.type === "run.StepFailed"));
});
