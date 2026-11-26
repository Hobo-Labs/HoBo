import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const provenanceSchema = "hobo.generation.provenance/v1";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const supportedSignatureAlg = "Ed25519";

export class ProvenanceContractError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

export function contentDigest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function makeConformanceReportRef(report, privateKeyPem) {
  assertObject(report, "provenance.conformance_report_required", "$");
  const digest = contentDigest(report);
  const signature = sign(
    null,
    Buffer.from(stableStringify(report)),
    createPrivateKey(privateKeyPem),
  ).toString("base64url");

  return {
    kind: "conformance-report",
    name: report.suiteId ?? report.id ?? "conformance-report",
    digest,
    signature: {
      alg: supportedSignatureAlg,
      payloadDigest: digest,
      value: signature,
    },
  };
}

export function signProvenanceRecord(record, privateKeyPem) {
  const payload = validateUnsignedPayload(record);
  const payloadDigest = contentDigest(payload);
  const signature = sign(
    null,
    Buffer.from(stableStringify(payload)),
    createPrivateKey(privateKeyPem),
  ).toString("base64url");

  return {
    kind: "generation-provenance",
    payload,
    signature: {
      alg: supportedSignatureAlg,
      payloadDigest,
      value: signature,
    },
  };
}

export function validateProvenanceRecord(record) {
  assertObject(record, "provenance.signed_record_required", "$");
  assertEqual(record.kind, "generation-provenance", "provenance.signed_record_required", "$.kind");
  assertObject(record.signature, "provenance.signed_record_required", "$.signature");
  assertEqual(
    record.signature.alg,
    supportedSignatureAlg,
    "provenance.signature_alg",
    "$.signature.alg",
  );
  assertNonEmptyString(record.signature.value, "provenance.signature_required", "$.signature.value");

  const payload = validateUnsignedPayload(record.payload);
  const payloadDigest = contentDigest(payload);
  assertEqual(
    record.signature.payloadDigest,
    payloadDigest,
    "provenance.payload_digest_mismatch",
    "$.signature.payloadDigest",
  );

  return record;
}

export function verifyProvenanceRecord(record, publicKeyPem) {
  try {
    validateProvenanceRecord(record);
    return verify(
      null,
      Buffer.from(stableStringify(record.payload)),
      createPublicKey(publicKeyPem),
      Buffer.from(record.signature.value, "base64url"),
    );
  } catch {
    return false;
  }
}

export function makeGenCertifiedEvent({
  id,
  runId,
  artifactDigest,
  provenance,
  provenancePublicKeyPem,
}) {
  const signed = validateProvenanceRecord(provenance);
  if (!verifyProvenanceRecord(signed, provenancePublicKeyPem)) {
    throw new ProvenanceContractError("provenance.signature_invalid", "$.provenance");
  }

  assertNonEmptyString(id, "event.id_required", "$.id");
  assertNonEmptyString(runId, "event.run_id_required", "$.runId");
  assertDigest(artifactDigest, "event.artifact_digest", "$.artifactDigest");
  assertEqual(
    artifactDigest,
    signed.payload.artifact.digest,
    "event.artifact_digest_mismatch",
    "$.artifactDigest",
  );

  return {
    id,
    type: "gen.Certified",
    runId,
    payload: {
      artifact: signed.payload.artifact,
      provenanceRef: {
        kind: "generation-provenance",
        digest: contentDigest(signed),
        signature: {
          alg: signed.signature.alg,
          payloadDigest: signed.signature.payloadDigest,
        },
      },
    },
  };
}

function validateUnsignedPayload(payload) {
  assertObject(payload, "provenance.payload_required", "$.payload");
  assertEqual(payload.schema, provenanceSchema, "provenance.schema", "$.schema");
  validateArtifact(payload.artifact);
  validateModel(payload.model);
  validatePrompt(payload.prompt);
  assertNonEmptyString(payload.seed, "provenance.seed_required", "$.seed");
  validateConformanceReportRef(payload.conformanceReportRef);
  validateEvalReportRefs(payload.evalReportRefs);
  assertIsoTimestamp(payload.issuedAt, "provenance.issued_at", "$.issuedAt");

  return payload;
}

function validateArtifact(artifact) {
  assertObject(artifact, "provenance.artifact_required", "$.artifact");
  assertNonEmptyString(artifact.kind, "provenance.artifact_kind", "$.artifact.kind");
  assertNonEmptyString(artifact.name, "provenance.artifact_name", "$.artifact.name");
  assertDigest(artifact.digest, "provenance.artifact_digest", "$.artifact.digest");
}

function validateModel(model) {
  assertObject(model, "provenance.model_required", "$.model");
  assertNonEmptyString(model.provider, "provenance.model_provider", "$.model.provider");
  assertNonEmptyString(model.id, "provenance.model_id", "$.model.id");
  assertDigest(model.digest, "provenance.model_digest", "$.model.digest");
}

function validatePrompt(prompt) {
  assertObject(prompt, "provenance.prompt_required", "$.prompt");
  assertNonEmptyString(prompt.id, "provenance.prompt_id", "$.prompt.id");
  assertDigest(
    prompt.frozenPromptDigest,
    "provenance.frozen_prompt_digest",
    "$.prompt.frozenPromptDigest",
  );
}

function validateConformanceReportRef(ref) {
  assertObject(ref, "provenance.conformance_report_required", "$.conformanceReportRef");
  assertEqual(
    ref.kind,
    "conformance-report",
    "provenance.conformance_report_kind",
    "$.conformanceReportRef.kind",
  );
  assertNonEmptyString(ref.name, "provenance.conformance_report_name", "$.conformanceReportRef.name");
  assertDigest(ref.digest, "provenance.conformance_report_digest", "$.conformanceReportRef.digest");
  assertObject(
    ref.signature,
    "provenance.conformance_report_signature_required",
    "$.conformanceReportRef.signature",
  );
  assertEqual(
    ref.signature.alg,
    supportedSignatureAlg,
    "provenance.conformance_report_signature_required",
    "$.conformanceReportRef.signature.alg",
  );
  assertNonEmptyString(
    ref.signature.value,
    "provenance.conformance_report_signature_required",
    "$.conformanceReportRef.signature.value",
  );
  assertEqual(
    ref.signature.payloadDigest,
    ref.digest,
    "provenance.conformance_report_signature_digest",
    "$.conformanceReportRef.signature.payloadDigest",
  );
}

function validateEvalReportRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new ProvenanceContractError("provenance.eval_report_refs_required", "$.evalReportRefs");
  }

  for (const [index, ref] of refs.entries()) {
    const path = `$.evalReportRefs[${index}]`;
    assertObject(ref, "provenance.eval_report_ref", path);
    assertNonEmptyString(ref.kind, "provenance.eval_report_kind", `${path}.kind`);
    assertNonEmptyString(ref.name, "provenance.eval_report_name", `${path}.name`);
    assertDigest(ref.digest, "provenance.eval_report_digest", `${path}.digest`);
  }
}

function assertEqual(actual, expected, code, path) {
  if (actual !== expected) {
    throw new ProvenanceContractError(code, path);
  }
}

function assertObject(value, code, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new ProvenanceContractError(code, path);
  }
}

function assertNonEmptyString(value, code, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new ProvenanceContractError(code, path);
  }
}

function assertDigest(value, code, path) {
  assertNonEmptyString(value, code, path);
  if (!digestPattern.test(value)) {
    throw new ProvenanceContractError(code, path);
  }
}

function assertIsoTimestamp(value, code, path) {
  assertNonEmptyString(value, code, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new ProvenanceContractError(code, path);
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
