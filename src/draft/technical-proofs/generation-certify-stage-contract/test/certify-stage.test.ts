import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";

import { contentDigest } from "../../slsa-provenance-certification-contract/src/provenance.js";
import {
  CertifyStageContractError,
  createCertificationRecord,
  createGenerationCertifyStage,
  createInMemoryCertificationRegistry,
  signCertificationRecord,
  verifyCertificationRecord
} from "../src/certify-stage.js";

const artifactDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const modelDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const promptDigest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const policyInputHash = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

const generatedKeys = generateKeyPairSync("ed25519");
const fixtureSigningKey = Object.freeze({
  keyId: "hobo-generation-certifier",
  publicKeyPem: generatedKeys.publicKey.export({ type: "spki", format: "pem" }),
  privateKeyPem: generatedKeys.privateKey.export({ type: "pkcs8", format: "pem" })
});

test("green run publishes a signed provenance-complete Registry record", () => {
  const registry = createInMemoryCertificationRegistry({
    trustedKeys: { [fixtureSigningKey.keyId]: fixtureSigningKey.publicKeyPem }
  });
  const stage = createGenerationCertifyStage({ registry, signingKey: fixtureSigningKey });

  const result = stage.certify(certifyFixture());

  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.status, "Certified");
  assert.equal(result.record.payload.provenance.payload.model.id, "self-hosted/qwen3-coder");
  assert.equal(result.record.payload.provenance.payload.prompt.frozenPromptDigest, promptDigest);
  assert.equal(result.record.payload.provenance.payload.seed, "seed-hobo-346");
  assert.equal(result.record.payload.validationReportRef.digest, validationReport().ref.digest);
  assert.equal(
    result.record.payload.provenance.payload.conformanceReportRef.digest,
    contentDigest(conformanceReport())
  );
  assert.equal(verifyCertificationRecord(result.record, fixtureSigningKey.publicKeyPem), true);
  assert.deepEqual(
    registry.events().map((event) => event.type),
    ["gen.Certified", "gen.PluginCertified"]
  );
  assert.deepEqual(registry.certified().map((record) => record.payload.name), [
    "@acme/provider-postgres"
  ]);
});

test("Registry refuses unsigned and provenance-incomplete artifacts", () => {
  const registry = createInMemoryCertificationRegistry({
    trustedKeys: { [fixtureSigningKey.keyId]: fixtureSigningKey.publicKeyPem }
  });
  const record = createCertificationRecord(certifyFixture(), fixtureSigningKey);

  const unsigned = registry.publish({ ...record, signature: undefined });
  assert.equal(unsigned.ok, false);
  assert.match(unsigned.reasons.join("\n"), /registry\.signature_required/);

  const incompleteProvenance = signCertificationRecord(
    {
      ...record,
      payload: {
        ...record.payload,
        provenance: {
          ...record.payload.provenance,
          payload: {
            ...record.payload.provenance.payload,
            seed: ""
          }
        }
      }
    },
    fixtureSigningKey
  );
  const incomplete = registry.publish(incompleteProvenance);

  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reasons.join("\n"), /registry\.provenance_incomplete/);
  assert.deepEqual(registry.certified(), []);
});

test("artifact claiming a port it did not pass cannot be certified", () => {
  const registry = createInMemoryCertificationRegistry({
    trustedKeys: { [fixtureSigningKey.keyId]: fixtureSigningKey.publicKeyPem }
  });
  const stage = createGenerationCertifyStage({ registry, signingKey: fixtureSigningKey });

  assert.throws(
    () =>
      stage.certify(
        certifyFixture({
          candidate: {
            ...candidate(),
            claimedPorts: [
              "hobo:database/postgres@0.1.0",
              "hobo:cache/redis@0.1.0"
            ]
          }
        })
      ),
    (error) =>
      error instanceof CertifyStageContractError &&
      error.code === "certify.claimed_port_unvalidated"
  );

  assert.deepEqual(registry.certified(), []);
});

