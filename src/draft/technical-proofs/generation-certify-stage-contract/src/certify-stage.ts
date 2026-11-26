import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import {
  contentDigest,
  makeConformanceReportRef,
  signProvenanceRecord,
  validateProvenanceRecord,
  verifyProvenanceRecord
} from "../../slsa-provenance-certification-contract/src/provenance.js";
import { isJsonString, isJsonObject } from "./json.js";


export const CERTIFICATION_RECORD_SCHEMA = "hobo.gen.certification-record/v1";

const supportedSignatureAlg = "Ed25519";
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export class CertifyStageContractError extends Error {
  constructor(code, path = "$", message = code) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CertifyStageContractError";
    this.code = code;
    this.path = path;
  }
}

export function createGenerationCertifyStage({ registry, signingKey } = {}) {
  const targetRegistry = registry ?? createInMemoryCertificationRegistry({
    trustedKeys: { [signingKey?.keyId]: signingKey?.publicKeyPem }
  });
  assertSigningKey(signingKey);
  if (!targetRegistry || !(targetRegistry.publish instanceof Function)) {
    throw new CertifyStageContractError("certify.registry_required", "$.registry");
  }

  return Object.freeze({
    certify(input) {
      const record = createCertificationRecord(input, signingKey);
      return targetRegistry.publish(record);
    }
  });
}

export function createCertificationRecord(input, signingKey) {
  assertSigningKey(signingKey);
  const parsed = parseCertificationInput(input);
  const conformanceReportRef = makeConformanceReportRef(
    parsed.conformanceReport,
    signingKey.privateKeyPem
  );
  const provenance = signProvenanceRecord(
    {
      schema: "hobo.generation.provenance/v1",
      artifact: {
        kind: parsed.candidate.artifactKind,
        name: parsed.candidate.name,
        digest: parsed.candidate.artifactRef.digest
      },
      model: parsed.model,
      prompt: parsed.prompt,
      seed: parsed.seed,
      conformanceReportRef,
      evalReportRefs: parsed.evalReports,
      issuedAt: parsed.certifiedAt
    },
    signingKey.privateKeyPem
  );

  return signCertificationRecord(
    {
      payload: {
        schema: CERTIFICATION_RECORD_SCHEMA,
        requestId: parsed.requestId,
        status: "Certified",
        artifactKind: parsed.candidate.artifactKind,
        name: parsed.candidate.name,
        version: parsed.candidate.version,
        artifactRef: parsed.candidate.artifactRef,
        claimedPorts: parsed.candidate.claimedPorts,
        validationReport: parsed.validationReport,
        validationReportRef: parsed.validationReport.ref,
        conformanceReport: parsed.conformanceReport,
        conformanceReportRef,
        provenance,
        gateDecision: parsed.gateDecision,
        registryCoordinate: `${parsed.candidate.name}@${parsed.candidate.version}`,
        certifiedAt: parsed.certifiedAt
      }
    },
    signingKey
  );
}

export function signCertificationRecord(record, signingKey) {
  assertSigningKey(signingKey);
  const payload = clone(expectObject(record, "$").payload ?? record);
  return Object.freeze({
    kind: "generation-certification",
    payload,
    signature: signPayload(payload, signingKey)
  });
}

export function verifyCertificationRecord(record, publicKeyPem) {
  const signature = record?.signature;
  if (!signature?.keyId) {
    return false;
  }
  return verificationReasons(record, { [signature.keyId]: publicKeyPem }).length === 0;
}

export function createInMemoryCertificationRegistry({ trustedKeys = {} } = {}) {
  const records = [];
  const events = [];

  return Object.freeze({
    publish(record) {
      const reasons = verificationReasons(record, trustedKeys);
      if (reasons.length > 0) {
        return rejected(reasons);
      }

      const storedRecord = clone(record);
      records.push(Object.freeze(storedRecord));
      const emitted = certificationEvents(storedRecord, events.length + 1);
      events.push(...emitted.map(Object.freeze));

      return Object.freeze({
        ok: true,
        status: "Certified",
        reasons: Object.freeze([]),
        record: clone(storedRecord)
      });
    },

    certified() {
      return records.map(clone);
    },

    events() {
      return events.map(clone);
    }
  });
}

function parseCertificationInput(input) {
  const parsed = expectObject(input, "$");
  const requestId = nonEmptyString(parsed.requestId, "$.requestId");
  const candidate = parseCandidate(parsed.candidate);
  const validationReport = parseValidationReport(parsed.validationReport, requestId, candidate);
  const conformanceReport = parseConformanceReport(parsed.conformanceReport, requestId);
  const evalReports = parseEvalReports(parsed.evalReports);
  const model = parseModel(parsed.model);
  const prompt = parsePrompt(parsed.prompt);
  const seed = nonEmptyString(parsed.seed, "$.seed");
  const gateDecision = parseGateDecision(parsed.gateDecision);
  const certifiedAt = isoTimestamp(parsed.certifiedAt, "$.certifiedAt");

  ensureClaimedPortsCovered(candidate, validationReport);
  ensureConformanceMatchesValidation(conformanceReport, validationReport);

  return {
    requestId,
    candidate,
    validationReport,
    conformanceReport,
    evalReports,
    model,
    prompt,
    seed,
    gateDecision,
    certifiedAt
  };
}

