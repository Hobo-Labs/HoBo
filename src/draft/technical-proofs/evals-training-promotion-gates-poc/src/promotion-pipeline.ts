import { createLiveEvalRuntime } from "../../live-evals-runtime-contract/src/live-evals-runtime.js";
import {
  createChampionChallengerPromotion,
  findGeneratedRegion,
} from "../../champion-challenger-promotion-contract/src/champion-challenger-promotion.js";

import { CLASSIFY_TICKET_RUBRIC } from "./evals/rubrics.js";
import { createPromotionGateFromRubric, evaluateThreePassGate } from "./evals/promotion-gates.js";
import {
  createBuiltInOptoTrainingEngine,
  createGoldenTrajectory,
  createTrajectoryCaptureRuntime,
  makeOptimizeRequest,
  runBuiltInOptoTrainingRun,
} from "./training/index.js";
import { exportTrainingTelemetry, createTenantOtlpBackend } from "./otlp/tenant-export.js";

export const PROMOTION_PIPELINE_SCHEMA = "hobo.evals-training-promotion-pipeline/v1";

export function runEvalsTrainingPromotionPipeline(options = {}) {
  const tenantId = options.tenantId ?? "tenant-a";
  const otlpEndpoint = options.otlpEndpoint ?? "https://otlp.example/tenant-a/v1/traces";
  const backend = options.backend ?? createTenantOtlpBackend({ tenantId, endpoint: otlpEndpoint });
  const source = options.source ?? defaultTrainingSource();
  const region = findGeneratedRegion(source, "classifyTicket-body");

  const captureRuntime = createTrajectoryCaptureRuntime({
    spanIds: ["1111111111111111", "2222222222222222", "3333333333333333"],
    runKeyRef: `run-key://${tenantId}`,
  });

  const captures = fixtureTickets().map((ticket, index) =>
    captureRuntime.invokeTrainedMethod({
      run: {
        id: `run-hobo653-${index + 1}`,
        tenantId,
        agentId: "agent:support-classifier",
        traceparent: `00-${String(index + 1).repeat(32)}-${String(index + 1).repeat(16)}-01`,
      },
      method: {
        name: "classifyTicket",
        contractRef: "contract://support/classifier@1.0.0",
        generatedRegion: region,
      },
      inputs: { ticket },
      outputs: { route: ticket.includes("billing") ? "billing-support" : "identity-support" },
      childSpans: [{ name: "llm.classifyTicket", kind: "LLM" }],
      rewardSlot: { status: "pending-live-eval", rubricRef: CLASSIFY_TICKET_RUBRIC.id },
    }),
  );

  const trajectories = trainingTrajectories();
  const optimizeRequest = makeOptimizeRequest({
    requestId: "hobo653-training-1",
    trajectories,
    generatedRegion: region,
    rubric: {
      id: CLASSIFY_TICKET_RUBRIC.id,
      objective: "promote billing route without breaking fallback",
      minimumImprovement: 0.5,
      heldOutThreshold: 1,
    },
    contract: {
      ref: "contract://support/classification@1.0.0",
      method: "classifyTicket",
      allowedRegionId: region.regionId,
      invariants: {
        allowedRoutes: ["billing-support", "identity-support", "general-support"],
        forbiddenOutputs: ["admin-support"],
        requiredFallback: "general-support",
      },
    },
  });

  const optimizer = runBuiltInOptoTrainingRun({
    request: optimizeRequest,
    heldOutTrajectories: options.heldOutTrajectories ?? defaultHeldOut(),
    engine: createBuiltInOptoTrainingEngine(),
  });

  const gate = createPromotionGateFromRubric(CLASSIFY_TICKET_RUBRIC, {
    minSamples: options.minSamples ?? 3,
    shadowTraffic: "10%",
  });

  const liveEval = createLiveEvalRuntime({ gate });
  const labelBatch = options.labelBatch ?? passingLabelBatch(optimizer.candidate.id);
  const evalResult = liveEval.evaluateBatch({
    semanticFunction: "classifyTicket",
    arm: "challenger",
    candidateId: optimizer.candidate.id,
    championId: "champion-current",
    conformance: { passed: true },
    policy: { effect: "allow" },
    traffic: { liveSamples: 100, shadowSamples: 3, shadowTraffic: "15%" },
    labelBatch,
  });

  const threePass = evaluateThreePassGate(gate, {
    candidateId: optimizer.candidate.id,
    championId: "champion-current",
    conformance: { passed: true },
    policy: { effect: "allow" },
    samples: labelBatch.labels.length,
    scores: averageScores(labelBatch.labels),
  });

  let promotion = null;
  if (threePass.outcome === "promote") {
    const promotionEngine = createChampionChallengerPromotion();
    promotion = promotionEngine.promote({
      source,
      region,
      candidate: {
        ...optimizer.candidate,
        region,
        edits: [
          {
            startOffset: region.startOffset,
            endOffset: region.endOffset,
            replacement: '  return "billing-support";',
          },
        ],
      },
      gate: { effect: "certify", certified: true, reason: "three-pass green" },
      provenance: completeProvenance(),
      environment: "preview",
      riskClass: "low",
    });
  }

  const spans = normalizeSpansForOtlp([
    ...captures.flatMap((entry) => entry.trajectory?.spans ?? []),
    ...trajectories.flatMap((trajectory) => trajectory.spans ?? []),
  ]);
  const rewards = evalResult.rewardWrites.map((write) => ({
    trajectoryId: write.trajectoryId,
    reward: write.reward,
    rubricRef: write.rubricRef,
    evalEventId: write.evalEventId,
  }));

  const otlp = exportTrainingTelemetry({ backend, tenantId, spans, rewards });

  return {
    schema: PROMOTION_PIPELINE_SCHEMA,
    capture: { trajectoryCount: trajectories.length },
    optimizer: { outcome: optimizer.outcome, candidateId: optimizer.candidate?.id ?? null },
    eval: {
      outcome: evalResult.outcome,
      gateMoved: evalResult.gateMoved,
      threePass,
    },
    promotion: promotion
      ? {
          outcome: promotion.effect,
          eventTypes: promotion.events.map((event) => event.type),
        }
      : { outcome: "refused", eventTypes: [] },
    otlp,
    telemetry: { spanCount: spans.length, rewardCount: rewards.length },
  };
}