test("re-signed record with swapped conformance report is detected", () => {
  const registry = createInMemoryCertificationRegistry({
    trustedKeys: { [fixtureSigningKey.keyId]: fixtureSigningKey.publicKeyPem }
  });
  const record = createCertificationRecord(certifyFixture(), fixtureSigningKey);
  const swappedReport = {
    ...conformanceReport(),
    suiteId: "@hobo/conformance/redis-provider",
    targetPort: "hobo:cache/redis@0.1.0"
  };

  const resigned = signCertificationRecord(
    {
      ...record,
      payload: {
        ...record.payload,
        conformanceReport: swappedReport
      }
    },
    fixtureSigningKey
  );
  const result = registry.publish(resigned);

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /registry\.provenance_report_digest_mismatch/);
  assert.deepEqual(registry.certified(), []);
});

test("certification waits for policy approval instead of silently publishing", () => {
  const registry = createInMemoryCertificationRegistry({
    trustedKeys: { [fixtureSigningKey.keyId]: fixtureSigningKey.publicKeyPem }
  });
  const stage = createGenerationCertifyStage({ registry, signingKey: fixtureSigningKey });

  assert.throws(
    () =>
      stage.certify(
        certifyFixture({
          gateDecision: {
            effect: "require-approval",
            reason: "prod-requires-approval"
          }
        })
      ),
    (error) =>
      error instanceof CertifyStageContractError &&
      error.code === "certify.policy_not_certified"
  );
});

function certifyFixture(overrides = {}) {
  return {
    requestId: "gen-hobo-346",
    candidate: candidate(),
    validationReport: validationReport(),
    conformanceReport: conformanceReport(),
    evalReports: [
      {
        kind: "eval-report",
        name: "provider-safety",
        digest: contentDigest({ score: 1, rubric: "no-egress" })
      }
    ],
    model: {
      provider: "self-hosted",
      id: "self-hosted/qwen3-coder",
      digest: modelDigest
    },
    prompt: {
      id: "provider-postgres-v1",
      frozenPromptDigest: promptDigest
    },
    seed: "seed-hobo-346",
    gateDecision: {
      effect: "certify",
      reason: "low-risk preview generation may auto-certify",
      policyRef: "policy:allow-low-risk-generation-certify",
      policyInputHash
    },
    certifiedAt: "2026-06-26T03:45:00.000Z",
    ...overrides
  };
}

function candidate() {
  return {
    artifactKind: "provider-plugin",
    name: "@acme/provider-postgres",
    version: "1.0.0",
    artifactRef: {
      mediaType: "application/vnd.hobo.provider.layer.v1+json",
      uri: "oci://registry.example/hobo/provider-postgres@sha256:aaa",
      digest: artifactDigest
    },
    claimedPorts: ["hobo:database/postgres@0.1.0"]
  };
}

function validationReport() {
  const payload = {
    schema: "hobo.gen.validation-report/v1",
    requestId: "gen-hobo-346",
    candidateRef: candidate().artifactRef,
    targetWitPort: "hobo:database/postgres@0.1.0",
    coveredPorts: [
      {
        witPort: "hobo:database/postgres@0.1.0",
        suiteId: "@hobo/conformance/postgres-provider",
        passed: true
      }
    ],
    conformance: {
      suiteId: "@hobo/conformance/postgres-provider",
      targetPort: "hobo:database/postgres@0.1.0",
      passed: true,
      assertions: [{ id: "contract.connects", passed: true }]
    },
    traceReplay: { passed: true, diffs: [] },
    passed: true
  };
  return {
    ...payload,
    ref: {
      uri: "oci://registry.example/hobo/reports/gen-hobo-346",
      digest: contentDigest(payload)
    }
  };
}

function conformanceReport() {
  return {
    schema: "hobo.conformance.report/v1",
    suiteId: "@hobo/conformance/postgres-provider",
    targetPort: "hobo:database/postgres@0.1.0",
    runId: "gen-hobo-346",
    passed: true,
    assertions: ["contract.connects", "contract.destroy.clean"]
  };
}