function parseCandidate(input) {
  const candidate = expectObject(input, "$.candidate");
  const artifactRef = parseDigestRef(candidate.artifactRef, "$.candidate.artifactRef");
  return Object.freeze({
    artifactKind: nonEmptyString(candidate.artifactKind, "$.candidate.artifactKind"),
    name: nonEmptyString(candidate.name, "$.candidate.name"),
    version: nonEmptyString(candidate.version, "$.candidate.version"),
    artifactRef: Object.freeze({
      ...artifactRef,
      mediaType: nonEmptyString(candidate.artifactRef.mediaType, "$.candidate.artifactRef.mediaType")
    }),
    claimedPorts: stringArray(candidate.claimedPorts, "$.candidate.claimedPorts")
  });
}

function parseValidationReport(input, requestId, candidate) {
  const report = expectObject(input, "$.validationReport");
  equal(report.schema, "hobo.gen.validation-report/v1", "certify.validation_report_schema", "$.validationReport.schema");
  equal(report.requestId, requestId, "certify.validation_request_mismatch", "$.validationReport.requestId");
  equal(report.passed, true, "certify.validation_not_green", "$.validationReport.passed");
  parseDigestRef(report.candidateRef, "$.validationReport.candidateRef");
  equal(
    report.candidateRef.digest,
    candidate.artifactRef.digest,
    "certify.validation_candidate_digest_mismatch",
    "$.validationReport.candidateRef.digest"
  );
  parseDigestRef(report.ref, "$.validationReport.ref");

  const { ref, ...payload } = report;
  equal(ref.digest, contentDigest(payload), "certify.validation_report_digest_mismatch", "$.validationReport.ref.digest");

  if (!Array.isArray(report.coveredPorts) || report.coveredPorts.length === 0) {
    throw new CertifyStageContractError("certify.validation_covered_ports_required", "$.validationReport.coveredPorts");
  }
  for (const [index, covered] of report.coveredPorts.entries()) {
    const path = `$.validationReport.coveredPorts[${index}]`;
    expectObject(covered, path);
    nonEmptyString(covered.witPort, `${path}.witPort`);
    nonEmptyString(covered.suiteId, `${path}.suiteId`);
    equal(covered.passed, true, "certify.validation_covered_port_not_green", `${path}.passed`);
  }

  return clone(report);
}

function parseConformanceReport(input, requestId) {
  const report = expectObject(input, "$.conformanceReport");
  equal(report.schema, "hobo.conformance.report/v1", "certify.conformance_report_schema", "$.conformanceReport.schema");
  equal(report.runId, requestId, "certify.conformance_run_mismatch", "$.conformanceReport.runId");
  equal(report.passed, true, "certify.conformance_not_green", "$.conformanceReport.passed");
  nonEmptyString(report.suiteId, "$.conformanceReport.suiteId");
  nonEmptyString(report.targetPort, "$.conformanceReport.targetPort");
  return clone(report);
}

function parseEvalReports(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new CertifyStageContractError("certify.eval_reports_required", "$.evalReports");
  }
  return input.map((report, index) => {
    const path = `$.evalReports[${index}]`;
    const parsed = expectObject(report, path);
    return Object.freeze({
      kind: nonEmptyString(parsed.kind, `${path}.kind`),
      name: nonEmptyString(parsed.name, `${path}.name`),
      digest: digest(parsed.digest, `${path}.digest`)
    });
  });
}

function parseModel(input) {
  const model = expectObject(input, "$.model");
  return Object.freeze({
    provider: nonEmptyString(model.provider, "$.model.provider"),
    id: nonEmptyString(model.id, "$.model.id"),
    digest: digest(model.digest, "$.model.digest")
  });
}

function parsePrompt(input) {
  const prompt = expectObject(input, "$.prompt");
  return Object.freeze({
    id: nonEmptyString(prompt.id, "$.prompt.id"),
    frozenPromptDigest: digest(prompt.frozenPromptDigest, "$.prompt.frozenPromptDigest")
  });
}

function parseGateDecision(input) {
  const decision = expectObject(input, "$.gateDecision");
  if (decision.effect !== "certify") {
    throw new CertifyStageContractError("certify.policy_not_certified", "$.gateDecision.effect");
  }
  return Object.freeze({
    effect: "certify",
    reason: nonEmptyString(decision.reason, "$.gateDecision.reason"),
    policyRef: nonEmptyString(decision.policyRef, "$.gateDecision.policyRef"),
    policyInputHash: digest(decision.policyInputHash, "$.gateDecision.policyInputHash")
  });
}

