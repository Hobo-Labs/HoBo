import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  BROKER_ARTIFACT_SCHEMAS,
  createAcceptedBrokerFixture,
  createRejectionBrokerFixture,
  evaluateBrokerArtifacts,
  parseBrokerArtifactSet,
  stableDigest,
} from "../src/meta-cloud-broker-artifact-contract.js";
import { isJsonString } from "../src/json.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("artifact schemas and golden fixtures cover all six broker artifacts", () => {
  const fixture = createAcceptedBrokerFixture();
  const parsed = parseBrokerArtifactSet(fixture.artifacts);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.deepEqual(Object.keys(BROKER_ARTIFACT_SCHEMAS).sort(), [
    "broker-catalog-snapshot",
    "broker-environment",
    "contract-manifest",
    "mapping-contract",
    "resolution-receipt",
    "resolution-rejection",
  ]);
  for (const artifact of parsed.artifacts) {
    assert.equal(isJsonString(artifact.owner), true);
    assert.match(artifact.version, /^\d+\.\d+\.\d+$/);
    assert.match(artifact.provenance.signature.digest, /^sha256:/);
    assert.equal(artifact.provenance.source.issue, "HOBO-522");
  }

  const decision = evaluateBrokerArtifacts(parsed.artifacts);
  assert.equal(decision.kind, "resolution-receipt");
  assert.equal(decision.decision, "accepted");
  assert.equal(decision.receipt.manifestDigest, fixture.artifacts[0].payload.manifestDigest);
  assert.equal(decision.receipt.environmentDigest, fixture.artifacts[1].payload.environmentDigest);
  assert.equal(stableDigest(decision), stableDigest(evaluateBrokerArtifacts(parsed.artifacts)));
});

test("valid inputs can deterministically produce a structured rejection fixture", () => {
  const fixture = createRejectionBrokerFixture("unsupported-capability");
  const parsed = parseBrokerArtifactSet(fixture.artifacts);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  const first = evaluateBrokerArtifacts(parsed.artifacts);
  const second = evaluateBrokerArtifacts(parsed.artifacts);

  assert.deepEqual(first, second);
  assert.equal(first.kind, "resolution-rejection");
  assert.equal(first.decision, "rejected");
  assert.equal(first.rejection.reason.code, "unsupported-capability");
  assert.match(first.rejection.reason.message, /capability hobo:gpu-runner is not available/);
});

test("unsigned, unversioned, ambiguous, and ownerless artifacts fail closed", () => {
  const cases = [
    {
      name: "unsigned",
      mutate(artifact: any) {
        delete artifact.provenance.signature;
      },
      message: /contract-manifest provenance.signature.digest must be a sha256 digest/,
    },
    {
      name: "unversioned",
      mutate(artifact: any) {
        artifact.version = "";
      },
      message: /contract-manifest version must be semantic version/,
    },
    {
      name: "ownerless",
      mutate(artifact: any) {
        artifact.owner = "";
      },
      message: /contract-manifest owner must be a non-empty string/,
    },
    {
      name: "ambiguous mapping",
      mutate(_artifact: any, artifacts: any[]) {
        const mapping = artifacts.find((candidate) => candidate.kind === "mapping-contract");
        mapping.payload.allowedProviders.push({
          providerId: "provider-b",
          catalogDigest: mapping.payload.allowedProviders[0].catalogDigest,
          priority: mapping.payload.allowedProviders[0].priority,
        });
      },
      message: /mapping-contract allowedProviders must not contain ambiguous priorities/,
    },
  ];

  for (const { mutate, message } of cases) {
    const fixture = createAcceptedBrokerFixture();
    mutate(fixture.artifacts[0], fixture.artifacts);
    const parsed = parseBrokerArtifactSet(fixture.artifacts);

    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join("\n"), message);
  }
});

test("hosted broker policy cannot masquerade as Gatekeeper policy", () => {
  const fixture = createAcceptedBrokerFixture();
  const environment = fixture.artifacts.find((artifact) => artifact.kind === "broker-environment");
  environment.payload.policies.push({
    id: "hosted-broker-prod-override",
    authority: "meta-cloud-broker",
    kind: "gatekeeper-policy",
    digest: "sha256:broker-policy-masquerade",
  });

  const parsed = parseBrokerArtifactSet(fixture.artifacts);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /broker-environment policy hosted-broker-prod-override must not masquerade as Gatekeeper policy/);
});

test("schema, protobuf, CUE, and Pact evidence publish the M1 contract surface", async () => {
  const [schemaText, protoText, cueText, pactText, declarations] = await Promise.all([
    readFile(path.join(packageRoot, "schema", "meta-cloud-broker-artifacts.v1.schema.json"), "utf8"),
    readFile(path.join(packageRoot, "architecture", "meta_cloud_broker_artifact_contract.proto"), "utf8"),
    readFile(path.join(packageRoot, "architecture", "meta_cloud_broker_artifact_contract.cue"), "utf8"),
    readFile(path.join(packageRoot, "architecture", "pacts", "meta_cloud_broker_artifact_contract.pact.json"), "utf8"),
    readFile(path.join(packageRoot, "src", "meta-cloud-broker-artifact-contract.d.ts"), "utf8"),
  ]);

  const schema = JSON.parse(schemaText);
  const pact = JSON.parse(pactText);

  assert.equal(schema.$id, "https://schemas.hobo.dev/meta-cloud-broker-artifacts.v1.schema.json");
  assert.equal(pact.consumer.name, "Meta-cloud Broker artifact contract consumer");
  assert.match(protoText, /message ContractManifestArtifact/);
  assert.match(protoText, /BrokerArtifactSource source = 1;/);
  assert.match(protoText, /repeated ContractFact declared_facts = 4;/);
  assert.match(cueText, /#ResolutionRejectionArtifact:/);
  assert.match(cueText, /source:\s+#BrokerArtifactSource/);
  assert.match(cueText, /declaredFacts:\s+\[\.\.\.#ContractFact\]/);
  assert.match(declarations, /export interface BrokerArtifactEnvelope/);
});
