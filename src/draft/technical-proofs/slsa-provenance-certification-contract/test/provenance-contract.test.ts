import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";

import {
  ProvenanceContractError,
  contentDigest,
  makeConformanceReportRef,
  makeGenCertifiedEvent,
  signProvenanceRecord,
  validateProvenanceRecord,
  verifyProvenanceRecord,
} from "../src/provenance.js";

const generatedKeys = generateKeyPairSync("ed25519");
const fixtureKeys = Object.freeze({
  publicKeyPem: generatedKeys.publicKey.export({ type: "spki", format: "pem" }),
  privateKeyPem: generatedKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
});

const conformanceReport = Object.freeze({
  schema: "hobo.conformance.report/v1",
  suiteId: "conformance.provider.database@0.1.0",
  runId: "gen-run-123",
  passed: true,
  assertions: ["provision", "connect", "destroy"],
});

const baseUnsignedRecord = Object.freeze({
  schema: "hobo.generation.provenance/v1",
  artifact: {
    kind: "provider",
    name: "@hobo/provider-acme-db",
    digest: "sha256:1d3fc8432f50f877e7df7dce5af6f2c27fdd257ccaae5ad39b8b24bf7aa4f54d",
  },
  model: {
    provider: "self-hosted",
    id: "qwen3-coder-480b-a35b",
    digest: "sha256:2d3fc8432f50f877e7df7dce5af6f2c27fdd257ccaae5ad39b8b24bf7aa4f54e",
  },
  prompt: {
    id: "provider-database-v1",
    frozenPromptDigest: "sha256:3d3fc8432f50f877e7df7dce5af6f2c27fdd257ccaae5ad39b8b24bf7aa4f54f",
  },
  seed: "seed-2026-06-25T04:55:00Z",
  conformanceReportRef: makeConformanceReportRef(conformanceReport, fixtureKeys.privateKeyPem),
  evalReportRefs: [
    {
      kind: "eval-report",
      name: "provider-safety",
      digest: contentDigest({ score: 1, rubric: "no-egress" }),
    },
  ],
  issuedAt: "2026-06-25T04:55:00.000Z",
});

test("provenance record signs and verifies against a fixture Ed25519 key", () => {
  const signed = signProvenanceRecord(baseUnsignedRecord, fixtureKeys.privateKeyPem);

  assert.equal(signed.signature.alg, "Ed25519");
  assert.equal(signed.signature.payloadDigest, contentDigest(signed.payload));
  assert.equal(verifyProvenanceRecord(signed, fixtureKeys.publicKeyPem), true);
  assert.deepEqual(validateProvenanceRecord(signed), signed);
});

test("tampering with pinned model, prompt, seed, or report ref fails verification", () => {
  const signed = signProvenanceRecord(baseUnsignedRecord, fixtureKeys.privateKeyPem);

  const tamperedRecords = [
    {
      ...signed,
      payload: { ...signed.payload, model: { ...signed.payload.model, id: "alias-latest" } },
    },
    {
      ...signed,
      payload: {
        ...signed.payload,
        prompt: { ...signed.payload.prompt, frozenPromptDigest: signed.payload.model.digest },
      },
    },
    { ...signed, payload: { ...signed.payload, seed: "different-seed" } },
    {
      ...signed,
      payload: {
        ...signed.payload,
        conformanceReportRef: {
          ...signed.payload.conformanceReportRef,
          digest: contentDigest({ ...conformanceReport, assertions: [] }),
        },
      },
    },
  ];

  for (const tampered of tamperedRecords) {
    assert.equal(verifyProvenanceRecord(tampered, fixtureKeys.publicKeyPem), false);
  }
});

test("missing seed or unsigned conformance report is rejected by the contract", () => {
  assertContractError(
    () =>
      signProvenanceRecord(
        {
          ...baseUnsignedRecord,
          seed: "",
        },
        fixtureKeys.privateKeyPem,
      ),
    "provenance.seed_required",
  );

  assertContractError(
    () =>
      signProvenanceRecord(
        {
          ...baseUnsignedRecord,
          conformanceReportRef: {
            kind: "conformance-report",
            name: conformanceReport.suiteId,
            digest: contentDigest(conformanceReport),
            signature: {
              alg: "Ed25519",
              payloadDigest: contentDigest(conformanceReport),
            },
          },
        },
        fixtureKeys.privateKeyPem,
      ),
    "provenance.conformance_report_signature_required",
  );

  assertContractError(
    () =>
      signProvenanceRecord(
        {
          ...baseUnsignedRecord,
          evalReportRefs: [],
        },
        fixtureKeys.privateKeyPem,
      ),
    "provenance.eval_report_refs_required",
  );
});

test("content-addressed report refs detect swapped conformance reports", () => {
  const reportRef = makeConformanceReportRef(conformanceReport, fixtureKeys.privateKeyPem);

  assert.equal(reportRef.digest, contentDigest(conformanceReport));
  assert.equal(reportRef.signature.alg, "Ed25519");
  assert.ok(reportRef.signature.value.length > 0);
  assert.notEqual(
    reportRef.digest,
    contentDigest({ ...conformanceReport, passed: false }),
  );
});

test("gen.Certified cannot be constructed without complete signed provenance ref", () => {
  const signed = signProvenanceRecord(baseUnsignedRecord, fixtureKeys.privateKeyPem);

  const event = makeGenCertifiedEvent({
    id: "evt-1",
    runId: "gen-run-123",
    artifactDigest: signed.payload.artifact.digest,
    provenance: signed,
    provenancePublicKeyPem: fixtureKeys.publicKeyPem,
  });

  assert.equal(event.type, "gen.Certified");
  assert.equal(event.payload.provenanceRef.digest, contentDigest(signed));
  assert.equal(event.payload.provenanceRef.signature.alg, "Ed25519");

  assertContractError(
    () =>
      makeGenCertifiedEvent({
        id: "evt-2",
        runId: "gen-run-123",
        artifactDigest: signed.payload.artifact.digest,
        provenance: { kind: "generation-provenance", digest: contentDigest(signed) },
        provenancePublicKeyPem: fixtureKeys.publicKeyPem,
      }),
    "provenance.signed_record_required",
  );

  assertContractError(
    () =>
      makeGenCertifiedEvent({
        id: "evt-3",
        runId: "gen-run-123",
        artifactDigest: signed.payload.artifact.digest,
        provenance: {
          ...signed,
          signature: {
            ...signed.signature,
            value: "forged-signature",
          },
        },
        provenancePublicKeyPem: fixtureKeys.publicKeyPem,
      }),
    "provenance.signature_invalid",
  );
});

function assertContractError(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof ProvenanceContractError && error.code === code,
  );
}
