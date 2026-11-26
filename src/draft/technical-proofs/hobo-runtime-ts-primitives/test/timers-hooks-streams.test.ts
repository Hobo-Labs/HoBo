import assert from "node:assert/strict";
import { test } from "vitest";

import { createHook, getWritable, sleep, step, testRuntime, workflow } from "../src/index.js";

test("hooks and streams append catalog events", async () => {
  const rt = testRuntime();
  const record = step(async () => "payload");
  const wf = workflow("hooks-streams", async () => {
    const hook = createHook<string>("approval");
    const writable = getWritable<string>();
    const writer = writable.getWriter();
    await writer.write("chunk-1");
    await writer.close();
    await sleep("1ms");
    const value = await hook.wait();
    await record();
    return value;
  });

  const run = await rt.start(wf, []);
  rt.clock.advance("1ms");
  await rt.continueRun(run);
  await rt.resumeHook(run, "approved");
  assert.equal(await rt.state(run), "approved");

  const log = await rt.eventLog(run);
  const types = log.map((event) => event.type);
  assert.ok(types.includes("run.HookCreated"), "expected run.HookCreated");
  assert.ok(types.includes("run.HookResumed"), "expected run.HookResumed");
  assert.ok(types.includes("run.SleepScheduled"), "expected run.SleepScheduled");
  assert.ok(types.includes("run.StepCompleted"), "expected run.StepCompleted");
});
