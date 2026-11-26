import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  TRAINING_ENGINE_PORT,
  TRAINING_EVENT_TYPES,
  canonicalJson,
  createGoldenTrajectory,
  createOutOfRegionOptimizer,
  createStubTrainingEngine,
  createTrainingEvent,
  hashTrajectory,
  makeOptimizeRequest,
  optimizeTrainingCandidate,
  replayTrainingRun,
  runTrainingEngineConformance,
  validateCandidatePatch,
  validateTrainingEvent,
  validateTrajectory
} from "../src/training-engine-contract.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("publishes the training-engine WIT port, schema, and typed adapter surface", async () => {
  const wit = await readFile(path.join(packageRoot, "wit", "world.wit"), "utf8");
  const declarations = await readFile(path.join(packageRoot, "src", "training-engine-contract.d.mts"), "utf8");
  const schema = JSON.parse(await readFile(path.join(packageRoot, "schema", "training-engine.v1.schema.json"), "utf8"));

  assert.equal(TRAINING_ENGINE_PORT, "hobo:training-engine/training-engine@0.1.0");
  assert.match(wit, /optimize: func\(request: optimize-request\) -> result<candidate-patch, training-error>/);
  assert.match(wit, /record trajectory/);
  assert.match(declarations, /export interface TrainingEngineAdapter/);
  assert.match(declarations, /export interface GeneratedRegionRef/);
  assert.match(declarations, /region: GeneratedRegionRef/);
  assert.equal(schema.$id, "https://schemas.hobo.dev/training-engine.v1.schema.json");
});

test("stub optimizer returns a deterministic in-region candidate patch", () => {
  const trajectory = createGoldenTrajectory();
  const request = makeOptimizeRequest({ trajectories: [trajectory] });
  const first = optimizeTrainingCandidate(createStubTrainingEngine(), request);
  const second = optimizeTrainingCandidate(createStubTrainingEngine(), structuredClone(request));

  assert.equal(first.ok, true, first.errors.join("\n"));
  assert.equal(first.candidate.region.regionId, request.generatedRegion.regionId);
  assert.deepEqual(first.candidate.edits, [
    {
      startOffset: 14,
      endOffset: 34,
      replacement: "return candidate.score;"
    }
  ]);
  assert.equal(canonicalJson(first.candidate), canonicalJson(second.candidate));
  assert.equal(validateCandidatePatch(first.candidate, request.generatedRegion).ok, true);
});

test("trajectory fixture validates as OpenInference spans with reward and run/agent correlation", () => {
  const trajectory = createGoldenTrajectory();
  const valid = validateTrajectory(trajectory);

  assert.equal(valid.ok, true, valid.errors.join("\n"));
  assert.equal(trajectory.reward.score, 0.94);
  assert.equal(trajectory.spans[0].attributes["openinference.span.kind"], "CHAIN");
  assert.equal(trajectory.spans[1].attributes["openinference.span.kind"], "LLM");

  const withoutRunId = createGoldenTrajectory({ run: { id: "" } });
  assert.equal(validateTrajectory(withoutRunId).ok, false);
  assert.match(validateTrajectory(withoutRunId).errors.join("\n"), /run\.id/);

  const withoutAgent = createGoldenTrajectory({ run: { agent: { id: "" } } });
  assert.equal(validateTrajectory(withoutAgent).ok, false);
  assert.match(validateTrajectory(withoutAgent).errors.join("\n"), /run\.agent/);
});

test("training event family validates and replays into a training run projection", () => {
  const trajectory = createGoldenTrajectory();
  const candidate = optimizeTrainingCandidate(createStubTrainingEngine(), makeOptimizeRequest({ trajectories: [trajectory] })).candidate;

  assert.deepEqual(TRAINING_EVENT_TYPES, [
    "training.RunStarted",
    "training.TrajectoryCaptured",
    "training.RewardObserved",
    "training.CandidateProposed",
    "training.CandidateEvaluated",
    "training.Promoted",
    "training.Rejected"
  ]);

  const runId = trajectory.run.id;
  const events = [
    createTrainingEvent({ id: "evt-0", type: "training.RunStarted", runId, seq: 0 }),
    createTrainingEvent({
      id: "evt-1",
      type: "training.TrajectoryCaptured",
      runId,
      seq: 1,
      data: {
        trajectoryId: trajectory.id,
        trajectoryHash: hashTrajectory(trajectory),
        trajectory
      }
    }),
    createTrainingEvent({
      id: "evt-2",
      type: "training.RewardObserved",
      runId,
      seq: 2,
      data: {
        trajectoryId: trajectory.id,
        reward: trajectory.reward
      }
    }),
    createTrainingEvent({
      id: "evt-3",
      type: "training.CandidateProposed",
      runId,
      seq: 3,
      data: { candidate }
    }),
    createTrainingEvent({
      id: "evt-4",
      type: "training.CandidateEvaluated",
      runId,
      seq: 4,
      data: {
        candidateId: candidate.id,
        conformance: { ok: true, errors: [] }
      }
    }),
    createTrainingEvent({
      id: "evt-5",
      type: "training.Promoted",
      runId,
      seq: 5,
      data: {
        candidateId: candidate.id,
        promotionRef: "promotion://support/classifier/candidate-1"
      }
    })
  ];
  const rejected = createTrainingEvent({
    id: "evt-6",
    type: "training.Rejected",
    runId,
    seq: 6,
    data: {
      candidateId: candidate.id,
      reason: "candidate held for review"
    }
  });

  for (const event of [...events, rejected]) {
    assert.equal(validateTrainingEvent(event).ok, true, event.type);
  }

  assert.deepEqual(replayTrainingRun(events), {
    runId: "run-2026-06-25-training-1",
    status: "promoted",
    trajectoryIds: ["trajectory-1"],
    rewardCount: 1,
    candidateIds: ["candidate-1"],
    lastSeq: 5
  });
});

test("sensitive trajectory payloads must be tokenized or per-run encrypted", () => {
  const leaked = createGoldenTrajectory({
    payloads: {
      "ticket.body": {
        classification: "pii",
        redaction: "raw",
        value: "Customer alice@example.com lost access"
      }
    }
  });

  const encrypted = createGoldenTrajectory({
    payloads: {
      "ticket.body": {
        classification: "pii",
        redaction: "encrypted",
        encryptedRef: "run://run-2026-06-25-training-1/payloads/ticket.body"
      }
    }
  });

  assert.equal(validateTrajectory(leaked).ok, false);
  assert.match(validateTrajectory(leaked).errors.join("\n"), /sensitive payload ticket\.body must be tokenized or encrypted/);
  assert.equal(validateTrajectory(encrypted).ok, true, validateTrajectory(encrypted).errors.join("\n"));
});

test("optimizer conformance rejects candidate edits outside the marked generated region", () => {
  const request = makeOptimizeRequest({ trajectories: [createGoldenTrajectory()] });
  const result = optimizeTrainingCandidate(createOutOfRegionOptimizer(), request);
  const conformance = runTrainingEngineConformance(createOutOfRegionOptimizer());

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /edit 0 must stay within generated region/);
  assert.equal(conformance.ok, false);
  assert.match(conformance.errors.join("\n"), /generated region/);
});
