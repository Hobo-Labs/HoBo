import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedRepairLoop } from "../../generation-bounded-repair-loop-contract/src/bounded-repair-loop.js";
import { fillGenerationCandidate } from "../../generation-llm-fill-contract/src/fill.js";
import { validateGenRequest } from "../../generation-pipeline-io-contract/src/contract.js";
import { scaffoldGenerationRequest } from "../../generation-scaffold-stage-contract/src/scaffold.js";
import { runValidationStage } from "../../generation-validation-stage-contract/src/validation-stage.js";
import { contentDigest } from "../../slsa-provenance-certification-contract/src/provenance.js";
import { isJsonString, isJsonObject } from "./json.js";


export const STUB_IMPLEMENTATION_REPAIR_BUDGET = 2;

const targetPort = "hobo:service/payments@0.1.0";
const suiteId = "conformance.service.payments@0.1.0";
const fixedTs = "2026-07-02T00:00:00.000Z";
const generationConfig = Object.freeze({ temperature: 0, topP: 1 });
const model = Object.freeze({
  provider: "self-hosted",
  id: "self-hosted/qwen3-coder",
  digest: contentDigest({
    provider: "self-hosted",
    id: "qwen3-coder",
    weights: "pinned",
    generationConfig
  })
});

const requiredConformanceChecks = Object.freeze([
  "service.charge.returns-typed-status",
  "service.charge.honors-contract-invariants",
  "service.refund.returns-typed-status",
  "service.refund.honors-contract-invariants"
]);

export class StubRecordingsParseError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

export function parseStubRecordings(raw) {
  assertObject(raw, "stub.recordings", "$");
  assertEqual(raw.schema, "hobo.stub.recordings/v1", "stub.schema", "$.schema");
  assertNonEmptyString(raw.port, "stub.port", "$.port");
  assertNonEmptyString(raw.stubId, "stub.stub_id", "$.stubId");
  if (!Array.isArray(raw.recordings) || raw.recordings.length === 0) {
    throw new StubRecordingsParseError("stub.recordings_empty", "$.recordings");
  }

  const recordings = raw.recordings.map((recording, index) => {
    const path = `$.recordings[${index}]`;
    assertObject(recording, "stub.recording", path);
    assertNonEmptyString(recording.id, "stub.recording_id", `${path}.id`);
    assertEqual(recording.type, "link.Called", "stub.recording_type", `${path}.type`);
    assertNonEmptyString(recording.method, "stub.recording_method", `${path}.method`);
    assertNonEmptyString(recording.inputDigest, "stub.input_digest", `${path}.inputDigest`);
    assertNonEmptyString(recording.outputDigest, "stub.output_digest", `${path}.outputDigest`);
    return Object.freeze({
      id: recording.id,
      type: recording.type,
      method: recording.method,
      inputDigest: recording.inputDigest,
      outputDigest: recording.outputDigest,
      input: recording.input ?? null,
      output: recording.output ?? null
    });
  });

  return Object.freeze({
    schema: raw.schema,
    port: raw.port,
    stubId: raw.stubId,
    recordings,
    traceIds: Object.freeze(recordings.map((recording) => recording.id))
  });
}

export function loadPaymentsStubRecordingsFixture() {
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../fixtures/payments-stub-recordings.json"
  );
  return parseStubRecordings(JSON.parse(readFileSync(fixturePath, "utf8")));
}

export function adaptStubRecordedTrace(rawTrace, { targetPort, stubId }) {
  assertObject(rawTrace, "stub.recorded_trace", "$");
  assertEqual(
    rawTrace.schema,
    "hobo.stub.recorded-trace/v1",
    "stub.recorded_trace_schema",
    "$.schema"
  );
  assertNonEmptyString(targetPort, "stub.target_port", "$.targetPort");
  assertNonEmptyString(stubId, "stub.stub_id", "$.stubId");
  if (!Array.isArray(rawTrace.entries) || rawTrace.entries.length === 0) {
    throw new StubRecordingsParseError("stub.recordings_empty", "$.entries");
  }

  const recordings = rawTrace.entries.map((entry, index) => {
    const path = `$.entries[${index}]`;
    assertObject(entry, "stub.recorded_trace_entry", path);
    assertNonEmptyString(entry.function, "stub.recorded_trace_function", `${path}.function`);
    return Object.freeze({
      id: `trace:${entry.function}-${index + 1}`,
      type: "link.Called",
      method: entry.function,
      inputDigest: contentDigest(entry.input ?? {}),
      outputDigest: contentDigest(entry.output ?? {}),
      input: entry.input ?? null,
      output: entry.output ?? null
    });
  });

  return parseStubRecordings({
    schema: "hobo.stub.recordings/v1",
    port: targetPort,
    stubId,
    recordings
  });
}

