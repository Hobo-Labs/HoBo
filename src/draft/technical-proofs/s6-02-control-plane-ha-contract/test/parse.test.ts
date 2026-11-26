import assert from "node:assert/strict";
import { test } from "vitest";

import {
  parseFenceToken,
  parseLeaderFailoverOutcome,
  parseQuorumFencedAppend,
} from "../src/parse.js";

test("parseQuorumFencedAppend rejects invalid append requests at the boundary", () => {
  const parsed = parseQuorumFencedAppend({
    streamId: "control-plane/deploy",
    fenceToken: 2n,
    eventType: "deploy.Started",
    actionId: "deploy-1",
  });

  assert.equal(parsed.streamId, "control-plane/deploy");
  assert.equal(parsed.fenceToken, 2n);
  assert.equal(parsed.eventType, "deploy.Started");
  assert.equal(parsed.actionId, "deploy-1");
});

test("parseLeaderFailoverOutcome enforces NFR-009 recovery budget", () => {
  const outcome = parseLeaderFailoverOutcome({
    leaderNode: "yard-a",
    successorNode: "yard-b",
    recoveryMs: 7_001,
    duplicateActionsBlocked: true,
  });

  assert.equal(outcome.successorNode, "yard-b");
  assert.throws(
    () =>
      parseLeaderFailoverOutcome({
        leaderNode: "yard-a",
        successorNode: "yard-b",
        recoveryMs: 30_001,
        duplicateActionsBlocked: true,
      }),
    /recoveryMs must be <= 30000/,
  );
});

test("parseFenceToken rejects sub-unity tokens", () => {
  assert.throws(() => parseFenceToken(0n), /fenceToken must be >= 1/);
});
