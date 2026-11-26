import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canonicalJson,
  createGoldenTrajectory,
  makeOptimizeRequest,
  optimizeTrainingCandidate,
  replayTrainingRun,
  validateTrainingEvent
} from "../../training-engine-port-contract/src/training-engine-contract.js";
import {
  BUILT_IN_OPTO_TRAINING_ENGINE_CONTRACT,
  createBuiltInOptoTrainingEngine,
  runBuiltInOptoTrainingRun,
  screenCandidateForPromotion
} from "../src/built-in-opto-training-engine.js";

const generatedRegion = {
  regionId: "region-classifyTicket-body",
  artifactRef: "git://repo/src/support.ts#classifyTicket",
  startOffset: 42,
  endOffset: 68,
  owner: "training-engine",
  currentText: 'return "general-support";'
};

const contract = {
  ref: "contract://support/classification@1.0.0",
  method: "classifyTicket",
  allowedRegionId: generatedRegion.regionId,
  invariants: {
    allowedRoutes: ["billing-support", "identity-support", "general-support"],
    forbiddenOutputs: ["refund-approved", "pii-leak"],
    requiredFallback: "general-support"
  }
};

const rubric = {
  id: "rubric://support/classifier@1.0.0",
  objective: "maximize held-out routing accuracy while preserving contract outputs",
  heldOutThreshold: 0.75,
  minimumImprovement: 0.25
};

test("seeded low-score method produces a replayable in-region candidate that improves held-out rubric", () => {
  const request = makeRequest({
    trajectories: [
      trajectory({
        id: "train-billing-1",
        ticket: "invoice refund question",
        expectedRoute: "billing-support",
        baselineRoute: "general-support",
        score: 0.2
      }),
      trajectory({
        id: "train-identity-1",
        ticket: "login password reset",
        expectedRoute: "identity-support",
        baselineRoute: "general-support",
        score: 0.25
      })
    ]
  });
  const heldOutTrajectories = [
    trajectory({
      id: "heldout-billing-1",
      ticket: "invoice copy needed",
      expectedRoute: "billing-support",
      baselineRoute: "general-support",
      score: 0.1
    }),
    trajectory({
      id: "heldout-identity-1",
      ticket: "password locked out",
      expectedRoute: "identity-support",
      baselineRoute: "general-support",
      score: 0.1
    }),
    trajectory({
      id: "heldout-general-1",
      ticket: "store hours",
      expectedRoute: "general-support",
      baselineRoute: "general-support",
      score: 1
    })
  ];

  const first = runBuiltInOptoTrainingRun({ request, heldOutTrajectories });
  const second = runBuiltInOptoTrainingRun({
    request: structuredClone(request),
    heldOutTrajectories: structuredClone(heldOutTrajectories)
  });

  assert.equal(BUILT_IN_OPTO_TRAINING_ENGINE_CONTRACT, "hobo.built-in-opto-training-engine/v1");
  assert.equal(first.outcome, "ready-for-gate", first.rejectionReasons.join("\n"));
  assert.equal(first.candidate.region.regionId, generatedRegion.regionId);
  assert.deepEqual(first.candidate.edits.map((edit) => [edit.startOffset, edit.endOffset]), [[42, 68]]);
  assert.equal(first.evaluation.baselineScore, 1 / 3);
  assert.equal(first.evaluation.candidateScore, 1);
  assert.ok(Math.abs(first.evaluation.improvement - 2 / 3) < Number.EPSILON);
  assert.equal(first.screening.passFlags.conformance, true);
  assert.equal(first.screening.passFlags.heldOutEval, true);
  assert.equal(canonicalJson(first.candidate), canonicalJson(second.candidate));
  assert.equal(first.replayDigest, second.replayDigest);

  for (const event of first.events) {
    assert.equal(validateTrainingEvent(event).ok, true, event.type);
  }
  assert.deepEqual(replayTrainingRun(first.events), {
    runId: "opto-run-1",
    status: "running",
    trajectoryIds: [],
    rewardCount: 0,
    candidateIds: [first.candidate.id],
    lastSeq: 2
  });
});

test("optimizer conformance refuses edits outside the marked generated region", () => {
  const request = makeRequest({ trajectories: [trajectory({ id: "train-1" })] });
  const outOfRegionEngine = {
    engineId: "example.training-engine/out-of-region-opto@0.1.0",
    optimize(input) {
      return {
        schema: "hobo.training.candidate-patch/v1",
        id: "candidate-out-of-region",
        engineId: this.engineId,
        region: structuredClone(input.generatedRegion),
        edits: [
          {
            startOffset: input.generatedRegion.endOffset + 1,
            endOffset: input.generatedRegion.endOffset + 10,
            replacement: 'return "billing-support";'
          }
        ],
        provenance: { rubricRef: input.rubric.id, contractRef: input.contract.ref }
      };
    }
  };

  const result = optimizeTrainingCandidate(outOfRegionEngine, request);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /edit 0 must stay within generated region/);
});

