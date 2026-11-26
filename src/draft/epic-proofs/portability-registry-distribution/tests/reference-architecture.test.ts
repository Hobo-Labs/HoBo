import assert from "node:assert/strict";
import { test } from "vitest";

import { runPortabilityRegistrySimulation } from "../services/portability-registry-reference.js";

test("certified Resource Pack install is verified and available without automatic selection", async () => {
  const result = await runPortabilityRegistrySimulation();

  assert.equal(result.epic.slug, "portability-registry-distribution");
  assert.equal(result.install.ok, true);
  assert.equal(result.install.availableToMatching, true);
  assert.equal(result.install.selectedByMatching, false);
  assert.equal(result.catalog.decision.effect, "allow");
  assert.equal(result.trust.decision.effect, "allow");
});

test("agent discovery resolves a deterministic digest pin and mirror cost runs only after verification", async () => {
  const result = await runPortabilityRegistrySimulation();

  assert.equal(result.discovery.ok, true);
  assert.equal(result.discovery.results[0].listingId, "listing-aws-resource-pack");
  assert.equal(result.resolution.ok, true);
  assert.match(result.resolution.pins[0].digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.mirrorSelection.ok, true);
  assert.deepEqual(result.mirrorSelection.costEligibleMirrorIds, ["mirror-cheap", "mirror-fast"]);
  assert.equal(result.dependencyConfusion.ok, false);
  assert.equal(result.dependencyConfusion.reason, "artifact.pinned_coordinate_absent");
});

test("critical yanks block new selection and flag running Sets instead of rewriting them", async () => {
  const result = await runPortabilityRegistrySimulation();

  assert.equal(result.yank.ok, true);
  assert.equal(result.yankedCanDeploy.ok, false);
  assert.equal(result.yankedCanDeploy.reason, "listing.yanked");
  assert.equal(result.yankDoctor.ok, false);
  assert.equal(result.yankDoctor.findings[0].type, "listing.yanked.pinned-set");
  assert.equal(result.yankObligations[0].type, "policy.ObligationCreated");
});

test("offline import stays in-boundary and records both accepted and refused trust decisions", async () => {
  const result = await runPortabilityRegistrySimulation();

  assert.equal(result.offlineImport.ok, true);
  assert.equal(result.offlineImport.egressAttempts, 0);
  assert.equal(result.offlineImport.event.type, "registry.BundleImported");
  assert.equal(result.offlineImport.event.verification.revocation, "passed");
  assert.equal(result.offlineRefusal.ok, false);
  assert.match(result.offlineRefusal.reasons[0], /revocation|antiRollback|transparency/);
});
