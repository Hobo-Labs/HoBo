import { createHash } from "node:crypto";

import {
  authoritativeContractFromRequest,
  validateGenerationEvent,
  validateGenRequest
} from "../../generation-pipeline-io-contract/src/contract.js";
import {
  declareConformanceRun,
  profileDigest,
  validateSandboxProfile
} from "../../no-egress-generation-sandbox-contract/src/contract.js";
import { isJsonString, isJsonBoolean, isJsonObject } from "./json.js";


const validationReportSchema = "hobo.gen.validation-report/v1";
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export class ValidationStageContractError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

export async function runValidationStage(input) {
  assertObject(input, "validation.input", "$");
  const request = validateGenRequest(input.request);
  const contract = authoritativeContractFromRequest(request);
  const candidate = validateCandidate(input.candidate, contract);
  const sandboxProfile = validateSandboxProfile(input.sandboxProfile);
  const runConformance = assertFunction(
    input.runConformance,
    "validation.run_conformance",
    "$.runConformance"
  );
  const replayTraces = assertFunction(input.replayTraces, "validation.replay_traces", "$.replayTraces");

  const sandbox = declareConformanceRun(sandboxProfile, {
    runId: request.requestId,
    suiteId: contract.conformanceSuiteId,
    artifactKind: request.artifactKind,
    targetPort: contract.target.witPort,
    validator: input.validator ?? "@hobo/conformance"
  });

  const runnerInput = {
    request,
    candidate,
    candidateRef: candidate.ref,
    sandbox,
    suiteId: contract.conformanceSuiteId,
    targetPort: contract.target.witPort
  };

  const conformance = normalizeConformanceResult(await runConformance(runnerInput), contract);
  const traceReplay = normalizeTraceReplayResult(
    await replayTraces({
      ...runnerInput,
      traces: request.materialRefs.filter((ref) => ref.kind === "recorded-traces")
    })
  );

  const reportPayload = {
    schema: validationReportSchema,
    requestId: request.requestId,
    candidateRef: candidate.ref,
    targetWitPort: contract.target.witPort,
    sandbox: {
      profileId: sandboxProfile.id,
      profileDigest: profileDigest(sandboxProfile),
      declaration: sandbox
    },
    conformance,
    traceReplay,
    passed: conformance.passed && traceReplay.passed
  };
  const reportDigest = sha256Digest(reportPayload);
  const report = {
    ...reportPayload,
    ref: {
      uri: `draft://generation-validation/${request.requestId}/report@${reportDigest}`,
      digest: reportDigest
    }
  };
  validateValidationReport(report);

  const failingAssertions = collectFailingAssertions(report);
  const data = {
    requestId: request.requestId,
    candidateRef: candidate.ref,
    validationReportRef: report.ref
  };
  if (report.passed) {
    data.passed = true;
  } else {
    data.failingAssertions = failingAssertions;
  }

  const event = validateGenerationEvent({
    id: eventId(request.requestId, reportDigest),
    type: report.passed ? "gen.Validated" : "gen.ValidationFailed",
    v: 1,
    streamId: input.streamId ?? `generation:${request.requestId}`,
    seq: input.seq ?? 1,
    ts: input.ts ?? new Date(0).toISOString(),
    actor: input.actor ?? {
      kind: "agent",
      id: "agent:generation-validator"
    },
    tenant: input.tenant ?? "tenant:demo",
    correlationId: request.requestId,
    data
  });

  return {
    outcome: report.passed ? "validated" : "validation-failed",
    event,
    report
  };
}