export function buildStubImplementationGenerationRequest(overrides = {}) {
  const stubRecordings = overrides.stubRecordings ?? loadPaymentsStubRecordingsFixture();
  return validateGenRequest({
    schema: "hobo.gen.request/v1",
    requestId: "hobo-652-payments-implementation-from-stub",
    artifactKind: "implementation",
    target: { witPort: targetPort },
    capabilityManifestRef: digestRef("capability-manifest", {
      service: "payments",
      targetPort,
      stubId: stubRecordings.stubId
    }),
    authoritativeRefs: [
      { kind: "wit", ref: "wit://hobo/service/payments@0.1.0" },
      {
        kind: "conformance-suite",
        suiteId,
        ref: "oci://registry.example/hobo/conformance/payments@sha256:652"
      }
    ],
    materialRefs: [
      {
        kind: "recorded-traces",
        ref: digestRef("stub-recordings", stubRecordings).uri,
        trusted: false,
        sanitized: true,
        traceCount: stubRecordings.recordings.length
      }
    ],
    ...overrides,
    stubRecordings: undefined
  });
}

export async function runStubImplementationGeneration({
  stubRecordings = loadPaymentsStubRecordingsFixture(),
  requestOverrides,
  validationScript = ["pass"],
  seed = "seed-hobo-652",
  repairBudget = STUB_IMPLEMENTATION_REPAIR_BUDGET
} = {}) {
  assertPinnedInputs({ seed });
  const parsedStub = parseStubRecordings(stubRecordings);
  const request = buildStubImplementationGenerationRequest({
    stubRecordings: parsedStub,
    ...requestOverrides
  });

  if (parsedStub.port !== request.target.witPort) {
    throw new StubRecordingsParseError("stub.port_mismatch", "$.port");
  }

  const scaffold = scaffoldGenerationRequest(request, { seq: 2, ts: fixedTs });
  if (scaffold.status !== "candidate-generated") {
    return needsHumanResult({ request, scaffold, parsedStub });
  }

  const fill = fillGenerationCandidate(request, scaffold.candidate, {
    seq: 3,
    ts: fixedTs,
    seed,
    model
  });

  const validations = [];
  const remainingScript = [...validationScript];
  const repair = await runBoundedRepairLoop({
    request,
    initialCandidateRef: fill.candidate.ref,
    maxRepairAttempts: repairBudget,
    validateCandidate: async ({ candidateRef, iteration }) => {
      const mode = remainingScript.shift() ?? "pass";
      const validation = await validateCandidate({
        request,
        candidateRef,
        mode,
        parsedStub,
        seq: 10 + iteration * 2
      });
      validations.push(validation);
      if (validation.report.passed) {
        return {
          passed: true,
          candidateRef,
          validationReportRef: validation.report.ref
        };
      }
      return {
        passed: false,
        candidateRef,
        validationReportRef: validation.report.ref,
        failingAssertions: validation.event.data.failingAssertions
      };
    },
    regenerateCandidate: async ({ previousCandidateRef, failingAssertions, iteration }) => ({
      candidateRef: repairedCandidateRef({
        request,
        seed,
        previousCandidateRef,
        failingAssertions,
        iteration,
        parsedStub
      })
    }),
    seqStart: 4,
    ts: fixedTs
  });

  const finalValidation = validations.at(-1) ?? null;
  const finalCandidateRef =
    finalValidation?.report.candidateRef ?? repair.finalEvent.data.candidateRef ?? fill.candidate.ref;
  const conformance = assessConformance(finalValidation?.report?.conformance);
  const traceReplay = assessTraceReplay(finalValidation?.report?.traceReplay, parsedStub);

  if (repair.outcome !== "converged" || !conformance.ok || !traceReplay.ok) {
    return {
      outcome: repair.outcome === "converged" ? "needs-human" : repair.outcome,
      request,
      parsedStub,
      scaffold,
      fill,
      repair,
      validations,
      finalValidation,
      finalCandidateRef,
      conformance,
      traceReplay,
      promotion: null,
      stageResults: stageResults({ promoted: false })
    };
  }

  const promotion = promoteStubImplementation({
    request,
    candidateRef: finalCandidateRef,
    validationReport: finalValidation.report,
    parsedStub,
    seed
  });

  return {
    outcome: promotion.ok ? "promoted" : "needs-human",
    request,
    parsedStub,
    scaffold,
    fill,
    repair,
    validations,
    finalValidation,
    finalCandidateRef,
    conformance,
    traceReplay,
    promotion,
    stageResults: stageResults({ promoted: promotion.ok })
  };
}

