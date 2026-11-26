import assert from "node:assert/strict";
import { test } from "vitest";

import { CONTRACT_BOUNDARIES, runSdkAuthoringReferenceSimulation } from "../services/sdk-authoring-reference-architecture.js";

test("lowers IfC authoring into a deterministic manifest and generated type surface", async () => {
  const result = await runSdkAuthoringReferenceSimulation();

  assert.equal(result.epic.slug, "sdk-authoring-ifc-bindles");
  assert.equal(result.manifest.schema, "hobo.manifest/v1");
  assert.equal(result.manifest.contentHash, "sha256:sdk-authoring-reference-001");
  assert.deepEqual(result.manifest.resources.map((resource) => resource.name).sort(), [
    "asana",
    "auth",
    "files",
    "orders",
    "profile-cache",
    "sync-api"
  ]);
  assert.equal(result.codegen.status, "clean");
  assert.equal(result.codegen.generatedFiles.includes(".hobo/generated/bindings.d.ts"), true);
  assert.equal(result.liveNetworkCalls.length, 0);
});

test("surfaces unsafe authoring choices before deploy", async () => {
  const result = await runSdkAuthoringReferenceSimulation();

  assert.equal(result.guardrails.collectionCoverage.ok, false);
  assert.equal(result.guardrails.collectionCoverage.reason, "collection.coverage.unobserved-resource");
  assert.equal(result.guardrails.permissionNarrowing.ok, false);
  assert.equal(result.guardrails.permissionNarrowing.reason, "capability.required-not-granted");
  assert.equal(result.guardrails.xaaScopeWidening.ok, false);
  assert.equal(result.guardrails.xaaScopeWidening.reason, "requested-scope-exceeds-inferred-manifest-scope");
  assert.equal(result.guardrails.rawDriverDebt.marker, "RAW_DRIVER_PORTABILITY_DEBT");
  assert.equal(result.guardrails.providerOptionInertForNonResolvedProvider.ok, true);
});

test("keeps topology, Hobo Code, local runtime, and non-TS parity as lowering boundaries", async () => {
  const result = await runSdkAuthoringReferenceSimulation();

  assert.deepEqual(result.topology.resolutionOrder, ["bindings", "tiers", "defaultProvider"]);
  assert.equal(result.hoboCode.byteIdenticalToTypescriptManifest, true);
  assert.equal(result.hoboCode.hostImportsRejected.ok, false);
  assert.equal(result.localRuntime.replayEqualsLive, true);
  assert.equal(result.localRuntime.missingLocalEquivalent.ok, false);
  assert.equal(result.nonTsParity.status, "requires-semantics-annex");
  assert.equal(result.nonTsParity.loweringLane, "green");
});

test("covers every declared boundary with a Pact decision", async () => {
  const result = await runSdkAuthoringReferenceSimulation();

  assert.equal(CONTRACT_BOUNDARIES.length, 12);
  assert.deepEqual([...result.contracts.covered].sort(), CONTRACT_BOUNDARIES.map((boundary) => boundary.provider).sort());
  assert.deepEqual(result.contracts.missing, []);
});