test("reward-hacking candidate is rejected by contract pass instead of being accepted on score", () => {
  const request = makeRequest({
    trajectories: [
      trajectory({
        id: "train-refund-1",
        ticket: "refund request",
        expectedRoute: "billing-support",
        baselineRoute: "general-support",
        score: 0.1
      })
    ]
  });
  const heldOutTrajectories = [
    trajectory({
      id: "heldout-refund-1",
      ticket: "refund status",
      expectedRoute: "billing-support",
      baselineRoute: "general-support",
      score: 0.1
    })
  ];
  const rewardHacker = {
    schema: "hobo.training.candidate-patch/v1",
    id: "candidate-reward-hacker",
    engineId: "example.training-engine/reward-hacker@0.1.0",
    region: structuredClone(generatedRegion),
    edits: [
      {
        startOffset: generatedRegion.startOffset,
        endOffset: generatedRegion.endOffset,
        replacement: [
          "// hobo:opto-rules v1",
          "const normalized = ticket.toLowerCase();",
          "if ([\"refund\"].some((keyword) => normalized.includes(keyword))) return \"refund-approved\";",
          "return \"general-support\";"
        ].join("\n")
      }
    ],
    provenance: {
      declaredTrainingScore: 1,
      rubricRef: rubric.id,
      contractRef: contract.ref
    }
  };

  const screened = screenCandidateForPromotion({
    request,
    candidate: rewardHacker,
    heldOutTrajectories
  });

  assert.equal(screened.outcome, "rejected");
  assert.equal(screened.passFlags.conformance, false);
  assert.match(screened.rejectionReasons.join("\n"), /contract\.forbidden-output:refund-approved/);
});

test("built-in optimizer implements the training-engine port adapter shape", () => {
  const request = makeRequest({
    trajectories: [
      trajectory({
        id: "train-billing-1",
        ticket: "billing invoice",
        expectedRoute: "billing-support",
        baselineRoute: "general-support",
        score: 0.1
      })
    ]
  });
  const result = optimizeTrainingCandidate(createBuiltInOptoTrainingEngine(), request);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.candidate.engineId, "hobo.training-engine/built-in-opto@0.1.0");
  assert.match(result.candidate.edits[0].replacement, /hobo:opto-rules v1/);
});

function makeRequest({ trajectories }) {
  return makeOptimizeRequest({
    requestId: "opto-run-1",
    trajectories,
    generatedRegion,
    rubric,
    contract
  });
}

function trajectory({
  id = "trajectory-1",
  ticket = "invoice question",
  expectedRoute = "billing-support",
  baselineRoute = "general-support",
  score = 0.2
}) {
  return createGoldenTrajectory({
    id,
    subject: {
      method: "classifyTicket",
      contractRef: contract.ref,
      generatedRegion
    },
    spans: [
      {
        id: `${id}-root`,
        parentId: null,
        name: "support.classifyTicket",
        startTime: "2026-06-25T09:00:00.000Z",
        endTime: "2026-06-25T09:00:00.120Z",
        attributes: {
          "openinference.span.kind": "CHAIN",
          "input.value": ticket
        },
        inputs: { ticket },
        outputs: { route: baselineRoute }
      },
      {
        id: `${id}-llm`,
        parentId: `${id}-root`,
        name: "llm.classifyTicket",
        startTime: "2026-06-25T09:00:00.010Z",
        endTime: "2026-06-25T09:00:00.100Z",
        attributes: {
          "openinference.span.kind": "LLM",
          "llm.model_name": "stub-classifier",
          "llm.provider": "local"
        },
        inputs: { promptTemplate: "route support ticket" },
        outputs: { route: baselineRoute }
      }
    ],
    payloads: {
      ticket: {
        classification: "public",
        redaction: "none",
        value: ticket
      },
      expectedRoute: {
        classification: "public",
        redaction: "none",
        value: expectedRoute
      },
      baselineRoute: {
        classification: "public",
        redaction: "none",
        value: baselineRoute
      }
    },
    reward: {
      source: "live-eval",
      rubricRef: rubric.id,
      eventId: `eval-${id}`,
      score,
      observedAt: "2026-06-25T09:00:01.000Z"
    }
  });
}
