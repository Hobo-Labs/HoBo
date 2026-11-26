import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertMutatedFireFactRejects,
  assertSeedMismatchRejects,
  runTimeTravelReplay,
} from "../fixtures/time-travel-replay.js";
import { createRuntimeLocalQueueClock } from "../src/queue-clock-runtime-port.js";

test("time-travel-replay fixture reproduces live fire order and facts", () => {
  const result = runTimeTravelReplay(createRuntimeLocalQueueClock);

  assert.ok(result.liveFires.length >= 2);
  assert.ok(result.replayFireOrder.length >= 2);
  assert.equal(result.replayMatchesLive, true);
});

test("time-travel-replay fixture rejects seed mismatch", () => {
  const runtime = createRuntimeLocalQueueClock({
    seed: "time-travel-seed",
    startInstant: "2026-06-26T00:00:00.000Z",
  });
  runtime.clock.sleep("run:one", 10, { idempotencyKey: "sleep-one" });
  runtime.clock.advance(10);

  assert.equal(assertSeedMismatchRejects(runtime.clock.trace()), true);
});

test("time-travel-replay fixture rejects mutated fire timestamps", () => {
  const runtime = createRuntimeLocalQueueClock({
    seed: "time-travel-seed",
    startInstant: "2026-06-26T00:00:00.000Z",
  });
  runtime.clock.sleep("run:one", 10, { idempotencyKey: "sleep-one" });
  runtime.clock.advance(10);

  assert.equal(assertMutatedFireFactRejects(runtime.clock.trace()), true);
});
