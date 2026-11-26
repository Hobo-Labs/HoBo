import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONTRACT_BOUNDARIES,
  runProvidersReferenceSimulation
} from "../services/providers-reference-architecture.js";

test("registers provider packages with default definitions and conformance evidence", async () => {
  const result = await runProvidersReferenceSimulation();

  assert.equal(result.epic.slug, "providers-iac-build-adapters");
  assert.equal(result.providerCatalog.providers.length, 8);
  assert.equal(result.providerCatalog.defaults.every((definition) => definition.source === "provider-owned"), true);
  assert.deepEqual(result.equivalenceResolver.unsatisfiedRequire, {
    request: "database.postgres.managed.ha.vector",
    rejectedProvider: "hetzner",
    reason: "required capability vector is unavailable",
    remediation: "select aws, azure, gcp, or cloudflare-neon"
  });
  assert.equal(result.conformance.claimedPortsCovered, true);
  assert.equal(result.liveNetworkCalls.length, 0);
});

test("realizes resource plans through IaC, build, and driver adapters without live providers", async () => {
  const result = await runProvidersReferenceSimulation();

  assert.deepEqual(result.realize.pipeline, ["realize", "build", "preview", "apply", "refresh"]);
  assert.equal(result.realize.iacProgram.kind, "hobo.iac-program/v1");
  assert.equal(result.iacAdapters.pulumi.previewThenApply, true);
  assert.equal(result.iacAdapters.crossplane.controllerDriven, true);
  assert.equal(result.iacAdapters.cdktf.mode, "import-only");
  assert.equal(result.buildAdapters.imageRefs.includes("oci://registry.local/shop-api:wasm"), true);
  assert.equal(result.driverAdapters.selected.includes("custom-webhook"), true);
});

test("fails closed for drift, partial apply, malicious providers, and portability gaps", async () => {
  const result = await runProvidersReferenceSimulation();

  assert.equal(result.drift.detected, true);
  assert.equal(result.drift.actions.includes("orphan-sweep"), true);
  assert.equal(result.partialApply.createdButNotInState.recorded, true);
  assert.equal(result.partialApply.compensation.status, "safe_rollback_requires_orphan_sweep");
  assert.equal(result.maliciousProvider.contained, true);
  assert.equal(result.maliciousProvider.egressAllowed, false);
  assert.equal(result.portabilityReport.lockInEntries.length, 3);
  assert.equal(result.portabilityReport.canDeploy, false);
});

test("certifies generated providers and packages signed Resource Packs", async () => {
  const result = await runProvidersReferenceSimulation();

  assert.equal(result.generation.referenceRun.status, "certified");
  assert.equal(result.generation.repairBudget.exhaustedBehavior, "gen.NeedsHuman");
  assert.equal(result.resourcePack.signatureVerified, true);
  assert.equal(result.resourcePack.conformanceReports.every((report) => report.status === "passed"), true);
  assert.equal(result.executionHosts.dispatchDecision, "self-hosted-build-machine");
});

test("proves the multi-cloud shop gate across provider targets", async () => {
  const result = await runProvidersReferenceSimulation();

  assert.equal(result.multiCloudShop.bindleSourceDigest, "sha256:shop-bindle-unchanged");
  assert.deepEqual(result.multiCloudShop.targets, ["aws", "azure"]);
  assert.equal(result.multiCloudShop.sameTopology, true);
  assert.equal(result.multiCloudShop.providerOptionsLeaked, false);
  assert.equal(result.multiCloudShop.unsatisfiedRequireRejected, true);
});

test("covers every declared provider boundary with a Pact decision", async () => {
  const result = await runProvidersReferenceSimulation();

  assert.equal(CONTRACT_BOUNDARIES.length, 15);
  assert.deepEqual([...result.contracts.covered].sort(), CONTRACT_BOUNDARIES.map((boundary) => boundary.provider).sort());
  assert.deepEqual(result.contracts.missing, []);
});
