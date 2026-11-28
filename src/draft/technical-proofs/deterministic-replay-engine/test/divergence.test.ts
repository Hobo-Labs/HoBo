import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ReplayDivergenceError } from "../src/divergence.js";
import { assertReplayEqualsLive } from "../src/equivalence.js";
import type { EventEnvelope } from "../src/types.js";

describe("ReplayDivergenceError", () => {
  it("carries live/replay orders and parsed divergence digests", () => {
    const events: EventEnvelope[] = [
      { id: "b-1", streamId: "ticket-b", seq: 1, type: "x", data: {} },
      { id: "a-1", streamId: "ticket-a", seq: 1, type: "x", data: {} },
    ];

    try {
      assertReplayEqualsLive({
        events,
        // SAFETY: assertion to `initialState: { seen: [] as string[] },` is required at this boundary.
        initialState: { seen: [] as string[] },
        fold: (state, currentEvent) => ({
          seen: [...state.seen, `${currentEvent.streamId}:${currentEvent.seq}`],
        }),
        runId: "divergence-case",
      });
      assert.fail("expected divergence");
    } catch (error) {
      assert.ok(error instanceof ReplayDivergenceError);
      assert.equal(error.divergence.runId, "divergence-case");
      assert.ok(error.liveOrder.length > 0);
      assert.ok(error.replayOrder.length > 0);
      assert.notEqual(error.divergence.liveStateDigest, error.divergence.replayStateDigest);
      assert.match(error.divergence.liveStateDigest, /^[0-9a-f]{64}$/);
      assert.match(error.divergence.replayStateDigest, /^[0-9a-f]{64}$/);
    }
  });
});
