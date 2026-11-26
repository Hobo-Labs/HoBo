import assert from "node:assert/strict";
import { test } from "vitest";

async function loadContract() {
  const module = await import("../src/dogfood-yard-release-candidate.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M3 release-candidate evidence is listed and mapped to owning projects", async () => {
  const { dogfoodYardReleaseCandidateEvidence, validateDogfoodYardReleaseCandidateEvidence } =
    await loadContract();
  const result = validateDogfoodYardReleaseCandidateEvidence(dogfoodYardReleaseCandidateEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(dogfoodYardReleaseCandidateEvidence.issue, "HOBO-469");
  assert.equal(dogfoodYardReleaseCandidateEvidence.phase, "M3");
  assert.equal(dogfoodYardReleaseCandidateEvidence.milestone, "M3 Release candidate");
  assert.ok(dogfoodYardReleaseCandidateEvidence.evidence.length >= 6);

  for (const item of dogfoodYardReleaseCandidateEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("blockers and accepted risks are recorded with owner, mitigation, and source evidence", async () => {
  const { dogfoodYardReleaseCandidateEvidence } = await loadContract();

  assert.ok(dogfoodYardReleaseCandidateEvidence.blockers.length >= 2);
  assert.ok(dogfoodYardReleaseCandidateEvidence.acceptedRisks.length >= 2);

  for (const blocker of dogfoodYardReleaseCandidateEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.evidenceSource, `${blocker.id} missing source`);
    assert.ok(blocker.mitigation, `${blocker.id} missing mitigation`);
  }
  for (const risk of dogfoodYardReleaseCandidateEvidence.acceptedRisks) {
    assert.ok(risk.ownerProject, `${risk.id} missing owner`);
    assert.ok(risk.mitigation, `${risk.id} missing mitigation`);
    assert.ok(["unchanged", "increased", "reduced"].includes(risk.launchRiskEffect));
  }
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const { dogfoodYardReleaseCandidateEvidence } = await loadContract();
  const domains = new Set(
    dogfoodYardReleaseCandidateEvidence.releaseCutlineDependencies.map(
      (dependency) => dependency.readinessDomain,
    ),
  );

  assert.ok(domains.has("operations-readiness"));
  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("support"));
  assert.ok(domains.has("reliability"));

  for (const dependency of dogfoodYardReleaseCandidateEvidence.releaseCutlineDependencies) {
    assert.ok(dependency.ownerProject, `${dependency.id} missing owner`);
    assert.ok(dependency.cutlineCategory.startsWith("v1-blocker."), `${dependency.id} missing cutline category`);
    assert.ok(dependency.source, `${dependency.id} missing source`);
  }
});

test("follow-up execution issues are allowed only for missing evidence", async () => {
  const { dogfoodYardReleaseCandidateEvidence, validateDogfoodYardReleaseCandidateEvidence } =
    await loadContract();

  assert.ok(dogfoodYardReleaseCandidateEvidence.followUps.length >= 1);

  const invalid = structuredClone(dogfoodYardReleaseCandidateEvidence);
  invalid.followUps.push({
    id: "speculative-support-polish",
    evidenceId: "release-candidate-scenario-ledger",
    ownerProject: "V1 Launch Support Desk & Escalation",
    reason: "should not create execution work for accepted evidence",
  });

  const result = validateDogfoodYardReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
});

test("parent initiative status update is required only when launch risk changes", async () => {
  const { dogfoodYardReleaseCandidateEvidence, validateDogfoodYardReleaseCandidateEvidence } =
    await loadContract();

  assert.equal(dogfoodYardReleaseCandidateEvidence.initiativeStatus.launchRiskChange, "unchanged");
  assert.equal(dogfoodYardReleaseCandidateEvidence.initiativeStatus.statusUpdateRequired, false);

  const invalid = structuredClone(dogfoodYardReleaseCandidateEvidence);
  invalid.initiativeStatus.launchRiskChange = "increased";
  invalid.initiativeStatus.statusUpdateRequired = true;
  invalid.initiativeStatus.updateSource = "";

  const result = validateDogfoodYardReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guard rejects runtime, live-provider, customer-data, and GA claim creep", async () => {
  const { dogfoodYardReleaseCandidateEvidence, validateDogfoodYardReleaseCandidateEvidence } =
    await loadContract();
  const invalid = structuredClone(dogfoodYardReleaseCandidateEvidence);

  invalid.scopeOut.push("Provision live cloud resources and mark GA readiness from customer data.");
  invalid.operationalClaimGuards.push({
    id: "ga-ready-from-rc-fixture",
    claim: "Hosted Yard is GA-ready.",
    evidenceId: "release-candidate-scenario-ledger",
    disposition: "publish",
  });

  const result = validateDogfoodYardReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /live provider or runtime work is scope-out/);
  assert.match(result.errors.join("\n"), /published operational claims require accepted GA live evidence/);
});