export function validateValidationReport(report) {
  assertObject(report, "validation.report", "$");
  assertEqual(report.schema, validationReportSchema, "validation.report_schema", "$.schema");
  assertNonEmptyString(report.requestId, "validation.report_request", "$.requestId");
  validateDigestRef(report.candidateRef, "validation.report_candidate", "$.candidateRef");
  assertNonEmptyString(report.targetWitPort, "validation.report_target", "$.targetWitPort");
  validateSandboxReport(report.sandbox);
  validateConformanceReport(report.conformance);
  validateTraceReplayReport(report.traceReplay);
  assertBoolean(report.passed, "validation.report_passed", "$.passed");
  validateDigestRef(report.ref, "validation.report_ref", "$.ref");

  const { ref, ...payload } = report;
  const expectedDigest = sha256Digest(payload);
  if (ref.digest !== expectedDigest) {
    throw new ValidationStageContractError("validation.report_digest_mismatch", "$.ref.digest");
  }

  const hasFailures = collectFailingAssertions(report).length > 0;
  if (report.passed === hasFailures) {
    throw new ValidationStageContractError("validation.report_passed_mismatch", "$.passed");
  }

  return report;
}

function validateCandidate(candidate, contract) {
  assertObject(candidate, "validation.candidate", "$.candidate");
  assertEqual(
    candidate.requestId,
    contract.requestId,
    "validation.candidate_request_mismatch",
    "$.candidate.requestId"
  );
  assertEqual(
    candidate.artifactKind,
    contract.artifactKind,
    "validation.candidate_artifact_mismatch",
    "$.candidate.artifactKind"
  );
  assertEqual(
    candidate.targetWitPort,
    contract.target.witPort,
    "validation.candidate_target_mismatch",
    "$.candidate.targetWitPort"
  );
  assertEqual(
    candidate.conformanceSuiteId,
    contract.conformanceSuiteId,
    "validation.candidate_suite_mismatch",
    "$.candidate.conformanceSuiteId"
  );
  validateDigestRef(candidate.ref, "validation.candidate_ref", "$.candidate.ref");

  return candidate;
}

function normalizeConformanceResult(result, contract) {
  assertObject(result, "validation.conformance_result", "$.conformance");
  assertEqual(
    result.suiteId,
    contract.conformanceSuiteId,
    "validation.suite_mismatch",
    "$.conformance.suiteId"
  );
  assertEqual(
    result.targetPort,
    contract.target.witPort,
    "validation.suite_mismatch",
    "$.conformance.targetPort"
  );
  assertBoolean(result.passed, "validation.conformance_passed", "$.conformance.passed");
  if (!Array.isArray(result.assertions)) {
    throw new ValidationStageContractError("validation.conformance_assertions", "$.conformance.assertions");
  }

  const assertions = result.assertions.map((assertion, index) => {
    const path = `$.conformance.assertions[${index}]`;
    assertObject(assertion, "validation.conformance_assertion", path);
    assertNonEmptyString(assertion.id, "validation.conformance_assertion_id", `${path}.id`);
    assertBoolean(assertion.passed, "validation.conformance_assertion_passed", `${path}.passed`);
    return {
      id: assertion.id,
      passed: assertion.passed,
      message: assertion.message
    };
  });

  if (!result.passed && assertions.every((assertion) => assertion.passed)) {
    assertions.push({
      id: "unknown",
      passed: false,
      message: "conformance runner failed without a specific assertion"
    });
  }

  return {
    suiteId: result.suiteId,
    targetPort: result.targetPort,
    passed: result.passed,
    assertions
  };
}

function normalizeTraceReplayResult(result) {
  assertObject(result, "validation.trace_replay_result", "$.traceReplay");
  assertBoolean(result.passed, "validation.trace_replay_passed", "$.traceReplay.passed");
  if (!Array.isArray(result.traces)) {
    throw new ValidationStageContractError("validation.trace_replay_traces", "$.traceReplay.traces");
  }

  const diffs = [];
  for (const [index, trace] of result.traces.entries()) {
    const path = `$.traceReplay.traces[${index}]`;
    assertObject(trace, "validation.trace", path);
    assertNonEmptyString(trace.id, "validation.trace_id", `${path}.id`);
    assertBoolean(trace.matched, "validation.trace_matched", `${path}.matched`);
    if (!trace.matched) {
      diffs.push({
        id: trace.id,
        expectedDigest: trace.expectedDigest,
        actualDigest: trace.actualDigest,
        reason: trace.reason
      });
    }
  }

  if (!result.passed && diffs.length === 0) {
    diffs.push({
      id: "unknown",
      reason: "trace replay failed without a specific diff"
    });
  }

  return {
    passed: result.passed,
    diffs
  };
}