function ensureClaimedPortsCovered(candidate, validationReport) {
  const coveredPorts = new Set(
    validationReport.coveredPorts
      .filter((covered) => covered.passed === true)
      .map((covered) => covered.witPort)
  );
  for (const port of candidate.claimedPorts) {
    if (!coveredPorts.has(port)) {
      throw new CertifyStageContractError("certify.claimed_port_unvalidated", "$.candidate.claimedPorts");
    }
  }
}

function ensureConformanceMatchesValidation(conformanceReport, validationReport) {
  const matchingCoveredPort = validationReport.coveredPorts.find(
    (covered) =>
      covered.witPort === conformanceReport.targetPort &&
      covered.suiteId === conformanceReport.suiteId
  );
  if (!matchingCoveredPort) {
    throw new CertifyStageContractError("certify.conformance_not_covered", "$.conformanceReport");
  }
}

function verificationReasons(record, trustedKeys) {
  const reasons = [];
  const parsed = validateRecordContract(record, reasons);
  if (!parsed) {
    return reasons;
  }

  const { payload, signature } = parsed;
  const publicKeyPem = trustedKeys[signature.keyId];
  if (!publicKeyPem) {
    reasons.push("registry.signing_key_untrusted");
    return reasons;
  }
  if (!verifyPayload(payload, signature, publicKeyPem)) {
    reasons.push("registry.signature_invalid");
  }

  validateRecordPayload(payload, publicKeyPem, reasons);
  return unique(reasons);
}

function validateRecordContract(record, reasons) {
  if (!record || !isJsonObject(record) || Array.isArray(record)) {
    reasons.push("registry.record_required");
    return null;
  }
  if (record.kind !== "generation-certification") {
    reasons.push("registry.record_kind");
  }
  if (!record.payload || !isJsonObject(record.payload) || Array.isArray(record.payload)) {
    reasons.push("registry.payload_required");
    return null;
  }
  if (!record.signature || !isJsonObject(record.signature) || Array.isArray(record.signature)) {
    reasons.push("registry.signature_required");
    return null;
  }

  const signature = record.signature;
  if (signature.alg !== supportedSignatureAlg) {
    reasons.push("registry.signature_alg");
  }
  if (!isJsonString(signature.keyId) || signature.keyId.length === 0) {
    reasons.push("registry.signature_key_required");
  }
  if (!isJsonString(signature.value) || signature.value.length === 0) {
    reasons.push("registry.signature_required");
  }
  if (signature.payloadDigest !== contentDigest(record.payload)) {
    reasons.push("registry.signature_payload_digest_mismatch");
  }

  return {
    payload: record.payload,
    signature
  };
}

function validateRecordPayload(payload, publicKeyPem, reasons) {
  if (payload.schema !== CERTIFICATION_RECORD_SCHEMA) {
    reasons.push("registry.payload_schema");
  }
  if (payload.status !== "Certified") {
    reasons.push("registry.status_not_certified");
  }
  if (payload.gateDecision?.effect !== "certify") {
    reasons.push("registry.policy_not_certified");
  }
  if (!isObject(payload.validationReport)) {
    reasons.push("registry.validation_report_required");
  }
  if (!isObject(payload.conformanceReport)) {
    reasons.push("registry.conformance_report_required");
  }
  if (!payload.validationReport?.passed) {
    reasons.push("registry.validation_not_green");
  }
  if (!payload.conformanceReport?.passed) {
    reasons.push("registry.conformance_not_green");
  }
  if (payload.artifactRef?.digest !== payload.validationReport?.candidateRef?.digest) {
    reasons.push("registry.validation_candidate_digest_mismatch");
  }
  if (payload.validationReportRef?.digest !== payload.validationReport?.ref?.digest) {
    reasons.push("registry.validation_report_ref_mismatch");
  }
  if (
    payload.validationReport &&
    payload.validationReportRef?.digest !== contentDigest(withoutRef(payload.validationReport))
  ) {
    reasons.push("registry.validation_report_digest_mismatch");
  }

  try {
    validateProvenanceRecord(payload.provenance);
  } catch (error) {
    reasons.push(`registry.provenance_incomplete:${error.code ?? "invalid"}`);
    return;
  }

  if (!verifyProvenanceRecord(payload.provenance, publicKeyPem)) {
    reasons.push("registry.provenance_signature_invalid");
  }
  if (payload.provenance.payload.artifact.digest !== payload.artifactRef?.digest) {
    reasons.push("registry.provenance_artifact_digest_mismatch");
  }
  if (
    payload.conformanceReport &&
    payload.provenance.payload.conformanceReportRef.digest !== contentDigest(payload.conformanceReport)
  ) {
    reasons.push("registry.provenance_report_digest_mismatch");
  }
  if (
    payload.conformanceReportRef?.digest !==
    payload.provenance.payload.conformanceReportRef.digest
  ) {
    reasons.push("registry.conformance_report_ref_mismatch");
  }

  const coveredPorts = new Set(
    (payload.validationReport?.coveredPorts ?? [])
      .filter((covered) => covered?.passed === true)
      .map((covered) => covered.witPort)
  );
  for (const port of payload.claimedPorts ?? []) {
    if (!coveredPorts.has(port)) {
      reasons.push("registry.claimed_port_unvalidated");
    }
  }
}

