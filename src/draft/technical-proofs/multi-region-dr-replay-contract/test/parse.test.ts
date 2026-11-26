import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  parseMultiRegionTopology,
  parseReplicatedLog,
  parseRestoreRequest,
} from "../src/parse.ts";

describe("parse boundary", () => {
  it("parseRestoreRequest rejects missing log path", () => {
    assert.throws(() => parseRestoreRequest({}), /logPath is required/);
  });

  it("parseMultiRegionTopology requires primary region in regions list", () => {
    assert.throws(
      () =>
        parseMultiRegionTopology({
          regions: ["us-east-1", "us-west-2"],
          authoritativeLog: {
            mode: "active-passive-log",
            primaryRegion: "eu-central-1",
          },
          statelessTier: {
            mode: "active-active",
            roles: ["gateway"],
          },
        }),
      /primaryRegion must be listed in regions/,
    );
  });

  it("parseReplicatedLog rejects replicatedSeq beyond lastCommittedSeq", () => {
    assert.throws(
      () =>
        parseReplicatedLog({
          streams: { "actor:test": [{ seq: 1, type: "actor.StateAppended" }] },
          lastCommittedSeq: 1,
          replicatedSeq: 2,
        }),
      /replicatedSeq must not exceed lastCommittedSeq/,
    );
  });
});