function validateSandboxReport(sandbox) {
  assertObject(sandbox, "validation.report_sandbox", "$.sandbox");
  assertNonEmptyString(sandbox.profileId, "validation.report_profile", "$.sandbox.profileId");
  if (!digestPattern.test(sandbox.profileDigest ?? "")) {
    throw new ValidationStageContractError("validation.report_profile_digest", "$.sandbox.profileDigest");
  }
  assertObject(sandbox.declaration, "validation.report_sandbox_declaration", "$.sandbox.declaration");
  assertEqual(
    sandbox.declaration.profileDigest,
    sandbox.profileDigest,
    "validation.report_sandbox_digest_mismatch",
    "$.sandbox.declaration.profileDigest"
  );
}

function validateConformanceReport(conformance) {
  assertObject(conformance, "validation.report_conformance", "$.conformance");
  assertNonEmptyString(conformance.suiteId, "validation.report_suite", "$.conformance.suiteId");
  assertNonEmptyString(conformance.targetPort, "validation.report_target_port", "$.conformance.targetPort");
  assertBoolean(conformance.passed, "validation.report_conformance_passed", "$.conformance.passed");
  if (!Array.isArray(conformance.assertions)) {
    throw new ValidationStageContractError(
      "validation.report_conformance_assertions",
      "$.conformance.assertions"
    );
  }
  for (const [index, assertion] of conformance.assertions.entries()) {
    const path = `$.conformance.assertions[${index}]`;
    assertObject(assertion, "validation.report_conformance_assertion", path);
    assertNonEmptyString(assertion.id, "validation.report_conformance_assertion_id", `${path}.id`);
    assertBoolean(assertion.passed, "validation.report_conformance_assertion_passed", `${path}.passed`);
  }
}

function validateTraceReplayReport(traceReplay) {
  assertObject(traceReplay, "validation.report_trace_replay", "$.traceReplay");
  assertBoolean(traceReplay.passed, "validation.report_trace_replay_passed", "$.traceReplay.passed");
  if (!Array.isArray(traceReplay.diffs)) {
    throw new ValidationStageContractError("validation.report_trace_replay_diffs", "$.traceReplay.diffs");
  }
  for (const [index, diff] of traceReplay.diffs.entries()) {
    const path = `$.traceReplay.diffs[${index}]`;
    assertObject(diff, "validation.report_trace_diff", path);
    assertNonEmptyString(diff.id, "validation.report_trace_diff_id", `${path}.id`);
  }
}

function collectFailingAssertions(report) {
  return [
    ...report.conformance.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => `conformance:${assertion.id}`),
    ...report.traceReplay.diffs.map((diff) => `trace:${diff.id}`)
  ];
}

function eventId(requestId, reportDigest) {
  return `gen-validation-${requestId}-${reportDigest.slice("sha256:".length, "sha256:".length + 12)}`;
}

function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function validateDigestRef(ref, code, path) {
  assertObject(ref, code, path);
  assertNonEmptyString(ref.uri, code, `${path}.uri`);
  if (!digestPattern.test(ref.digest ?? "")) {
    throw new ValidationStageContractError(`${code}_digest`, `${path}.digest`);
  }
}

function assertFunction(value, code, path) {
  if (!(value instanceof Function)) {
    throw new ValidationStageContractError(code, path);
  }
  return value;
}

function assertObject(value, code, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new ValidationStageContractError(code, path);
  }
}

function assertBoolean(value, code, path) {
  if (!isJsonBoolean(value)) {
    throw new ValidationStageContractError(code, path);
  }
}

function assertEqual(actual, expected, code, path) {
  if (actual !== expected) {
    throw new ValidationStageContractError(code, path);
  }
}

function assertNonEmptyString(value, code, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new ValidationStageContractError(code, path);
  }
}

function stableStringify(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
