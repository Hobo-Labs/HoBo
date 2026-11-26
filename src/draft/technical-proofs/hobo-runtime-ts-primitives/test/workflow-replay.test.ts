import assert from "node:assert/strict";
import { test } from "vitest";

import { step, sleep, testRuntime, workflow } from "../src/index.js";

test("replay-equals-live for completed workflow", async () => {
  const rt = testRuntime();
  const add = step(async (a: number, b: number) => a + b);
  const wf = workflow("sum", async (a: number, b: number) => add(a, b));
  const run = await rt.start(wf, [2, 3]);
  assert.equal(await rt.state(run), 5);
  assert.equal(await rt.replay(run), 5);
});

test("mid-run restart replays memoized steps without re-executing side effects", async () => {
  const rt = testRuntime();
  const sideEffect = step(async () => {
    rt.incrementSideEffect();
    return "charged";
  }, { idempotencyKey: "charge-once" });
  const wf = workflow("charge-once", async () => sideEffect());

  const run = await rt.start(wf, []);
  assert.equal(rt.getSideEffectCounter(), 1);
  await rt.reruns(run);
  assert.equal(rt.getSideEffectCounter(), 1);
  assert.equal(await rt.state(run), "charged");
});

test("sleep survives clock advance and fires exactly once", async () => {
  const rt = testRuntime();
  let woke = 0;
  const wf = workflow("sleep-once", async () => {
    await sleep("100ms");
    woke += 1;
    return woke;
  });

  const run = await rt.start(wf, []);
  assert.equal(woke, 0);
  rt.clock.advance("100ms");
  await rt.continueRun(run);
  assert.equal(await rt.state(run), 1);
  assert.equal(woke, 1);

  const log = await rt.eventLog(run);
  const sleeps = log.filter((event) => event.type === "run.SleepScheduled");
  assert.equal(sleeps.length, 1);
});
