import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseReplayDivergence, parseReplayReport, ReplayParseError } from "../src/parse.js";

describe("parseReplayReport", () => {
  it("accepts a valid report", () => {
    const digest = "a".repeat(64);
    const report = parseReplayReport({
      run_id: "run-1",
      seq_vector: [{ stream_id: "run/run-1", seq: 3 }],
      read_set_hash: digest,
      state_digest: digest,
      mode: "replay",
      seed: "seed-1",
    });

    assert.equal(report.runId, "run-1");
    assert.equal(report.mode, "replay");
    assert.equal(report.readSetHash, digest);
  });

  it("rejects malformed digests", () => {
    assert.throws(
      () =>
        parseReplayReport({
          run_id: "run-1",
          seq_vector: [],
          read_set_hash: "not-hex",
          state_digest: "a".repeat(64),
          mode: "replay",
          seed: "seed",
        }),
      ReplayParseError,
    );
  });
});

describe("parseReplayDivergence", () => {
  it("requires differing digests", () => {
    const digest = "b".repeat(64);
    assert.throws(
      () =>
        parseReplayDivergence({
          run_id: "run-1",
          live_state_digest: digest,
          replay_state_digest: digest,
          live_order: ["a:1"],
          replay_order: ["b:1"],
          first_divergent_event_key: "a:1",
        }),
      ReplayParseError,
    );
  });
});
