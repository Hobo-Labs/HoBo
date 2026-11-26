import assert from "node:assert/strict";
import { test } from "vitest";

import { runRedeliveryAfterCrash } from "../fixtures/redelivery-after-crash.js";
import { createRuntimeLocalQueueClock } from "../src/queue-clock-runtime-port.js";

test("redelivery-after-crash fixture keeps effect count at 1 across snapshot restore", async () => {
  const result = await runRedeliveryAfterCrash(createRuntimeLocalQueueClock);

  assert.equal(result.effectCount, 1);
  assert.equal(result.messageCompleted, true);
});
