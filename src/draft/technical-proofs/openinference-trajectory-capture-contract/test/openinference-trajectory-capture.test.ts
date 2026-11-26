import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  OPENINFERENCE_TRAJECTORY_CAPTURE_CONTRACT,
  canonicalJson,
  createTrajectoryCaptureRuntime,
  hashTrajectory,
  recoverCandidateTrajectorySet,
  reconstructTrajectoryFromLog,
} from "../src/openinference-trajectory-capture.js";

const RUN = {
  id: "run-training-1",
  tenantId: "tenant-a",
  agentId: "agent:support-classifier",
  traceparent: "00-11111111111111111111111111111111-aaaaaaaaaaaaaaaa-01",
};

const METHOD = {
  name: "classifyTicket",
  contractRef: "contract://support/classifier@1.0.0",
  generatedRegion: {
    regionId: "region-classifyTicket-body",
    artifactRef: "git://repo/src/support.ts#classifyTicket",
    startOffset: 0,
    endOffset: 80,
  },
};

describe("OpenInference trajectory capture contract", () => {
  it("captures a use-training invocation as OpenInference spans reconstructable from the event log", () => {
    const runtime = createTrajectoryCaptureRuntime({
      spanIds: ["bbbbbbbbbbbbbbbb", "cccccccccccccccc"],
      clock: [
        "2026-06-25T17:20:00.000Z",
        "2026-06-25T17:20:00.010Z",
        "2026-06-25T17:20:00.020Z",
        "2026-06-25T17:20:00.040Z",
      ],
      runKeyRef: "run-key://run-training-1",
    });

    const capture = runtime.invokeTrainedMethod({
      run: RUN,
      method: METHOD,
      inputs: { ticket: "password reset request" },
      outputs: { route: "identity-support" },
      childSpans: [
        {
          name: "llm.classifyTicket",
          kind: "LLM",
          inputs: { promptTemplate: "classify support ticket" },
          outputs: { label: "password-reset" },
          attributes: { "llm.model_name": "stub-classifier" },
        },
      ],
      rewardSlot: {
        status: "pending-live-eval",
        rubricRef: "rubric://support/classifier@1.0.0",
      },
    });

    assert.equal(OPENINFERENCE_TRAJECTORY_CAPTURE_CONTRACT, "hobo.openinference-trajectory-capture/v1");
    assert.equal(capture.captured, true);
    assert.equal(capture.trajectory.run.id, "run-training-1");
    assert.deepEqual(
      capture.trajectory.spans.map((span) => span.attributes["openinference.span.kind"]),
      ["CHAIN", "LLM"],
    );

    const events = runtime.eventLog();
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "telemetry.OpenInferenceSpanRecorded",
        "telemetry.OpenInferenceSpanRecorded",
        "training.TrajectoryCaptured",
      ],
    );
    assert.ok(
      Date.parse(events.at(-1).time) >= Math.max(...capture.trajectory.spans.map((span) => Date.parse(span.endedAt))),
    );

    const reconstructed = reconstructTrajectoryFromLog(events, capture.trajectory.id);
    assert.equal(canonicalJson(reconstructed), canonicalJson(capture.trajectory));
    assert.equal(events.at(-1).data.trajectoryHash, hashTrajectory(capture.trajectory));
  });

  it("recovers the exact trajectory set that fed a candidate", () => {
    const runtime = createTrajectoryCaptureRuntime({
      spanIds: ["1111111111111111", "2222222222222222", "3333333333333333", "4444444444444444"],
      clock: [
        "2026-06-25T17:21:00.000Z",
        "2026-06-25T17:21:00.010Z",
        "2026-06-25T17:21:00.020Z",
        "2026-06-25T17:21:00.030Z",
        "2026-06-25T17:21:01.000Z",
        "2026-06-25T17:21:01.010Z",
        "2026-06-25T17:21:01.020Z",
        "2026-06-25T17:21:01.030Z",
      ],
      runKeyRef: "run-key://run-training-1",
    });

    const first = runtime.invokeTrainedMethod({
      run: RUN,
      method: METHOD,
      inputs: { ticket: "reset password" },
      outputs: { route: "identity-support" },
      childSpans: [{ name: "llm.classifyTicket", kind: "LLM" }],
      rewardSlot: { status: "pending-live-eval", rubricRef: "rubric://support/classifier@1.0.0" },
    });
    const second = runtime.invokeTrainedMethod({
      run: { ...RUN, traceparent: "00-22222222222222222222222222222222-dddddddddddddddd-01" },
      method: METHOD,
      inputs: { ticket: "billing issue" },
      outputs: { route: "billing-support" },
      childSpans: [{ name: "llm.classifyTicket", kind: "LLM" }],
      rewardSlot: { status: "pending-live-eval", rubricRef: "rubric://support/classifier@1.0.0" },
    });

    runtime.recordCandidateProvenance({
      candidateId: "candidate-1",
      trajectoryIds: [second.trajectory.id, first.trajectory.id],
      generatedRegion: METHOD.generatedRegion,
    });

    const recovered = recoverCandidateTrajectorySet(runtime.eventLog(), "candidate-1");

    assert.deepEqual(
      recovered.map((entry) => entry.trajectory.id),
      [second.trajectory.id, first.trajectory.id],
    );
    assert.deepEqual(
      recovered.map((entry) => entry.hash),
      [hashTrajectory(second.trajectory), hashTrajectory(first.trajectory)],
    );
  });

  it("honors per-run encryption, redaction at capture, retention, and sampling decisions", () => {
    const runtime = createTrajectoryCaptureRuntime({
      spanIds: ["5555555555555555", "6666666666666666"],
      runKeyRef: "run-key://run-training-1",
      retention: { traceTtlDays: 14, trajectoryTtlDays: 30 },
    });

    runtime.invokeTrainedMethod({
      run: RUN,
      method: METHOD,
      inputs: { email: "alice@example.com", ticket: "password reset request" },
      outputs: { route: "identity-support" },
      sensitiveFields: ["inputs.email"],
      childSpans: [{ name: "llm.classifyTicket", kind: "LLM" }],
      rewardSlot: { status: "pending-live-eval", rubricRef: "rubric://support/classifier@1.0.0" },
    });

    const serialized = JSON.stringify(runtime.eventLog());
    assert.equal(serialized.includes("alice@example.com"), false);
    assert.match(serialized, /run:\/\/run-training-1\/payloads\/inputs\.email/);
    assert.match(serialized, /"traceTtlDays":14/);
    assert.match(serialized, /"trajectoryTtlDays":30/);

    const sampledOut = createTrajectoryCaptureRuntime({
      sampling: { capture: false, reason: "trace-sampling" },
      spanIds: ["7777777777777777"],
      runKeyRef: "run-key://run-training-1",
    });

    const skipped = sampledOut.invokeTrainedMethod({
      run: RUN,
      method: METHOD,
      inputs: { ticket: "password reset request" },
      outputs: { route: "identity-support" },
      childSpans: [],
      rewardSlot: { status: "pending-live-eval", rubricRef: "rubric://support/classifier@1.0.0" },
    });

    assert.equal(skipped.captured, false);
    assert.deepEqual(
      sampledOut.eventLog().map((event) => event.type),
      ["training.TrajectorySampledOut"],
    );
  });

  it("fails closed when span evidence exists but the trajectory append is missing", () => {
    const runtime = createTrajectoryCaptureRuntime({
      spanIds: ["8888888888888888", "9999999999999999"],
      runKeyRef: "run-key://run-training-1",
    });
    const capture = runtime.invokeTrainedMethod({
      run: RUN,
      method: METHOD,
      inputs: { ticket: "password reset request" },
      outputs: { route: "identity-support" },
      childSpans: [{ name: "llm.classifyTicket", kind: "LLM" }],
      rewardSlot: { status: "pending-live-eval", rubricRef: "rubric://support/classifier@1.0.0" },
    });

    const droppedTrajectoryAppend = runtime
      .eventLog()
      .filter((event) => event.type !== "training.TrajectoryCaptured");

    assert.throws(
      () => reconstructTrajectoryFromLog(droppedTrajectoryAppend, capture.trajectory.id),
      /audit invariant: OpenInference spans exist but trajectory was not appended/,
    );
  });

  it("replays byte-stable trajectories regardless of event order", () => {
    const runtime = createTrajectoryCaptureRuntime({
      spanIds: ["abababababababab", "bcbcbcbcbcbcbcbc"],
      clock: [
        "2026-06-25T17:22:00.000Z",
        "2026-06-25T17:22:00.010Z",
        "2026-06-25T17:22:00.020Z",
        "2026-06-25T17:22:00.030Z",
      ],
      runKeyRef: "run-key://run-training-1",
    });
    const capture = runtime.invokeTrainedMethod({
      run: RUN,
      method: METHOD,
      inputs: { ticket: "password reset request" },
      outputs: { route: "identity-support" },
      childSpans: [{ name: "llm.classifyTicket", kind: "LLM" }],
      rewardSlot: { status: "pending-live-eval", rubricRef: "rubric://support/classifier@1.0.0" },
    });

    const events = runtime.eventLog();
    const firstReplay = reconstructTrajectoryFromLog(events, capture.trajectory.id);
    const secondReplay = reconstructTrajectoryFromLog([...events].reverse(), capture.trajectory.id);

    assert.equal(canonicalJson(firstReplay), canonicalJson(secondReplay));
    assert.equal(canonicalJson(firstReplay), canonicalJson(capture.trajectory));
  });
});
