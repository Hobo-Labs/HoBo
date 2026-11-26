import assert from "node:assert/strict";
import { test } from "vitest";

import {
  StageGateRecordParseError,
  isValidGreenRecord,
  parseStageGateS1Record,
  toRecordJson,
} from "../src/record.js";
import { runS1StageGateRecord } from "../src/stage-gate.js";

test("parseStageGateS1Record enforces gate shape and ordering", () => {
  const parsed = parseStageGateS1Record({
    gate_id: "s1-stage-gate",
    commit_sha: "abc123",
    workflow_run_url: "https://github.com/example/run/1",
    recorded_at: "2026-07-01T00:00:00.000Z",
    checks: [
      {
        check_id: "runtime-port-conformance",
        status: "pass",
        duration_ms: 1200,
        report_ref: "hobo.runtime-port-conformance/v1",
      },
      {
        check_id: "offline-hello-bindle",
        status: "pass",
        duration_ms: 1500,
        report_ref: ".hobo/offline-timing.json",
      },
      {
        check_id: "replay-equals-live",
        status: "pass",
        duration_ms: 400,
        report_ref: ".hobo/events.jsonl",
      },
    ],
  });

  assert.equal(parsed.gateId, "s1-stage-gate");
  assert.equal(isValidGreenRecord(parsed), true);
});

test("parseStageGateS1Record rejects offline boot over 60s", () => {
  assert.throws(
    () =>
      parseStageGateS1Record({
        gate_id: "s1-stage-gate",
        commit_sha: "abc123",
        workflow_run_url: "",
        recorded_at: "2026-07-01T00:00:00.000Z",
        checks: [
          {
            check_id: "runtime-port-conformance",
            status: "pass",
            duration_ms: 1,
            report_ref: "a",
          },
          {
            check_id: "offline-hello-bindle",
            status: "pass",
            duration_ms: 60_001,
            report_ref: "b",
          },
          {
            check_id: "replay-equals-live",
            status: "pass",
            duration_ms: 1,
            report_ref: "c",
          },
        ],
      }),
    StageGateRecordParseError,
  );
});

test("runS1StageGateRecord assembles a green record", async () => {
  const record = await runS1StageGateRecord({
    commitSha: "deadbeef",
    workflowRunUrl: "https://github.com/example/actions/runs/1",
  });

  assert.equal(record.gateId, "s1-stage-gate");
  assert.equal(record.checks.length, 3);
  assert.equal(isValidGreenRecord(record), true);
  assert.deepEqual(record.checks.map((check) => check.checkId), [
    "runtime-port-conformance",
    "offline-hello-bindle",
    "replay-equals-live",
  ]);

  const roundTrip = parseStageGateS1Record(toRecordJson(record));
  assert.deepEqual(roundTrip, record);
});