export function runNonConvergingStubImplementationGeneration(options = {}) {
  return runStubImplementationGeneration({
    ...options,
    validationScript: ["trace-mismatch", "conformance-mismatch", "trace-mismatch"]
  });
}

export function assessConformance(conformanceReport) {
  if (!conformanceReport) {
    return { ok: false, reasons: ["missing conformance report"] };
  }
  const observed = new Map(
    (conformanceReport.assertions ?? []).map((assertion) => [assertion.id, assertion])
  );
  const reasons = [];
  for (const checkId of requiredConformanceChecks) {
    const assertion = observed.get(checkId);
    if (!assertion) {
      reasons.push(`missing required conformance ${checkId}`);
    } else if (!assertion.passed) {
      reasons.push(`failed required conformance ${checkId}`);
    }
  }
  return Object.freeze({
    ok: reasons.length === 0 && conformanceReport.passed === true,
    suiteId,
    targetPort,
    requiredChecks: requiredConformanceChecks,
    reasons: Object.freeze(reasons)
  });
}

export function assessTraceReplay(traceReplayReport, parsedStub) {
  if (!traceReplayReport) {
    return { ok: false, reasons: ["missing trace replay report"] };
  }
  const reasons = [];
  const diffs = traceReplayReport.diffs ?? [];
  if (!traceReplayReport.passed) {
    for (const diff of diffs) {
      reasons.push(diff.reason ?? `trace replay failed for ${diff.id}`);
    }
    if (reasons.length === 0) {
      reasons.push("trace replay failed without diffs");
    }
  }
  return Object.freeze({
    ok: reasons.length === 0 && traceReplayReport.passed === true,
    expectedTraceCount: parsedStub.traceIds.length,
    reproducedTraceCount: parsedStub.traceIds.length - diffs.length,
    reasons: Object.freeze(reasons)
  });
}

async function validateCandidate({ request, candidateRef, mode, parsedStub, seq }) {
  return runValidationStage({
    request,
    candidate: {
      requestId: request.requestId,
      artifactKind: request.artifactKind,
      targetWitPort: targetPort,
      conformanceSuiteId: suiteId,
      ref: candidateRef
    },
    sandboxProfile: validationSandboxProfile(),
    runConformance: async () => conformanceResultFor(mode),
    replayTraces: async () => traceReplayFor(mode, parsedStub),
    seq,
    ts: fixedTs
  });
}

function conformanceResultFor(mode) {
  const conformanceFailed = mode === "conformance-mismatch";
  return {
    suiteId,
    targetPort,
    passed: !conformanceFailed,
    assertions: requiredConformanceChecks.map((checkId) => ({
      id: checkId,
      passed: mode !== "conformance-mismatch",
      message:
        mode === "conformance-mismatch"
          ? "generated implementation violated a per-interface conformance assertion"
          : undefined
    }))
  };
}

function traceReplayFor(mode, parsedStub) {
  const failed = mode === "trace-mismatch";
  return {
    passed: !failed,
    traces: parsedStub.recordings.map((recording) => ({
      id: recording.id,
      matched: !failed,
      expectedDigest: recording.outputDigest,
      actualDigest: failed ? contentDigest({ trace: "wrong-implementation-guess" }) : recording.outputDigest,
      reason: failed ? `candidate did not reproduce ${recording.id}` : undefined
    }))
  };
}