function certificationEvents(record, startSeq) {
  const provenanceDigest = contentDigest(record.payload.provenance);
  const registryRecordDigest = contentDigest(record.payload);
  const base = {
    v: 1,
    streamId: `generation-certify:${record.payload.requestId}`,
    ts: record.payload.certifiedAt,
    correlationId: record.payload.requestId
  };
  return [
    {
      ...base,
      id: `${record.payload.requestId}:gen.Certified`,
      seq: startSeq,
      type: "gen.Certified",
      data: {
        requestId: record.payload.requestId,
        candidateRef: record.payload.artifactRef,
        validationReportRef: record.payload.validationReportRef,
        provenanceRef: {
          kind: "generation-provenance",
          digest: provenanceDigest,
          signature: {
            alg: record.payload.provenance.signature.alg,
            payloadDigest: record.payload.provenance.signature.payloadDigest
          }
        },
        registryRecordDigest
      }
    },
    {
      ...base,
      id: `${record.payload.requestId}:gen.PluginCertified`,
      seq: startSeq + 1,
      type: "gen.PluginCertified",
      data: {
        requestId: record.payload.requestId,
        name: record.payload.name,
        version: record.payload.version,
        registryCoordinate: record.payload.registryCoordinate,
        artifactRef: record.payload.artifactRef,
        claimedPorts: record.payload.claimedPorts,
        provenanceRef: {
          kind: "generation-provenance",
          digest: provenanceDigest
        },
        registryRecordDigest
      }
    }
  ];
}

function signPayload(payload, signingKey) {
  const payloadDigest = contentDigest(payload);
  return Object.freeze({
    alg: supportedSignatureAlg,
    keyId: signingKey.keyId,
    payloadDigest,
    value: sign(
      null,
      Buffer.from(stableStringify(payload)),
      createPrivateKey(signingKey.privateKeyPem)
    ).toString("base64url")
  });
}

function verifyPayload(payload, signature, publicKeyPem) {
  try {
    return verify(
      null,
      Buffer.from(stableStringify(payload)),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.value, "base64url")
    );
  } catch {
    return false;
  }
}

function assertSigningKey(signingKey) {
  const key = expectObject(signingKey, "$.signingKey");
  nonEmptyString(key.keyId, "$.signingKey.keyId");
  nonEmptyString(key.publicKeyPem, "$.signingKey.publicKeyPem");
  nonEmptyString(key.privateKeyPem, "$.signingKey.privateKeyPem");
}

function parseDigestRef(ref, path) {
  const parsed = expectObject(ref, path);
  return Object.freeze({
    uri: nonEmptyString(parsed.uri, `${path}.uri`),
    digest: digest(parsed.digest, `${path}.digest`)
  });
}

function withoutRef(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  const { ref: _ref, ...rest } = value;
  return rest;
}

function rejected(reasons) {
  return Object.freeze({
    ok: false,
    status: "Rejected",
    reasons: unique(reasons),
    record: null
  });
}

function unique(values) {
  return Object.freeze([...new Set(values)]);
}

function equal(actual, expected, code, path) {
  if (actual !== expected) {
    throw new CertifyStageContractError(code, path);
  }
}

function expectObject(value, path) {
  if (!isObject(value)) {
    throw new CertifyStageContractError("certify.expected_object", path);
  }
  return value;
}

function isObject(value) {
  return Boolean(value && isJsonObject(value) && !Array.isArray(value));
}

function nonEmptyString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new CertifyStageContractError("certify.expected_string", path);
  }
  return value;
}

function stringArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CertifyStageContractError("certify.expected_string_array", path);
  }
  return Object.freeze(value.map((item, index) => nonEmptyString(item, `${path}[${index}]`)));
}

function digest(value, path) {
  const parsed = nonEmptyString(value, path);
  if (!digestPattern.test(parsed)) {
    throw new CertifyStageContractError("certify.expected_digest", path);
  }
  return parsed;
}

function isoTimestamp(value, path) {
  const parsed = nonEmptyString(value, path);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new CertifyStageContractError("certify.expected_iso_timestamp", path);
  }
  return parsed;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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
