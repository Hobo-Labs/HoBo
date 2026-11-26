import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  META_CLOUD_BROKER_SCOPE,
  REQUIRED_AUTHORITY_BOUNDARIES,
  REQUIRED_OPERATING_BOUNDARIES,
  canCreateBrokerFollowUp,
  classifyBrokerClaim,
  validateMetaCloudBrokerScope,
} from "../src/meta-cloud-broker-scope.mjs";

test("M0 record states broker goal, personas, scope, and authority boundaries", () => {
  const result = validateMetaCloudBrokerScope(META_CLOUD_BROKER_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(META_CLOUD_BROKER_SCOPE.issue, "HOBO-521");
  assert.equal(META_CLOUD_BROKER_SCOPE.phase, "M0");
  assert.match(META_CLOUD_BROKER_SCOPE.goal, /Meta-cloud Broker/i);
  assert.match(META_CLOUD_BROKER_SCOPE.goal, /Resolution Receipts?/i);
  assert.deepEqual(
    META_CLOUD_BROKER_SCOPE.personas.map((persona) => persona.id),
    [
      "broker-admin",
      "platform-engineer",
      "app-developer",
      "support-operator",
      "security-reviewer",
    ],
  );
  assert.deepEqual(
    META_CLOUD_BROKER_SCOPE.authorityBoundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_AUTHORITY_BOUNDARIES].sort(),
  );
});

test("service, UX, security, support, and owning-initiative dependencies are mapped", () => {
  assert.deepEqual(
    META_CLOUD_BROKER_SCOPE.operatingBoundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_OPERATING_BOUNDARIES].sort(),
  );
  assert.deepEqual(
    META_CLOUD_BROKER_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Meta-cloud Broker",
      "Control Plane: Planner, Matching & Orchestrator",
      "Providers, IaC & Build Adapters",
      "Contracts, Policy & Governance",
      "Admin Console",
      "Support Workflow",
      "V1 Release Program & Cutline",
    ],
  );
});

test("core artifact vocabulary has owners and minimum M1 proof expectations", () => {
  assert.deepEqual(
    META_CLOUD_BROKER_SCOPE.artifacts.map((artifact) => artifact.id),
    [
      "contract-manifest",
      "broker-environment",
      "mapping-contract",
      "broker-catalog-snapshot",
      "resolution-receipt",
      "resolution-rejection",
    ],
  );

  for (const artifact of META_CLOUD_BROKER_SCOPE.artifacts) {
    assert.match(artifact.owner, /\S/);
    assert.match(artifact.minimumM1Proof, /\S/);
  }
});

test("Yard, admin UI, and Gatekeeper cannot silently overwrite broker authority", () => {
  const nonBrokerAuthorities = META_CLOUD_BROKER_SCOPE.authorityBoundaries.filter(
    (boundary) => boundary.id !== "meta-cloud-broker",
  );

  for (const boundary of nonBrokerAuthorities) {
    assert.equal(boundary.canOverwriteBrokerDecision, false);
    assert.match(boundary.overwriteRule, /new receipt|policy decision/i);
  }
});

test("M1-M4 follow-up gate blocks downstream broker work until M0 acceptance", () => {
  assert.equal(canCreateBrokerFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateBrokerFollowUp({ phase: "M2", m0Accepted: false }).allowed, false);
  assert.equal(canCreateBrokerFollowUp({ phase: "M3", m0Accepted: false }).allowed, false);
  assert.equal(canCreateBrokerFollowUp({ phase: "M4", m0Accepted: false }).allowed, false);
  assert.equal(canCreateBrokerFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateBrokerFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects broker runtime, admin UI, provider adapter, planner, and Gatekeeper creep", () => {
  const invalid = structuredClone(META_CLOUD_BROKER_SCOPE);
  invalid.scopeIn.push("Implement the hosted broker runtime resolver and live service.");
  invalid.scopeIn.push("Build admin UI approval screens and provider adapters.");
  invalid.scopeIn.push("Patch Yard planner behavior and Gatekeeper policy changes.");

  const result = validateMetaCloudBrokerScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /broker runtime/i);
  assert.match(result.errors.join("\n"), /admin UI/i);
  assert.match(result.errors.join("\n"), /provider adapter/i);
  assert.match(result.errors.join("\n"), /Yard planner/i);
  assert.match(result.errors.join("\n"), /Gatekeeper/i);
});

test("public broker claims require named proof mode and source", () => {
  assert.deepEqual(
    classifyBrokerClaim({
      audience: "release-notes",
      claim: "Hosted broker deterministically resolves every manifest.",
    }),
    {
      allowed: false,
      reason: "Public or release-facing broker claims require proof mode and source evidence.",
    },
  );

  assert.equal(
    classifyBrokerClaim({
      audience: "release-notes",
      claim: "Hosted broker emits Resolution Receipts for supported fixtures.",
      proofMode: "contract-test",
      source: "src/draft/exp-proofs/api/meta-cloud-broker-scope-contract",
    }).allowed,
    true,
  );
});

test("architecture guard evidence names broker schema, parsed types, and event boundary", () => {
  const architecture = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const pact = JSON.parse(
    readFileSync(
      new URL("../contracts/pacts/meta-cloud-broker-resolution.pact.json", import.meta.url),
      "utf8",
    ),
  );
  const proto = readFileSync(new URL("../proto/meta_cloud_broker.proto", import.meta.url), "utf8");
  const cue = readFileSync(new URL("../cue/meta_cloud_broker.cue", import.meta.url), "utf8");

  assert.equal(pact.consumer.name, "ContractManifestSubmitter");
  assert.equal(pact.provider.name, "MetaCloudBrokerResolutionAuthority");
  assert.ok(pact.interactions.length >= 2);

  for (const typeName of [
    "ContractManifest",
    "BrokerEnvironment",
    "MappingContract",
    "BrokerCatalogSnapshot",
    "ResolutionReceipt",
    "ResolutionRejection",
    "BrokerDecisionState",
  ]) {
    assert.match(proto, new RegExp(`(?:message|enum) ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /derived domain\s+types/i);
  assert.match(architecture, /Command/i);
  assert.match(architecture, /Events/i);
  assert.match(architecture, /Actor/i);
  assert.match(architecture, /event-store/i);
  assert.match(architecture, /projection/i);
  assert.match(architecture, /Snapshot/i);
  assert.match(architecture, /read store/i);
});
