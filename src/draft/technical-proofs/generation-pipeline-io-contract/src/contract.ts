import { isJsonString, isJsonObject } from "./json.js";
const genRequestSchema = "hobo.gen.request/v1";
const genResultSchema = "hobo.gen.result/v1";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const artifactKinds = new Set([
  "provider",
  "implementation",
  "resource-definition",
  "ui",
  "migration-importer"
]);
const gateEffects = new Set(["certify", "require-approval", "deny", "needs-human"]);
const genEventTypes = new Set([
  "gen.Requested",
  "gen.CandidateGenerated",
  "gen.Validated",
  "gen.ValidationFailed",
  "gen.SafetyRejected",
  "gen.Repaired",
  "gen.NeedsHuman",
  "gen.Certified"
]);

export class GenerationContractError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

export function validateGenRequest(request) {
  assertObject(request, "gen.request.invalid", "$");
  assertEqual(request.schema, genRequestSchema, "gen.request.schema", "$.schema");
  assertNonEmptyString(request.requestId, "gen.request.id", "$.requestId");
  if (!artifactKinds.has(request.artifactKind)) {
    throw new GenerationContractError("gen.request.artifact_kind", "$.artifactKind");
  }
  validateTarget(request.target, "$.target");
  validateDigestRef(
    request.capabilityManifestRef,
    "gen.request.capability_manifest",
    "$.capabilityManifestRef"
  );
  validateAuthoritativeRefs(request.authoritativeRefs);
  validateMaterialRefs(request.materialRefs ?? []);

  return request;
}

export function validateGenResult(result) {
  assertObject(result, "gen.result.invalid", "$");
  assertEqual(result.schema, genResultSchema, "gen.result.schema", "$.schema");
  assertNonEmptyString(result.requestId, "gen.result.request_id", "$.requestId");
  validateDigestRef(result.candidateRef, "gen.result.candidate", "$.candidateRef");
  validateDigestRef(result.validationReportRef, "gen.result.validation_report", "$.validationReportRef");
  validateDigestRef(result.provenanceRef, "gen.result.provenance", "$.provenanceRef");
  assertObject(result.gateDecision, "gen.result.gate_decision", "$.gateDecision");
  if (!gateEffects.has(result.gateDecision.effect)) {
    throw new GenerationContractError("gen.result.gate_effect", "$.gateDecision.effect");
  }
  assertNonEmptyString(result.gateDecision.policyRef, "gen.result.policy_ref", "$.gateDecision.policyRef");

  return result;
}

export function authoritativeContractFromRequest(request) {
  const validated = validateGenRequest(request);
  const conformance = validated.authoritativeRefs.find(
    (ref) => ref.kind === "conformance-suite"
  );

  return {
    requestId: validated.requestId,
    artifactKind: validated.artifactKind,
    target: { ...validated.target },
    conformanceSuiteId: conformance.suiteId,
    capabilityManifestDigest: validated.capabilityManifestRef.digest
  };
}

export function validateGenerationEvent(event) {
  validateEnvelope(event);

  switch (event.type) {
    case "gen.Requested":
      validateGenRequest(event.data);
      break;
    case "gen.CandidateGenerated":
      validateCandidateGenerated(event.data);
      break;
    case "gen.Validated":
      validateValidated(event.data);
      break;
    case "gen.ValidationFailed":
      validateValidationFailed(event.data);
      break;
    case "gen.SafetyRejected":
      validateSafetyRejected(event.data);
      break;
    case "gen.Repaired":
      validateRepaired(event.data);
      break;
    case "gen.NeedsHuman":
      validateNeedsHuman(event.data);
      break;
    case "gen.Certified":
      validateGenResult(event.data);
      break;
    default:
      throw new GenerationContractError("gen.event.type", "$.type");
  }

  validateCorrelation(event);

  return event;
}