export function runRefusedPromotionPipeline(options = {}) {
  return runEvalsTrainingPromotionPipeline({
    ...options,
    labelBatch: failingLabelBatch(options.candidateId ?? "candidate-failing"),
  });
}

export function defaultTrainingSource() {
  return [
    "export function classifyTicket(ticket) {",
    "  const handWrittenGuard = true;",
    "  // hobo:generated-region begin region=classifyTicket-body owner=training-engine",
    '  return "identity-support";',
    "  // hobo:generated-region end region=classifyTicket-body",
    "}",
    "",
  ].join("\n");
}

function trainingTrajectories() {
  return [
    classifyTrajectory({
      id: "train-billing-1",
      ticket: "billing invoice refund",
      baselineRoute: "general-support",
      expectedRoute: "billing-support",
    }),
    classifyTrajectory({
      id: "train-billing-2",
      ticket: "billing chargeback",
      baselineRoute: "general-support",
      expectedRoute: "billing-support",
    }),
    classifyTrajectory({
      id: "train-billing-3",
      ticket: "billing subscription renewal",
      baselineRoute: "general-support",
      expectedRoute: "billing-support",
    }),
  ];
}

function classifyTrajectory({ id, ticket, baselineRoute, expectedRoute }) {
  return createGoldenTrajectory({
    id,
    spans: [
      {
        id: `${id}-root`,
        parentId: null,
        name: "support.classifyTicket",
        startTime: "2026-06-25T09:00:00.000Z",
        endTime: "2026-06-25T09:00:00.120Z",
        attributes: {
          "openinference.span.kind": "CHAIN",
          "hobo.run.id": "run-hobo653-training",
          "hobo.agent.id": "agent:support-classifier",
          "input.value": ticket,
        },
        inputs: { ticket },
        outputs: { route: baselineRoute },
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
          "llm.provider": "local",
        },
        inputs: { promptTemplate: "classify support ticket" },
        outputs: { label: expectedRoute },
      },
    ],
    payloads: {
      ticket: { classification: "public", redaction: "none", value: ticket },
      expectedRoute: { classification: "public", redaction: "none", value: expectedRoute },
      baselineRoute: { classification: "public", redaction: "none", value: baselineRoute },
    },
  });
}