function promoteStubImplementation({ request, candidateRef, validationReport, parsedStub, seed }) {
  const gateDecision = {
    effect: "promote",
    reason: "stubbed port implementation passed conformance and reproduced all recorded traces",
    policyRef: "policy:hobo-652-stub-implementation-promote",
    policyInputHash: contentDigest({
      requestId: request.requestId,
      candidateRef,
      validationReportRef: validationReport.ref,
      stubId: parsedStub.stubId,
      traceIds: parsedStub.traceIds
    })
  };
  return Object.freeze({
    ok: true,
    gateDecision,
    candidateRef,
    stubId: parsedStub.stubId,
    reproducedTraces: [...parsedStub.traceIds],
    seed,
    event: {
      type: "impl.Promoted",
      data: {
        requestId: request.requestId,
        targetWitPort: targetPort,
        stubId: parsedStub.stubId,
        candidateRef,
        gateDecision
      }
    }
  });
}

function validationSandboxProfile() {
  return {
    schema: "hobo.sandbox.profile/v1",
    id: "hobo-652-stub-implementation-profile",
    isolation: { tier: "microvm", engine: "firecracker" },
    network: { mode: "none", allow: [] },
    filesystem: {
      scratch: "/sandbox/scratch",
      writable: ["/sandbox/scratch"],
      readonly: ["/workspace/input"]
    },
    capabilities: [
      {
        interface: "hobo:conformance/runner@0.1.0",
        stability: "preview",
        scope: { suiteId, targetPort },
        verbs: ["run"]
      }
    ],
    resources: { cpuMs: 30_000, memoryMiB: 512, wallClockMs: 60_000 },
    assertions: ["no-egress", "capability-scoped", "scratch-only-write", "resource-budgeted"]
  };
}

function repairedCandidateRef({ request, seed, previousCandidateRef, failingAssertions, iteration, parsedStub }) {
  const digest = contentDigest({
    requestId: request.requestId,
    previousCandidateRef,
    failingAssertions,
    seed,
    iteration,
    targetPort,
    suiteId,
    stubId: parsedStub.stubId
  });
  return {
    uri: `draft://hobo-652-stub-implementation/candidate-${iteration}@${digest}`,
    digest
  };
}

function digestRef(name, value) {
  const digest = contentDigest({ name, value });
  return {
    uri: `draft://hobo-652-stub-implementation/${name}@${digest}`,
    digest
  };
}

function stageResults({ promoted }) {
  return [
    { stage: "stub-recordings", status: "parsed" },
    { stage: "scaffold", status: "candidate-generated" },
    { stage: "fill", status: "candidate-generated" },
    { stage: "sandbox-validate", status: "converged-or-escalated" },
    { stage: "promote", status: promoted ? "promoted" : "not-promoted" }
  ];
}

function needsHumanResult({ request, scaffold, parsedStub }) {
  return {
    outcome: "needs-human",
    request,
    parsedStub,
    scaffold,
    fill: null,
    repair: {
      outcome: "needs-human",
      events: [scaffold.event],
      finalEvent: scaffold.event,
      repairAttempts: 0
    },
    validations: [],
    finalValidation: null,
    finalCandidateRef: null,
    conformance: { ok: false, reasons: ["scaffold did not produce a candidate"] },
    traceReplay: { ok: false, reasons: ["scaffold did not produce a candidate"] },
    promotion: null,
    stageResults: stageResults({ promoted: false })
  };
}

function assertPinnedInputs({ seed }) {
  if (!model.digest || /(^|[/:])latest($|[/:])/.test(model.id)) {
    throw new Error("generation.model_not_pinned");
  }
  if (generationConfig.temperature !== 0 || generationConfig.topP !== 1) {
    throw new Error("generation.sampling_not_deterministic");
  }
  if (!isJsonString(seed) || seed.length === 0) {
    throw new Error("generation.seed_not_pinned");
  }
}

function assertObject(value, code, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new StubRecordingsParseError(code, path);
  }
}

function assertEqual(actual, expected, code, path) {
  if (actual !== expected) {
    throw new StubRecordingsParseError(code, path);
  }
}

function assertNonEmptyString(value, code, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new StubRecordingsParseError(code, path);
  }
}