export function appendGenerationEvent(state, event) {
  const validated = validateGenerationEvent(event);
  const next =
    state ??
    {
      streamId: validated.streamId,
      request: null,
      candidates: [],
      validations: [],
      repairs: [],
      safetyRejections: [],
      failingAssertions: [],
      needsHuman: null,
      result: null,
      finalDecision: null,
      eventTypes: []
    };

  if (next.streamId !== validated.streamId) {
    throw new GenerationContractError("gen.replay.stream_mismatch", "$.streamId");
  }

  const projected = {
    streamId: next.streamId,
    request: next.request,
    candidates: [...next.candidates],
    validations: [...next.validations],
    repairs: [...next.repairs],
    safetyRejections: [...next.safetyRejections],
    failingAssertions: [...next.failingAssertions],
    needsHuman: next.needsHuman,
    result: next.result,
    finalDecision: next.finalDecision,
    eventTypes: [...next.eventTypes, validated.type]
  };

  switch (validated.type) {
    case "gen.Requested":
      projected.request = validated.data;
      break;
    case "gen.CandidateGenerated":
      projected.candidates.push({
        candidateRef: validated.data.candidateRef,
        iteration: validated.data.iteration
      });
      break;
    case "gen.ValidationFailed":
      projected.validations.push({
        candidateRef: validated.data.candidateRef,
        validationReportRef: validated.data.validationReportRef,
        passed: false
      });
      projected.failingAssertions = unionStrings(
        projected.failingAssertions,
        validated.data.failingAssertions
      );
      break;
    case "gen.SafetyRejected":
      projected.safetyRejections.push({
        candidateRef: validated.data.candidateRef,
        validationReportRef: validated.data.validationReportRef,
        safetyReportRef: validated.data.safetyReportRef,
        findings: [...validated.data.failingAssertions]
      });
      projected.finalDecision = { effect: "deny", reason: "safety-rejected" };
      projected.failingAssertions = unionStrings(
        projected.failingAssertions,
        validated.data.failingAssertions
      );
      break;
    case "gen.Repaired":
      projected.repairs.push({
        candidateRef: validated.data.candidateRef,
        iteration: validated.data.iteration,
        failingAssertions: [...validated.data.failingAssertions]
      });
      projected.failingAssertions = unionStrings(
        projected.failingAssertions,
        validated.data.failingAssertions
      );
      break;
    case "gen.Validated":
      projected.validations.push({
        candidateRef: validated.data.candidateRef,
        validationReportRef: validated.data.validationReportRef,
        passed: true
      });
      break;
    case "gen.NeedsHuman":
      projected.needsHuman = validated.data;
      projected.finalDecision = { effect: "needs-human", reason: validated.data.reason };
      projected.failingAssertions = unionStrings(
        projected.failingAssertions,
        validated.data.failingAssertions
      );
      break;
    case "gen.Certified":
      projected.result = validated.data;
      projected.finalDecision = validated.data.gateDecision;
      break;
  }

  return projected;
}

export function rebuildGenerationRun(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new GenerationContractError("gen.replay.events_required", "$");
  }

  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .reduce(appendGenerationEvent, undefined);
}

function validateTarget(target, path) {
  assertObject(target, "gen.request.target", path);
  assertNonEmptyString(target.witPort, "gen.request.target_wit_port", `${path}.witPort`);
}

function validateAuthoritativeRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new GenerationContractError("gen.request.authoritative_refs", "$.authoritativeRefs");
  }

  let hasConformanceSuite = false;
  for (const [index, ref] of refs.entries()) {
    const path = `$.authoritativeRefs[${index}]`;
    assertObject(ref, "gen.request.authoritative_ref", path);
    assertNonEmptyString(ref.kind, "gen.request.authoritative_ref_kind", `${path}.kind`);
    assertNonEmptyString(ref.ref, "gen.request.authoritative_ref_ref", `${path}.ref`);
    if (ref.kind === "conformance-suite") {
      assertNonEmptyString(ref.suiteId, "gen.request.conformance_suite", `${path}.suiteId`);
      hasConformanceSuite = true;
    }
  }

  if (!hasConformanceSuite) {
    throw new GenerationContractError("gen.request.conformance_suite_required", "$.authoritativeRefs");
  }
}

function validateMaterialRefs(refs) {
  if (!Array.isArray(refs)) {
    throw new GenerationContractError("gen.request.material_refs", "$.materialRefs");
  }

  for (const [index, ref] of refs.entries()) {
    const path = `$.materialRefs[${index}]`;
    assertObject(ref, "gen.request.material_ref", path);
    assertNonEmptyString(ref.kind, "gen.request.material_ref_kind", `${path}.kind`);
    assertNonEmptyString(ref.ref, "gen.request.material_ref_ref", `${path}.ref`);
    if (ref.trusted !== false) {
      throw new GenerationContractError("gen.request.material_must_be_untrusted", `${path}.trusted`);
    }
    if (ref.sanitized !== true) {
      throw new GenerationContractError("gen.request.material_must_be_sanitized", `${path}.sanitized`);
    }
  }
}

function validateDigestRef(ref, code, path) {
  assertObject(ref, code, path);
  assertNonEmptyString(ref.uri, code, `${path}.uri`);
  if (!digestPattern.test(ref.digest ?? "")) {
    throw new GenerationContractError(`${code}_digest`, `${path}.digest`);
  }
}

