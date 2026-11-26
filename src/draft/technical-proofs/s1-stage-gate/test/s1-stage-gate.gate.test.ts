import assert from "node:assert/strict";
import { test } from "vitest";

import { isValidGreenRecord } from "../src/record.js";
import { runS1StageGateRecord } from "../src/stage-gate.js";

test("S1 stage gate runs all three checks and records green evidence", async () => {
  const record = await runS1StageGateRecord({
    commitSha: process.env.GITHUB_SHA ?? "local",
    workflowRunUrl: process.env.GITHUB_SERVER_URL
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "",
  });

  assert.equal(record.gateId, "s1-stage-gate");
  assert.equal(isValidGreenRecord(record), true);
  assert.ok(record.checks.find((check) => check.checkId === "offline-hello-bindle")!.durationMs <= 60_000);
});