function fixtureTickets() {
  return ["password reset request", "billing invoice", "billing refund"];
}

function defaultHeldOut() {
  return [
    classifyTrajectory({
      id: "heldout-billing",
      ticket: "billing invoice refund",
      baselineRoute: "general-support",
      expectedRoute: "billing-support",
    }),
  ];
}

function passingLabelBatch(candidateId) {
  return {
    id: `labels-${candidateId}`,
    integrity: { verdict: "trusted", attestation: "signed-human-sample" },
    labels: [0, 1, 2].map((index) => ({
      trajectoryId: `trajectory-${candidateId}-${index}`,
      scores: { categoryCorrect: 0.96, urgencyCalibrated: 0.95, piiSafe: 1 },
      reward: 0.96,
      metrics: { quality: 0.96, costUsd: 0.002, latencyMs: 80 + index, calibration: 0.95 },
    })),
  };
}

function failingLabelBatch(candidateId) {
  return {
    id: `labels-${candidateId}`,
    integrity: { verdict: "trusted", attestation: "signed-human-sample" },
    labels: [0, 1, 2].map((index) => ({
      trajectoryId: `trajectory-${candidateId}-${index}`,
      scores: { categoryCorrect: 0.7, urgencyCalibrated: 0.65, piiSafe: 1 },
      reward: 0.68,
      metrics: { quality: 0.68, costUsd: 0.002, latencyMs: 90 + index, calibration: 0.6 },
    })),
  };
}

function averageScores(labels) {
  const names = Object.keys(labels[0].scores);
  return Object.fromEntries(
    names.map((name) => [
      name,
      Number((labels.reduce((sum, label) => sum + label.scores[name], 0) / labels.length).toFixed(6)),
    ]),
  );
}

function normalizeSpansForOtlp(spans) {
  return spans.map((span) => ({
    name: span.name,
    kind: span.kind ?? span.attributes?.["openinference.span.kind"] ?? "CHAIN",
    traceId: span.traceId ?? "11111111111111111111111111111111",
    spanId: span.id ?? span.spanId ?? "aaaaaaaaaaaaaaaa",
    attributes: span.attributes ?? {},
  }));
}

function completeProvenance() {
  return {
    kind: "generation-provenance",
    signature: {
      alg: "Ed25519",
      payloadDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      value: "signed-fixture",
    },
    payload: {
      schema: "hobo.generation.provenance/v1",
      model: {
        provider: "local",
        id: "opto-fixture",
        digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      },
      prompt: {
        id: "prompt:support-classifier",
        frozenPromptDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      },
      seed: "seed-hobo653",
      evalReportRefs: [
        {
          kind: "eval-report",
          name: "shadow-eval",
          digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        },
      ],
      conformanceReportRef: {
        kind: "conformance-report",
        name: "support-classifier-contract",
        digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
        signature: {
          alg: "Ed25519",
          payloadDigest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
          value: "signed-report",
        },
      },
      artifact: {
        kind: "use-training-method",
        name: "classifyTicket",
        digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
      },
      issuedAt: "2026-06-28T19:10:00.000Z",
    },
  };
}

export { createTenantOtlpBackend };
