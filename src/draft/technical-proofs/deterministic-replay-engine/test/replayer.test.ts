import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { digest } from "../src/divergence.js";
import { createInMemoryEventStore } from "../src/store.js";
import { nextEnvelope, recordEffect } from "../src/recorder.js";
import { replayRun, type WorkflowDefinition } from "../src/replayer.js";

describe("replayRun", () => {
  it("replays a recorded workflow to byte-identical canonical state", async () => {
    const store = createInMemoryEventStore();
    const streamId = "run/run-1";
    const workflow: WorkflowDefinition<{ total: number }, { amount: number }> = {
      name: "adder",
      initialState: () => ({ total: 0 }),
      async execute(ctx, state, args) {
        const stepValue = await ctx.step("capture", () => args.amount);
        return { total: state.total + stepValue };
      },
    };

    await recordEffect(store, nextEnvelope(streamId, 1, "run.Started", { seed: "seed-1", args: { amount: 5 } }));
    await recordEffect(store, nextEnvelope(streamId, 2, "run.StepScheduled", { name: "capture", index: 0 }));
    await recordEffect(
      store,
      nextEnvelope(streamId, 3, "run.StepCompleted", { name: "capture", index: 0, result: 5 }),
    );

    const first = await replayRun(store, "run-1", workflow, { amount: 5 }, { seed: "seed-1" });
    const second = await replayRun(store, "run-1", workflow, { amount: 5 }, { seed: "seed-1" });

    assert.deepEqual(first.state, { total: 5 });
    assert.equal(first.report.stateDigest, second.report.stateDigest);
    assert.equal(first.report.readSetHash, second.report.readSetHash);
    assert.match(first.report.readSetHash, /^[0-9a-f]{64}$/);
    assert.equal(digest(first.state), first.report.stateDigest);
  });
});