function validateEnvelope(event) {
  assertObject(event, "gen.event.invalid", "$");
  assertNonEmptyString(event.id, "gen.event.id", "$.id");
  if (!genEventTypes.has(event.type)) {
    throw new GenerationContractError("gen.event.type", "$.type");
  }
  assertEqual(event.v, 1, "gen.event.version", "$.v");
  assertNonEmptyString(event.streamId, "gen.event.stream_id", "$.streamId");
  if (!Number.isInteger(event.seq) || event.seq <= 0) {
    throw new GenerationContractError("gen.event.seq", "$.seq");
  }
  assertNonEmptyString(event.ts, "gen.event.ts", "$.ts");
  if (Number.isNaN(Date.parse(event.ts))) {
    throw new GenerationContractError("gen.event.ts", "$.ts");
  }
  assertObject(event.actor, "gen.event.actor", "$.actor");
  assertNonEmptyString(event.actor.kind, "gen.event.actor_kind", "$.actor.kind");
  assertNonEmptyString(event.actor.id, "gen.event.actor_id", "$.actor.id");
  assertNonEmptyString(event.tenant, "gen.event.tenant", "$.tenant");
  assertObject(event.data, "gen.event.data", "$.data");
}

function validateCorrelation(event) {
  assertNonEmptyString(event.correlationId, "gen.event.correlation_id", "$.correlationId");
  if (event.correlationId !== event.data.requestId) {
    throw new GenerationContractError("gen.event.correlation_mismatch", "$.correlationId");
  }
}

function validateCandidateGenerated(data) {
  assertEventRequestId(data);
  validateDigestRef(data.candidateRef, "gen.event.candidate", "$.data.candidateRef");
  assertNonNegativeInteger(data.iteration, "gen.event.iteration", "$.data.iteration");
}

function validateValidated(data) {
  assertEventRequestId(data);
  validateDigestRef(data.candidateRef, "gen.event.candidate", "$.data.candidateRef");
  validateDigestRef(
    data.validationReportRef,
    "gen.event.validation_report",
    "$.data.validationReportRef"
  );
  assertEqual(data.passed, true, "gen.event.validated_passed", "$.data.passed");
}

function validateValidationFailed(data) {
  assertEventRequestId(data);
  validateDigestRef(data.candidateRef, "gen.event.candidate", "$.data.candidateRef");
  validateDigestRef(
    data.validationReportRef,
    "gen.event.validation_report",
    "$.data.validationReportRef"
  );
  assertFailingAssertions(data.failingAssertions);
}

function validateSafetyRejected(data) {
  assertEventRequestId(data);
  validateDigestRef(data.candidateRef, "gen.event.candidate", "$.data.candidateRef");
  validateDigestRef(
    data.validationReportRef,
    "gen.event.validation_report",
    "$.data.validationReportRef"
  );
  validateDigestRef(data.safetyReportRef, "gen.event.safety_report", "$.data.safetyReportRef");
  assertFailingAssertions(data.failingAssertions);
}

function validateRepaired(data) {
  assertEventRequestId(data);
  validateDigestRef(data.candidateRef, "gen.event.candidate", "$.data.candidateRef");
  if (!Number.isInteger(data.iteration) || data.iteration < 1) {
    throw new GenerationContractError("gen.event.iteration", "$.data.iteration");
  }
  assertFailingAssertions(data.failingAssertions);
}

function validateNeedsHuman(data) {
  assertEventRequestId(data);
  assertNonEmptyString(data.reason, "gen.event.needs_human_reason", "$.data.reason");
  assertEqual(data.budgetExhausted, true, "gen.event.budget_exhausted", "$.data.budgetExhausted");
  assertFailingAssertions(data.failingAssertions);
}

function assertEventRequestId(data) {
  assertObject(data, "gen.event.data", "$.data");
  assertNonEmptyString(data.requestId, "gen.event.request_id", "$.data.requestId");
}

function assertNonNegativeInteger(value, code, path) {
  if (!Number.isInteger(value) || value < 0) {
    throw new GenerationContractError(code, path);
  }
}

function assertFailingAssertions(assertions) {
  if (
    !Array.isArray(assertions) ||
    assertions.length === 0 ||
    !assertions.every((assertion) => isJsonString(assertion) && assertion.length > 0)
  ) {
    throw new GenerationContractError("gen.event.failing_assertions", "$.data.failingAssertions");
  }
}

function unionStrings(left, right) {
  return [...new Set([...left, ...right])];
}

function assertObject(value, code, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new GenerationContractError(code, path);
  }
}

function assertEqual(actual, expected, code, path) {
  if (actual !== expected) {
    throw new GenerationContractError(code, path);
  }
}

function assertNonEmptyString(value, code, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new GenerationContractError(code, path);
  }
}
